import { type Page, expect, test } from "@playwright/test";
import type { useSessionsStore } from "../../src/renderer/src/stores/sessions-store.js";
import type { IntentEnvelope } from "../../src/shared/pi-protocol/runtime-state.js";

const SAVED_FILE = "/preview/planning.jsonl";
const DEMO_FILE = "/preview/demo-conversation.jsonl";
const savedRow = (page: Page) =>
  page.locator(`.sidebar__session[data-session-file="${SAVED_FILE}"]`);

type RenameFixtures = {
  requests: IntentEnvelope[];
  holdAuthority: boolean;
  holdRename: boolean;
  holdGroupSave: boolean;
  rejectGroupSave?: () => void;
  refuseNext: boolean;
  pendingAuthority: Array<() => void>;
  pendingRename: Array<() => void>;
};

type PreviewWindow = {
  __pivisStore: typeof useSessionsStore;
  __pivisPreview: { abortCalls: number; startStreaming(): void; escapeClaimCount(): number };
  __renameFixtures: RenameFixtures;
};

/** Test-only delays around the real browser preview bridge; no SDK or filesystem. */
async function intercept(
  page: Page,
  options: {
    holdAuthority?: boolean;
    holdRename?: boolean;
    holdGroupSave?: boolean;
    refuseNext?: boolean;
  } = {},
): Promise<void> {
  await page.evaluate((options) => {
    const preview = window as unknown as PreviewWindow;
    const initialSessionId = preview.__pivisStore.getState().activeSessionId;
    const controls: RenameFixtures = {
      requests: [],
      holdAuthority: options.holdAuthority ?? false,
      holdRename: options.holdRename ?? false,
      holdGroupSave: options.holdGroupSave ?? false,
      refuseNext: options.refuseNext ?? false,
      pendingAuthority: [],
      pendingRename: [],
    };
    preview.__renameFixtures = controls;
    const invoke = Reflect.get(window.pivis, "invoke") as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(window.pivis, "invoke", (...args: unknown[]) => {
      if (
        args[0] === "settings.set" &&
        controls.holdGroupSave &&
        (args[1] as { sessionGroups?: unknown } | undefined)?.sessionGroups !== undefined
      ) {
        controls.holdGroupSave = false;
        return new Promise((_resolve, reject) => {
          controls.rejectGroupSave = () => reject(new Error("Synthetic group write failure"));
        });
      }
      if (
        args[0] === "session.authorityAttach" &&
        controls.holdAuthority &&
        (args[1] as { sessionId: string }).sessionId !== initialSessionId
      ) {
        return new Promise((resolve, reject) => {
          controls.pendingAuthority.push(() => {
            void invoke.apply(window.pivis, args).then(resolve, reject);
          });
        });
      }
      if (
        args[0] === "session.dispatchIntent" &&
        (args[1] as IntentEnvelope).intent.kind === "rename"
      ) {
        const envelope = args[1] as IntentEnvelope;
        controls.requests.push(envelope);
        if (controls.refuseNext) {
          controls.refuseNext = false;
          return Promise.resolve({
            status: "not_admitted",
            reason: "stale_owner",
            intentId: envelope.intentId,
          });
        }
        if (controls.holdRename) {
          return new Promise((resolve, reject) => {
            controls.pendingRename.push(() => {
              void invoke.apply(window.pivis, args).then(resolve, reject);
            });
          });
        }
      }
      return invoke.apply(window.pivis, args);
    });
  }, options);
}

async function release(page: Page, plane: "authority" | "rename" | "group"): Promise<void> {
  await page.evaluate((plane) => {
    const controls = (window as unknown as PreviewWindow).__renameFixtures;
    if (plane === "authority") {
      controls.holdAuthority = false;
      for (const complete of controls.pendingAuthority.splice(0)) complete();
    } else if (plane === "group") {
      const reject = controls.rejectGroupSave;
      delete controls.rejectGroupSave;
      if (!reject) throw new Error("No group write is waiting");
      reject();
    } else {
      controls.holdRename = false;
      for (const complete of controls.pendingRename.splice(0)) complete();
    }
  }, plane);
}

async function requests(page: Page): Promise<IntentEnvelope[]> {
  return page.evaluate(() => (window as unknown as PreviewWindow).__renameFixtures.requests);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?sidebarDemo=1");
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
  await expect(savedRow(page).locator(".sidebar__session-name")).toHaveText("Project planning");
});

