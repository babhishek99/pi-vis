import fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "./support/invariants.mjs";
import {
  type RealSdkLaunch,
  assertValidSessionJsonl,
  createRealSdkFixture,
  openNewRealSession,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import { createScriptedOpenAIProvider } from "./support/scripted-openai-provider.mjs";

const EXTENSION = join(
  import.meta.dirname,
  "../fixtures/real-sdk-force-restart-extension/force-restart-e2e.ts",
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("hard restart interrupts a cancellation-resistant real tool and kills detached descendants", async () => {
  test.setTimeout(180_000);
  const provider = await createScriptedOpenAIProvider([
    {
      expect: { promptIncludes: "run the hanging restart tool", compaction: false },
      response: {
        type: "tool_call",
        name: "e2e-unkillable-tool",
        argumentChunks: ["{}"],
      },
    },
    {
      expect: { promptIncludes: "continue after the hard restart", compaction: false },
      response: { type: "text", chunks: ["HARD-RESTART-RECOVERED"] },
    },
  ]);
  const fixture = createRealSdkFixture({
    providerBaseUrl: provider.baseUrl,
    extensionFiles: [EXTENSION],
  });
  const hostPath = join(fixture.dirs.workspace, "restart-host.pid");
  const childPath = join(fixture.dirs.workspace, "restart-tool.pid");
  const shellPath = join(fixture.dirs.workspace, "restart-shell.pid");
  let launch: RealSdkLaunch | undefined;
  let childPid: number | undefined;
  let shellPid: number | undefined;
  try {
    launch = await fixture.launch();
    const { window } = launch;
    const textarea = await openNewRealSession(window);
    await selectLocalTestModel(window, textarea);
    await textarea.fill("run the hanging restart tool");
    await textarea.press("Enter");
    await expect.poll(() => fs.existsSync(childPath), { timeout: 30_000 }).toBe(true);
    childPid = Number(fs.readFileSync(childPath, "utf8"));
    const originalHost = Number(fs.readFileSync(hostPath, "utf8"));
    expect(alive(childPid)).toBe(true);

    const restart = window.locator(".sidebar__session--active .sidebar__session-restart");
    const openRestartConfirmation = async (): Promise<void> => {
      await window.locator(".sidebar__session--active").hover();
      await restart.click({ timeout: 10_000 });
    };
    await expect(restart).toBeEnabled();
    await openRestartConfirmation();
    const dialog = window.getByRole("dialog", { name: "Force restart host?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(alive(originalHost)).toBe(true);
    expect(alive(childPid)).toBe(true);

    await openRestartConfirmation();
    const started = Date.now();
    await dialog.getByRole("button", { name: "Force restart", exact: true }).click();
    await expect.poll(() => alive(originalHost), { timeout: 3_000 }).toBe(false);
    await expect.poll(() => alive(childPid!), { timeout: 3_000 }).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect(window.locator(".composer__attach-btn")).toBeEnabled({ timeout: 60_000 });

    // Kill the fresh host externally, then restart through the same user action.
    // The action must remain available throughout automatic recovery/unavailability.
    const replacementHost = Number(fs.readFileSync(hostPath, "utf8"));
    expect(replacementHost).not.toBe(originalHost);
    process.kill(replacementHost, "SIGKILL");
    await openRestartConfirmation();
    await dialog.getByRole("button", { name: "Force restart", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect(window.locator(".composer__attach-btn")).toBeEnabled({ timeout: 60_000 });
    await expect
      .poll(() => Number(fs.readFileSync(hostPath, "utf8")) !== replacementHost)
      .toBe(true);

    if (process.platform !== "win32") {
      await textarea.fill(
        `!/bin/sh -c 'echo $$ > "${shellPath}"; trap "" HUP TERM; while :; do sleep 1; done'`,
      );
      await textarea.press("Enter");
      await expect.poll(() => fs.existsSync(shellPath), { timeout: 30_000 }).toBe(true);
      shellPid = Number(fs.readFileSync(shellPath, "utf8"));
      expect(alive(shellPid)).toBe(true);
      await expect(window.locator(".shell-terminal")).toBeVisible();
      await openRestartConfirmation();
      await dialog.getByRole("button", { name: "Force restart", exact: true }).click();
      await expect.poll(() => alive(shellPid!), { timeout: 3_000 }).toBe(false);
      await expect(dialog).toHaveCount(0, { timeout: 60_000 });
      await expect(window.locator(".composer__attach-btn")).toBeEnabled({ timeout: 60_000 });
      await expect(window.locator(".shell-terminal")).toHaveCount(0);
    }

    await textarea.fill("continue after the hard restart");
    await textarea.press("Enter");
    await expect(window.getByText("HARD-RESTART-RECOVERED", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(textarea).toHaveValue("");
    expect(provider.requests).toHaveLength(2);
    provider.assertExhausted();
    assertValidSessionJsonl(fixture.sessionFiles());
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\n${launch?.output.join("") ?? ""}`,
    );
  } finally {
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    if (shellPid && alive(shellPid)) process.kill(shellPid, "SIGKILL");
    await launch?.close();
    await provider.close();
    fixture.cleanup();
  }
});
