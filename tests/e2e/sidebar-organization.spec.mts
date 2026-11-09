import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "../../src/shared/settings.js";
import {
  type LaunchedElectronApplication,
  launchElectron,
} from "./support/instrumented-launch.mjs";
import { expect, test } from "./support/invariants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = join(HERE, "../../out/main/index.js");
const FAKE_PI = join(HERE, "../fixtures/fake-pi.mjs");
const FAKE_HOST = join(HERE, "../fixtures/fake-session-host.mjs");

test.use({ actionTimeout: 15_000 });

test("discovers children, persists sidebar organization across relaunch, and never rewrites saved history", async () => {
  test.setTimeout(90_000);
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "pivis-sidebar-organization-")));
  const settingsDir = join(root, "user-data");
  const sessionsDir = join(root, "sessions");
  const bucket = join(sessionsDir, "bucket");
  const workspace = join(root, "workspace");
  for (const dir of [settingsDir, bucket, workspace]) fs.mkdirSync(dir, { recursive: true });
  const settingsFile = join(settingsDir, "settings.json");
  const parentFile = join(bucket, "parent.jsonl");
  const childFile = join(bucket, "child.jsonl");
  const forkFile = join(bucket, "fork.jsonl");
  const bytes = new Map<string, string>();
  for (const [file, id, name, parent] of [
    [parentFile, "parent", "Payroll review", undefined],
    [childFile, "child", "Explore#1234abcd", parentFile],
    [forkFile, "fork", "Ordinary fork", parentFile],
  ]) {
    const text = [
      {
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: workspace,
        ...(parent ? { parentSession: parent } : {}),
      },
      {
        type: "message",
        id: `${id}-user`,
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "A saved fixture conversation", timestamp: 1 },
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
    bytes.set(file!, text);
  }
  fs.writeFileSync(
    settingsFile,
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
  const readSettings = (): AppSettings => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
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
    app = await launch();
    const page = await app.firstWindow();
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Payroll review" }),
    ).toBeVisible();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Ordinary fork" }),
    ).toBeVisible();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Explore#1234abcd" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Show sub-agent sessions", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Explore#1234abcd" }),
    ).toBeVisible();

    const row = page.locator(".sidebar__session").filter({ hasText: "Payroll review" });
    await row.hover();
    await row.getByTitle("Pin session", { exact: true }).click();
    // Pinning moves the row; reveal its hover actions at the new position.
    await row.hover();
    await row.getByTitle("Move session to group").click();
    await page
      .getByRole("dialog", { name: "Move session to group" })
      .getByRole("button", { name: "New group", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Research");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    const group = page.getByRole("group", { name: "Research", exact: true });
    await expect(group.locator(".sidebar__session--pinned")).toContainText("Payroll review");
    await group.getByRole("button", { name: "Collapse group Research" }).click();
    await expect.poll(() => readSettings().sessionGroups?.[0]?.collapsed).toBe(true);
    expect(readSettings().sessionGroups[0]?.sessionFiles).toEqual([parentFile]);
    expect(readSettings().pinnedSessions).toEqual([parentFile]);
    await app.close();
    app = undefined;

    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    const restored = reopened.getByRole("group", { name: "Research", exact: true });
    await expect(restored.getByRole("button", { name: "Expand group Research" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(restored.locator(".sidebar__session")).toHaveCount(0);
    await expect(
      reopened.locator(".sidebar__session-name").filter({ hasText: "Explore#1234abcd" }),
    ).toBeVisible();
    await restored.getByRole("button", { name: "Expand group Research" }).click();
    await expect(restored.locator(".sidebar__session--pinned")).toContainText("Payroll review");
    await restored.hover();
    await restored
      .getByRole("button", { name: "Remove group Research (keep sessions)", exact: true })
      .click();
    await expect.poll(() => readSettings().sessionGroups).toEqual([]);
    await expect(reopened.locator(".sidebar__session--pinned")).toContainText("Payroll review");
    expect(readSettings().archivedSessions).toEqual([]);
    for (const [file, text] of bytes) expect(fs.readFileSync(file, "utf8")).toBe(text);
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
