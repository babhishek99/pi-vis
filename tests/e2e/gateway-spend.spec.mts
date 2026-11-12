import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gatewaySpendDataDirectory,
  loadGatewaySpendConfig,
} from "../../src/main/gateway-spend/config.js";
import type { SessionId } from "../../src/shared/ids.js";
import {
  type LaunchedElectronApplication,
  launchElectron,
} from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = join(HERE, "../../out/main/index.js");
const FAKE_PI = join(HERE, "../fixtures/fake-pi.mjs");
const FAKE_HOST = join(HERE, "../fixtures/fake-session-host.mjs");

test("reads personal gateway costs over real IPC, caches across restart, and never edits conversation bytes", async () => {
  test.skip(
    process.platform === "win32",
    "The private CLI fixture uses a POSIX executable shebang",
  );
  test.setTimeout(120_000);
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-gateway-spend-")));
  const settingsDir = join(root, "profile");
  const sessionsDir = join(root, "sessions");
  const bucket = join(sessionsDir, "bucket");
  const workspace = join(root, "workspace");
  const calls = join(root, "cli-calls.jsonl");
  const pup = join(root, "read-only-pup.mjs");
  for (const dir of [settingsDir, bucket, workspace]) fs.mkdirSync(dir, { recursive: true });
  const config = {
    version: 1,
    pupExecutable: pup,
    auditQuery: 'service:fixture env:test "audit trail message"',
    userEmail: "person@example.test",
    gateways: [{ provider: "fixture-gateway", baseUrl: "https://gateway.example.test/v1" }],
  };
  fs.writeFileSync(join(settingsDir, "gateway-spend.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  fs.writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      piBinaryPath: FAKE_PI,
      workspaceOrder: [workspace],
      expandedWorkspaces: [workspace],
      lastActiveWorkspace: workspace,
      sessionSearchEnabled: false,
      appUpdateCheckEnabled: false,
      extensionUpdateCheckEnabled: false,
    }),
  );
  fs.writeFileSync(
    pup,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (!args.includes("--read-only") || !args.includes("--no-agent") || !args.includes("logs") || !args.includes("aggregate")) process.exit(99);
const query = args.find(value => value.startsWith("--query=")) || "";
if (!query.includes('@key_type:personal @user_email:"person@example.test"')) process.exit(98);
const session = query.includes("@custom_tags.pivis_session:");
const unpriced = query.endsWith(" -@cost:*");
const computes = unpriced ? { c0: 0 } : { c0: session ? 2 : 42, c1: session ? 0.123456 : 12.345678 };
process.stderr.write("private CLI diagnostic must never enter renderer billing IPC\\n");
process.stdout.write(JSON.stringify({ data: { buckets: [{ by: {}, computes }] }, meta: { status: "done" } }));
`,
    { mode: 0o700 },
  );
  const originals = new Map<string, string>();
  const trackedId = "11111111-2222-4333-8444-555555555555";
  const trackedFile = join(bucket, "tracked.jsonl");
  const oldFile = join(bucket, "old.jsonl");
  for (const [file, id, name] of [
    [trackedFile, trackedId, "Tracked gateway work"],
    [oldFile, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Historical work"],
  ]) {
    const text = [
      { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace },
      {
        type: "message",
        id: `${id}-user`,
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Saved fixture", timestamp: 1 },
      },
      {
        type: "session_info",
        id: `${id}-name`,
        parentId: `${id}-user`,
        timestamp: "2026-01-01T00:00:02.000Z",
        name,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .concat("")
      .join("\n");
    fs.writeFileSync(file!, text);
    originals.set(file!, text);
  }
  const loaded = await loadGatewaySpendConfig(settingsDir);
  if (loaded.state !== "configured")
    throw new Error("Expected valid private fixture configuration");
  const dataDirectory = gatewaySpendDataDirectory(settingsDir, loaded.fingerprint);
  const trackingDirectory = join(dataDirectory, "tracking");
  const tag = createHash("sha256").update(trackedId).digest("hex");
  fs.mkdirSync(trackingDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    join(trackingDirectory, `${tag}.json`),
    JSON.stringify({
      version: 1,
      sessionTag: tag,
      trackedSince: new Date(Date.now() - 3_600_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const readCalls = (): string[][] =>
    fs.existsSync(calls)
      ? fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const launch = () =>
    launchElectron({
      args: [APP_ENTRY],
      env: {
        ...process.env,
        PIVIS_SETTINGS_DIR: settingsDir,
        PIVIS_SESSIONS_DIR: sessionsDir,
        FAKE_PI_SESSIONS_DIR: sessionsDir,
        PIVIS_TEST_HOST_SCRIPT: FAKE_HOST,
        ELECTRON_RENDERER_URL: undefined,
      },
    });
  let app: LaunchedElectronApplication | undefined;
  try {
    const launchStartedAt = Date.now();
    app = await launch();
    const page = await app.firstWindow();
    const monthButton = page.getByRole("button", {
      name: "Current month gateway spend",
      exact: true,
    });
    await expect(monthButton).toContainText("$12.35", { timeout: 20_000 });
    await monthButton.click();
    const monthlyDetails = page.getByRole("region", { name: "Monthly gateway spend details" });
    await expect(monthlyDetails).toContainText(
      "Current month-to-date · Personal legacy gateway · all harnesses",
    );
    await expect(monthlyDetails).toContainText("UTC");
    await expect(monthlyDetails).toContainText("Datadog gateway audit logs");
    const month = await page.evaluate(() => window.pivis.invoke("gatewaySpend.month", {}));
    expect(month.snapshot).toMatchObject({
      amountUsd: 12.345678,
      pricedRequests: 42,
      unpricedRequests: 0,
    });
    if (!month.period || !month.snapshot) throw new Error("Missing MTD fixture snapshot");
    const coveredUntil = new Date(month.period.endExclusive);
    expect(coveredUntil.getTime()).toBeGreaterThanOrEqual(launchStartedAt);
    expect(coveredUntil.getTime()).toBeLessThanOrEqual(Date.now());
    expect(month.period).toEqual({
      start: new Date(
        Date.UTC(coveredUntil.getUTCFullYear(), coveredUntil.getUTCMonth(), 1),
      ).toISOString(),
      endExclusive: month.snapshot.asOf,
      timeZone: "UTC",
    });
    expect(
      await monthlyDetails
        .locator("time")
        .evaluateAll((times) => times.map((time) => time.getAttribute("datetime"))),
    ).toEqual(expect.arrayContaining([month.period.start, month.period.endExclusive]));
    expect(readCalls()).toHaveLength(2);
    for (const args of readCalls()) {
      expect(args).toContain(`--from=${month.period.start}`);
      expect(args).toContain(`--to=${new Date(coveredUntil.getTime() - 1).toISOString()}`);
    }
    await page.keyboard.press("Escape");

    const session = await page.evaluate(
      async ({ workspace, trackedFile }) => {
        const opened = await window.pivis.invoke("session.open", {
          workspacePath: workspace,
          sessionFile: trackedFile,
        });
        if (opened.outcome === "missing") throw new Error("Fixture session disappeared");
        return {
          sessionId: opened.sessionId,
          spend: await window.pivis.invoke("gatewaySpend.session", { sessionId: opened.sessionId }),
        };
      },
      { workspace, trackedFile },
    );
    expect(session.spend).toMatchObject({
      state: "ready",
      scope: "direct_session_partial",
      snapshot: { amountUsd: 0.123456, pricedRequests: 2 },
      trackedSince: expect.any(String),
    });
    await page
      .locator(".sidebar__session-name")
      .filter({ hasText: "Tracked gateway work" })
      .click();
    await page.getByRole("button", { name: /context used|Context usage/ }).click();
    const direct = page.getByRole("region", { name: "Direct session gateway spend" });
    await expect(direct).toContainText("$0.12");
    await expect(direct).toContainText("Partial");
    await expect(direct).toContainText("Tracked since");
    await page.keyboard.press("Escape");
    const old = await page.evaluate(
      async ({ workspace, oldFile }) => {
        const opened = await window.pivis.invoke("session.open", {
          workspacePath: workspace,
          sessionFile: oldFile,
        });
        if (opened.outcome === "missing") throw new Error("Fixture session disappeared");
        return window.pivis.invoke("gatewaySpend.session", { sessionId: opened.sessionId });
      },
      { workspace, oldFile },
    );
    expect(old).toMatchObject({ state: "not_tracked", snapshot: null });
    const unavailable = await page.evaluate(
      (sessionId) =>
        window.pivis.invoke("gatewaySpend.session", { sessionId: sessionId as SessionId }),
      "not-a-registered-session",
    );
    expect(unavailable).toMatchObject({
      state: "unavailable",
      snapshot: null,
      issue: "session_unavailable",
    });
    await page.evaluate(
      (sessionId) => window.pivis.invoke("gatewaySpend.session", { sessionId, refresh: true }),
      session.sessionId,
    );
    expect(readCalls()).toHaveLength(4);
    const serialized = JSON.stringify([month, session.spend, old, unavailable]);
    for (const privateValue of [
      root,
      config.userEmail,
      config.auditQuery,
      config.gateways[0]!.baseUrl,
      "private CLI diagnostic",
    ])
      expect(serialized).not.toContain(privateValue);
    expect(
      readCalls().filter((args) =>
        args.some((arg) => arg.includes(`@custom_tags.pivis_session:${tag}`)),
      ),
    ).toHaveLength(2);
    expect(fs.statSync(join(dataDirectory, "cache.json")).mode & 0o777).toBe(0o600);
    await app.close();
    app = undefined;

    app = await launch();
    const reopened = await app.firstWindow();
    await expect(
      reopened.getByRole("button", { name: "Current month gateway spend", exact: true }),
    ).toContainText("$12.35", { timeout: 20_000 });
    const cached = await reopened.evaluate(() => window.pivis.invoke("gatewaySpend.month", {}));
    expect(cached.snapshot).toEqual(month.snapshot);
    expect(cached.period).toEqual(month.period);
    await reopened
      .getByRole("button", { name: "Current month gateway spend", exact: true })
      .click();
    const cachedDetails = reopened.getByRole("region", { name: "Monthly gateway spend details" });
    await expect(cachedDetails).toContainText("Current month-to-date");
    expect(
      await cachedDetails
        .locator("time")
        .evaluateAll((times) => times.map((time) => time.getAttribute("datetime"))),
    ).toEqual(expect.arrayContaining([month.period.start, month.period.endExclusive]));
    expect(readCalls()).toHaveLength(4);
    for (const [file, text] of originals) expect(fs.readFileSync(file, "utf8")).toBe(text);
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
