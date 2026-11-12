import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { PivisAPI } from "../../src/preload/index.js";
import type {
  IntentEnvelope,
  RendererPublication,
} from "../../src/shared/pi-protocol/runtime-state.js";
import type { AppSettings } from "../../src/shared/settings.js";
import { expect, test } from "./support/invariants.mjs";
import {
  type RealSdkLaunch,
  assertValidSessionJsonl,
  createRealSdkFixture,
  parseSessionEntries,
} from "./support/real-sdk-host.mjs";

const ORIGINAL_NAME = "Launch planning";
const RENAMED_NAME = "Launch review";
const USER_TEXT = "Prepare the saved launch checklist.";
const ASSISTANT_TEXT = "Synthetic launch checklist complete; no provider turn is needed.";

type RenameEvidence = {
  frames: Array<Extract<RendererPublication, { plane: "semantic" }>>;
  deliveredEscapes: number;
};
type ObservedWindow = { pivis: PivisAPI; __sidebarRenameEvidence: RenameEvidence };
type IpcEntry = { channel: string; payload: unknown };

function seedSavedSession(
  file: string,
  workspace: string,
  uuid: string,
  name: string,
  timestamp: number,
): Buffer {
  const entries = [
    {
      type: "session",
      version: 3,
      id: uuid,
      timestamp: new Date(timestamp).toISOString(),
      cwd: workspace,
    },
    {
      type: "message",
      id: "11111111",
      parentId: null,
      timestamp: new Date(timestamp + 1_000).toISOString(),
      message: { role: "user", content: USER_TEXT, timestamp: timestamp + 1_000 },
    },
    {
      type: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp: new Date(timestamp + 2_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: ASSISTANT_TEXT }],
        api: "anthropic-messages",
        provider: "pivis-test",
        model: "pivis-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: timestamp + 2_000,
      },
    },
    {
      type: "session_info",
      id: "33333333",
      parentId: "22222222",
      timestamp: new Date(timestamp + 3_000).toISOString(),
      name,
    },
  ];
  const bytes = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  fs.writeFileSync(file, bytes);
  return bytes;
}

function readIpcLog(file: string): IpcEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IpcEntry);
}

function dispatchedIntents(file: string): IntentEnvelope[] {
  return readIpcLog(file)
    .filter((entry) => entry.channel === "session.dispatchIntent")
    .map((entry) => entry.payload as IntentEnvelope);
}

async function observeRenameJourney(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observed = window as unknown as ObservedWindow;
    const evidence: RenameEvidence = { frames: [], deliveredEscapes: 0 };
    observed.__sidebarRenameEvidence = evidence;
    observed.pivis.on("session.publication", (publication) => {
      if (publication.plane === "semantic") evidence.frames.push(publication);
    });
    // Passive evidence only: unclaimed global Escape is consumed at window
    // capture before it can reach document or the native rename input.
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          event.target instanceof HTMLInputElement &&
          event.target.getAttribute("aria-label") === "Session name"
        ) {
          evidence.deliveredEscapes++;
        }
      },
      true,
    );
  });
}

async function expectSelectedName(row: Locator, name: string): Promise<Locator> {
  const input = row.getByRole("textbox", { name: "Session name", exact: true });
  await expect(input).toHaveValue(name);
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    }),
  ).toEqual([0, name.length]);
  return input;
}

test.use({ actionTimeout: 15_000 });