test("native double-click survives saved-row activation and waits for authority before saving", async ({
  page,
}) => {
  await intercept(page, { holdAuthority: true });
  const row = savedRow(page);
  await row.locator(".sidebar__session-name").dblclick();
  const input = row.getByRole("textbox", { name: "Session name", exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Project planning");
  expect(
    await input.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, "Project planning".length]);
  await input.fill("  Launch review  ");
  await input.press("Enter");
  await expect(row.getByRole("status")).toHaveText("Waiting for session…");
  expect(await requests(page)).toHaveLength(0);
  await release(page, "authority");
  await expect(input).toHaveCount(0);
  await expect(row.locator(".sidebar__session-name")).toHaveText("Launch review");
  await expect(row).toBeFocused();
  expect((await requests(page)).map((request) => request.intent)).toEqual([
    { kind: "rename", name: "Launch review" },
  ]);
  await expect(row).toHaveAttribute("draggable", "true");
});

test("Escape cancels only the inline name edit while an agent is working", async ({ page }) => {
  const row = page.locator(`.sidebar__session[data-session-file="${DEMO_FILE}"]`);
  await row.locator(".sidebar__session-name").click();
  await expect(page.locator(".composer__attach-btn")).toBeEnabled();
  const aborts = await page.evaluate(() => {
    const hooks = (window as unknown as PreviewWindow).__pivisPreview;
    hooks.startStreaming();
    return hooks.abortCalls;
  });
  await expect(row.getByTitle("Working", { exact: true })).toBeVisible();
  await row.focus();
  await row.press("F2");
  const input = row.getByRole("textbox", { name: "Session name", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Not a new session name");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(row.locator(".sidebar__session-name")).toHaveText("Demo conversation");
  await expect(row.getByTitle("Working", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
  ).toBe(aborts);
  expect(
    await page.evaluate(() =>
      (window as unknown as PreviewWindow).__pivisPreview.escapeClaimCount(),
    ),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls))
    .toBe(aborts + 1);
});

test("a delayed group rollback and rename keep their original session without stealing focus", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
  const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
  await dialog.getByLabel("Group name").fill("Research");
  await dialog.getByRole("button", { name: "Create group", exact: true }).click();
  const group = page.getByRole("group", { name: "Research", exact: true });
  await intercept(page, { holdRename: true, holdGroupSave: true });
  const row = savedRow(page);
  await row.dragTo(group.locator(".sidebar__group-header"));
  await expect(group.locator(".sidebar__session-name")).toHaveText("Project planning");
  await row.locator(".sidebar__session-name").dblclick();
  await expect(page.locator(".composer__attach-btn")).toBeEnabled();
  // The generic browser history loader returns []; this fixture is a real
  // saved conversation, not an empty placeholder eligible for normal reaping.
  await page.evaluate((file) => {
    const state = (window as unknown as PreviewWindow).__pivisStore.getState();
    const session = [...state.sessions.values()].find((session) => session.sessionFile === file)!;
    state.seedHistory(session.sessionId, [
      {
        id: "rename-fixture-user",
        type: "user",
        data: { content: "A saved planning conversation" },
      },
    ]);
  }, SAVED_FILE);
  const input = row.getByRole("textbox", { name: "Session name", exact: true });
  await input.fill("Background title");
  await input.press("Enter");
  await expect(row.getByRole("status")).toHaveText("Renaming…");
  await input.press("Enter");
  const other = page.locator(`.sidebar__session[data-session-file="${DEMO_FILE}"]`);
  await other.locator(".sidebar__session-name").click();
  const composer = page.getByRole("textbox", { name: "Message pi", exact: true });
  await expect(composer).toBeFocused();
  // The older failed move reparents this editor into Ungrouped. Its temporary
  // replacement must not refocus before the detached edit is retired.
  await release(page, "group");
  await expect(group.locator(".sidebar__session")).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(composer).toBeFocused();
  await release(page, "rename");
  await expect(row.locator(".sidebar__session-name")).toHaveText("Background title");
  await expect(other.locator(".sidebar__session-name")).toHaveText("Demo conversation");
  await expect(other).toHaveClass(/sidebar__session--active/);
  await expect(composer).toBeFocused();
  expect(await requests(page)).toHaveLength(1);
});

test("a refused rename preserves the text and supports an explicit retry", async ({ page }) => {
  await intercept(page, { refuseNext: true });
  const row = savedRow(page);
  await row.locator(".sidebar__session-name").dblclick();
  await expect(page.locator(".composer__attach-btn")).toBeEnabled();
  const input = row.getByRole("textbox", { name: "Session name", exact: true });
  await input.fill("Retry this title");
  await input.press("Enter");
  await expect(row.getByRole("alert")).toContainText("wasn't accepted");
  await expect(input).toHaveValue("Retry this title");
  await expect(input).toBeEditable();
  await page.getByRole("button", { name: "New session", exact: true }).focus();
  expect(await requests(page)).toHaveLength(1);
  await expect(input).toBeVisible();
  await input.focus();
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(row.locator(".sidebar__session-name")).toHaveText("Retry this title");
  const calls = await requests(page);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.intentId).not.toBe(calls[1]?.intentId);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`inline rename and its error fit the minimum window in ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 640 });
    await page.emulateMedia({ colorScheme });
    await page.evaluate(() => document.fonts.ready);
    const row = savedRow(page);
    await row.locator(".sidebar__session-name").dblclick();
    const input = row.getByRole("textbox", { name: "Session name", exact: true });
    const longName = "Design review and launch checklist ".repeat(6);
    await input.fill(longName);
    await expect(input).toHaveValue(longName);
    await expect(row).toHaveAttribute("draggable", "false");
    await expect(row.getByTitle("Archive session", { exact: true })).toBeHidden();
    await expect
      .poll(() =>
        input.evaluate((element) => {
          const row = element.closest(".sidebar__session")!;
          const sidebar = element.closest(".sidebar")!;
          const rect = element.getBoundingClientRect();
          const outer = sidebar.getBoundingClientRect();
          return {
            fits: rect.width > 30 && rect.left >= outer.left && rect.right <= outer.right,
            noOverflow: sidebar.scrollWidth <= sidebar.clientWidth,
            sameFont: getComputedStyle(element).fontFamily === getComputedStyle(row).fontFamily,
          };
        }),
      )
      .toEqual({ fits: true, noOverflow: true, sameFont: true });
    await input.fill("   ");
    await input.press("Enter");
    await expect(row.getByRole("alert")).toHaveText("Enter a session name.");
    expect(
      await page
        .locator(".sidebar")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page
      .locator(".sidebar")
      .screenshot({ path: test.info().outputPath(`sidebar-rename-${colorScheme}.png`) });
    await input.press("Escape");
    await expect(row.locator(".sidebar__session-name")).toHaveText("Project planning");
  });
}