test("renames a cold pinned saved session through real Pi and restores its organization on relaunch", async () => {
  test.setTimeout(120_000);
  const ipcLog = join(tmpdir(), `pivis-sidebar-rename-${randomUUID()}.jsonl`);
  // No provider, extensions, model selection, prompt, or paid-smoke opt-in.
  // Use the exact local Pi pin, or an explicitly supplied verified package;
  // either route isolates HOME and all state from both installed apps.
  const executablePath = process.env["PIVIS_PACKAGED_EXECUTABLE"];
  const fixture = createRealSdkFixture({
    ipcInvocationLog: ipcLog,
    ...(executablePath ? { executablePath, packagedHostExecPath: process.execPath } : {}),
  });
  let launch: RealSdkLaunch | undefined;
  try {
    fs.writeFileSync(ipcLog, "");
    const workspace = fixture.dirs.workspace;
    const otherWorkspace = join(fixture.dirs.root, "other-workspace");
    fs.mkdirSync(otherWorkspace);
    const uuid = randomUUID();
    const unrelatedUuid = randomUUID();
    const file = join(fixture.dirs.piSessions, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`);
    const unrelatedFile = join(
      fixture.dirs.piSessions,
      `2026-01-02T00-00-00-000Z_${unrelatedUuid}.jsonl`,
    );
    const originalBytes = seedSavedSession(
      file,
      workspace,
      uuid,
      ORIGINAL_NAME,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    const unrelatedBytes = seedSavedSession(
      unrelatedFile,
      workspace,
      unrelatedUuid,
      "Unrelated saved notes",
      Date.parse("2026-01-02T00:00:00.000Z"),
    );
    const savedFiles = fixture.sessionFiles();
    const settingsFile = join(fixture.dirs.settings, "settings.json");
    const readSettings = (): AppSettings => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const organization = {
      workspaceOrder: [otherWorkspace, workspace],
      expandedWorkspaces: [otherWorkspace, workspace],
      pinnedSessions: [file, unrelatedFile],
      sessionGroups: [
        {
          id: "research",
          workspacePath: workspace,
          name: "Research",
          // Deliberately different from pin order and user-activity order.
          sessionFiles: [unrelatedFile, file],
          collapsed: false,
        },
        {
          id: "later",
          workspacePath: workspace,
          name: "Later",
          sessionFiles: [],
          collapsed: true,
        },
      ],
      archivedSessions: [],
    };
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        ...readSettings(),
        ...organization,
        lastActiveWorkspace: otherWorkspace,
        sessionSearchEnabled: false,
        appUpdateCheckEnabled: false,
        extensionUpdateCheckEnabled: false,
      }),
    );

    const research = (page: Page): Locator =>
      page.getByRole("group", { name: "Research", exact: true });
    const savedRow = (page: Page): Locator =>
      research(page).locator(`.sidebar__session[data-session-file=${JSON.stringify(file)}]`);
    const expectOrganization = async (page: Page): Promise<void> => {
      expect(readSettings()).toMatchObject(organization);
      await expect(page.locator(".sidebar__workspace-name")).toHaveText([
        basename(otherWorkspace),
        basename(workspace),
      ]);
      const groups = page.locator('.sidebar__session-group[role="group"]');
      await expect(groups).toHaveCount(3);
      expect(
        await groups.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))),
      ).toEqual(["Research", "Later", "Ungrouped"]);
      await expect(research(page).locator(".sidebar__session--pinned")).toHaveCount(2);
      expect(
        await research(page)
          .locator(".sidebar__session")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-file"))),
      ).toEqual([file, unrelatedFile]);
    };
    const expectPersistence = (): Buffer => {
      assertValidSessionJsonl(savedFiles);
      const bytes = fs.readFileSync(file);
      expect(bytes.subarray(0, originalBytes.length)).toEqual(originalBytes);
      const entries = parseSessionEntries(file);
      expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
      expect(entries[0]?.id).toBe(uuid);
      expect(
        entries.filter((entry) => entry.type === "session_info").map((entry) => entry.name),
      ).toEqual([ORIGINAL_NAME, RENAMED_NAME]);
      expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
      expect(fs.readFileSync(unrelatedFile)).toEqual(unrelatedBytes);
      expect(fixture.sessionFiles()).toEqual(savedFiles);
      expect(readSettings()).toMatchObject(organization);
      return bytes;
    };

    launch = await fixture.launch();
    const page = launch.window;
    await expectOrganization(page);
    const row = savedRow(page);
    await expect(row).toHaveCount(1);
    await expect(row.locator(".sidebar__session-name")).toHaveText(ORIGINAL_NAME);
    await expect(row.locator('.status-dot--cold[title="Not running"]')).toHaveCount(1);
    await expect(row).not.toHaveClass(/sidebar__session--active/);
    const storedNode = await row.elementHandle();
    await observeRenameJourney(page);

    // Native double-click includes the normal first-click open/activation;
    // never dispatch a synthetic dblclick or warm the saved session first.
    await row.locator(".sidebar__session-name").dblclick();
    let input = await expectSelectedName(row, ORIGINAL_NAME);
    await expect(row).toHaveAttribute("draggable", "false");
    await expect(row.locator("button:visible")).toHaveCount(0);
    // Unlike the textarea, this control requires following semantic authority.
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 30_000 });
    await expect(row).toHaveClass(/sidebar__session--active/);
    expect(await storedNode!.evaluate((node) => node.isConnected)).toBe(true);
    await storedNode?.dispose();
    input = await expectSelectedName(row, ORIGINAL_NAME);
    await expect(page.getByText(ASSISTANT_TEXT, { exact: true })).toBeVisible();
    const beforeEscape = fs.readFileSync(file);
    expect(dispatchedIntents(ipcLog)).toEqual([]);
    await input.fill("Discard this rename");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(row.locator(".sidebar__session-name")).toHaveText(ORIGINAL_NAME);
    await expect(page.locator(".session-header__name-btn")).toHaveText(ORIGINAL_NAME);
    expect(
      await page.evaluate(
        () => (window as unknown as ObservedWindow).__sidebarRenameEvidence.deliveredEscapes,
      ),
    ).toBe(1);
    expect(dispatchedIntents(ipcLog)).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(beforeEscape);

    await row.locator(".sidebar__session-name").dblclick();
    input = await expectSelectedName(row, ORIGINAL_NAME);
    await input.fill("  Launch review  ");
    await input.press("Enter");
    await expect.poll(() => dispatchedIntents(ipcLog).length).toBe(1);
    const envelope = dispatchedIntents(ipcLog)[0]!;
    expect(envelope.intent).toEqual({ kind: "rename", name: RENAMED_NAME });
    expect(envelope.observedCursor).toMatchObject(envelope.expectedOwner);
    expect(envelope.observedCursor?.transportSequence).toBeGreaterThan(0);
    expect(envelope.observedCursor?.snapshotSequence).toBeGreaterThan(0);
    // A receipt or optimistic label is not success: require the real child's
    // matching terminal outcome and canonical name in one same-owner frame.
    await expect
      .poll(
        () =>
          page.evaluate((request) => {
            const evidence = (window as unknown as ObservedWindow).__sidebarRenameEvidence;
            for (const frame of evidence.frames) {
              if (
                frame.sessionId !== request.sessionId ||
                frame.owner.hostInstanceId !== request.expectedOwner.hostInstanceId ||
                frame.owner.sessionEpoch !== request.expectedOwner.sessionEpoch
              ) {
                continue;
              }
              const snapshot = frame.payload.terminalSnapshot;
              const outcome = snapshot.recentIntentOutcomes.find(
                (item) => item.intentId === request.intentId && item.kind === "rename",
              );
              if (outcome) {
                return { owner: outcome.owner, state: outcome.state, name: snapshot.sessionName };
              }
            }
            return null;
          }, envelope),
        { timeout: 30_000 },
      )
      .toEqual({ owner: envelope.expectedOwner, state: "completed", name: RENAMED_NAME });
    await expect(input).toHaveCount(0);
    await expect(row.locator(".sidebar__session-name")).toHaveText(RENAMED_NAME);
    await expect(page.locator(".session-header__name-btn")).toHaveText(RENAMED_NAME);
    await expect(row).toHaveAttribute("draggable", "true");
    await expect(page.locator(".working-row")).toHaveCount(0);
    expectPersistence();
    await expectOrganization(page);
    await launch.close();
    launch = undefined;
    const renamedBytes = expectPersistence();

    launch = await fixture.launch();
    const reopened = launch.window;
    await expectOrganization(reopened);
    const restoredRow = savedRow(reopened);
    await expect(restoredRow.locator(".sidebar__session-name")).toHaveText(RENAMED_NAME);
    await expect(restoredRow.locator('.status-dot--cold[title="Not running"]')).toHaveCount(1);
    await expect(restoredRow).toHaveClass(/sidebar__session--pinned/);
    // F2 must work from DOM focus alone, including another stored→live open.
    await restoredRow.focus();
    await restoredRow.press("F2");
    const restoredInput = await expectSelectedName(restoredRow, RENAMED_NAME);
    await expect(reopened.locator(".composer__attach-btn")).toBeEnabled({ timeout: 30_000 });
    await restoredInput.press("Enter");
    await expect(restoredInput).toHaveCount(0);
    await expect(restoredRow.locator(".sidebar__session-name")).toHaveText(RENAMED_NAME);
    await expect(reopened.locator(".session-header__name-btn")).toHaveText(RENAMED_NAME);
    await expectOrganization(reopened);
    await launch.close();
    launch = undefined;
    expect(expectPersistence()).toEqual(renamedBytes);
    expect(dispatchedIntents(ipcLog)).toEqual([envelope]);
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nIPC invocations:\n${JSON.stringify(readIpcLog(ipcLog), null, 2)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}`,
      { cause: error },
    );
  } finally {
    try {
      await launch?.close();
    } finally {
      fixture.cleanup();
      fs.rmSync(ipcLog, { force: true });
    }
  }
});
