import { expect, test } from "@playwright/test";
import type { useSessionsStore } from "../../src/renderer/src/stores/sessions-store.js";
import type { SessionSummary } from "../../src/shared/ipc-contract.js";

const WORKSPACE = "/Users/demo/src/pi-vis";
const WORK_FILE = "/preview/review.jsonl";
const CHILD_NAME = "Explore#1234abcd";

type PreviewWindow = {
  __pivisStore: typeof useSessionsStore;
  __pivisPreview: { abortCalls: number; startStreaming(): void; escapeClaimCount(): number };
};

async function seed(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(
    ({ workspace, file, child }) => {
      const store = (window as unknown as PreviewWindow).__pivisStore.getState();
      store.setExpandedWorkspaces([workspace]);
      const base = { cwd: workspace, preview: "Saved session", mtime: 1, messageCount: 1 };
      const summaries: SessionSummary[] = [
        { ...base, id: "review", filePath: file, name: "Payroll review" },
        {
          ...base,
          id: "fork",
          filePath: "/preview/fork.jsonl",
          name: "Ordinary fork",
          parentSession: file,
        },
        {
          ...base,
          id: "child",
          filePath: "/preview/child.jsonl",
          name: child,
          parentSession: file,
          isSubagent: true,
        },
      ];
      store.setWorkspaceSessions(workspace, summaries);
    },
    { workspace: WORKSPACE, file: WORK_FILE, child: CHILD_NAME },
  );
}

async function holdFailingGroupSave(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const originalInvoke = Reflect.get(window.pivis, "invoke") as (
      ...args: unknown[]
    ) => Promise<unknown>;
    Reflect.set(window.pivis, "invoke", (...args: unknown[]) => {
      const updates = args[1] as { sessionGroups?: unknown } | undefined;
      if (args[0] === "settings.set" && updates?.sessionGroups !== undefined) {
        return new Promise((_resolve, reject) => {
          Reflect.set(window, "__failGroupSave", () => {
            Reflect.set(window.pivis, "invoke", originalInvoke);
            reject(new Error("fixture settings write failure"));
          });
        });
      }
      return originalInvoke.apply(window.pivis, args);
    });
  });
}

async function rejectGroupSave(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => (Reflect.get(window, "__failGroupSave") as () => void)());
}

test.describe("sidebar organization", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    await seed(page);
  });

  test("the manual sidebar demo URL provides synthetic sessions for a safe test drive", async ({
    page,
  }) => {
    await page.goto("/?sidebarDemo=1");
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    const planning = page.locator(".sidebar__session").filter({ hasText: "Project planning" });
    await expect(planning).toBeVisible();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Ordinary fork" }),
    ).toBeVisible();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: CHILD_NAME }),
    ).toHaveCount(0);
    await planning.hover();
    await planning.getByTitle("Move session to group").click();
    await page
      .getByRole("dialog", { name: "Move session to group" })
      .getByRole("button", { name: "New group", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Test drive");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(
      page
        .getByRole("group", { name: "Test drive", exact: true })
        .locator(".sidebar__session-name"),
    ).toHaveText("Project planning");
  });

  test("drags a demo session from Ungrouped into an existing group, across collapsed groups, and back", async ({
    page,
  }) => {
    await page.goto("/?sidebarDemo=1");
    await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
    const active = await page.evaluate(
      () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
    );
    for (const name of ["Research", "Launch"]) {
      await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
      const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
      await dialog.getByLabel("Group name").fill(name);
      await dialog.getByRole("button", { name: "Create group", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    const research = page.getByRole("group", { name: "Research", exact: true });
    const launch = page.getByRole("group", { name: "Launch", exact: true });
    const ungrouped = page.getByRole("group", { name: "Ungrouped", exact: true });
    const row = page.locator('.sidebar__session[data-session-file="/preview/planning.jsonl"]');
    const demo = page.locator(
      '.sidebar__session[data-session-file="/preview/demo-conversation.jsonl"]',
    );
    await expect(row).toHaveAttribute("draggable", "true");
    await expect(demo).toHaveAttribute("draggable", "true");
    await expect(ungrouped.locator(".sidebar__session-name")).toContainText(["Project planning"]);
    await row.dragTo(research.locator(".sidebar__group-header"));
    await expect(research.locator(".sidebar__session-name")).toHaveText("Project planning");
    await expect(
      page.locator('.sidebar__session[data-session-file="/preview/planning.jsonl"]'),
    ).toHaveCount(1);
    await launch.getByRole("button", { name: "Collapse group Launch" }).click();
    await row.dragTo(launch.locator(".sidebar__group-header"));
    await expect(launch.getByRole("button", { name: "Collapse group Launch" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(launch.locator(".sidebar__session-name")).toHaveText("Project planning");
    await expect(research.locator(".sidebar__session")).toHaveCount(0);
    await row.dragTo(ungrouped.locator(".sidebar__ungrouped-label"));
    await expect(ungrouped.locator('[data-session-file="/preview/planning.jsonl"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
      ),
    ).toBe(active);
    // A loaded demo conversation has the same move behavior, without losing its label.
    await row.locator(".sidebar__session-name").click();
    await expect(page.locator(".composer__attach-btn")).toBeEnabled();
    await expect(page.locator(".sidebar__session--active .sidebar__session-name")).toHaveText(
      "Project planning",
    );
    await row.dragTo(research.locator(".sidebar__group-header"));
    await expect(research.locator(".sidebar__session-name")).toHaveText("Project planning");
    await demo.dragTo(research.locator(".sidebar__group-header"));
    await expect(research.locator(".sidebar__session")).toHaveCount(2);
    await expect(
      research.locator(
        '[data-session-file="/preview/demo-conversation.jsonl"] .sidebar__session-name',
      ),
    ).toHaveText("Demo conversation");
    const settings = await page.evaluate(() => window.pivis.invoke("settings.get", undefined));
    expect(settings.sessionGroups.find((group) => group.name === "Research")?.sessionFiles).toEqual(
      ["/preview/planning.jsonl", "/preview/demo-conversation.jsonl"],
    );
    expect(settings.archivedSessions).toEqual([]);
    expect(settings.pinnedSessions).toEqual([]);
    await expect(page.locator(".sidebar__session--active .sidebar__session-name")).toHaveText(
      "Project planning",
    );
    await expect(page.locator(".sidebar__session-group--drop-target")).toHaveCount(0);
  });

  test("group drops preserve pins, while pinned rows still reorder inside their own section", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Work");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    const group = page.getByRole("group", { name: "Work", exact: true });
    const ungrouped = page.getByRole("group", { name: "Ungrouped", exact: true });
    const review = page.locator('.sidebar__session[data-session-file="/preview/review.jsonl"]');
    const fork = page.locator('.sidebar__session[data-session-file="/preview/fork.jsonl"]');
    const active = await page.evaluate(
      () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
    );
    await review.hover();
    await review.getByTitle("Pin session", { exact: true }).click();
    await fork.hover();
    await fork.getByTitle("Pin session", { exact: true }).click();
    await review.dragTo(group.locator(".sidebar__group-header"));
    await expect(group.locator(".sidebar__session--pinned")).toHaveText("Payroll review");
    // Landing on a pinned row in a different section is a group move, not a pin reorder.
    await review.dragTo(fork);
    await expect(ungrouped.locator(".sidebar__session--pinned .sidebar__session-name")).toHaveText([
      "Payroll review",
      "Ordinary fork",
    ]);
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).pinnedSessions,
    ).toEqual([WORK_FILE, "/preview/fork.jsonl"]);
    await fork.dragTo(review);
    await expect(ungrouped.locator(".sidebar__session--pinned .sidebar__session-name")).toHaveText([
      "Ordinary fork",
      "Payroll review",
    ]);
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).pinnedSessions,
    ).toEqual(["/preview/fork.jsonl", WORK_FILE]);
    expect(
      await page.evaluate(
        () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
      ),
    ).toBe(active);
  });

  test("rejects cross-workspace, foreign, and cancelled session drags without reordering workspaces", async ({
    page,
  }) => {
    const other = "/Users/demo/src/other";
    await page.evaluate((workspace) => {
      const store = (window as unknown as PreviewWindow).__pivisStore.getState();
      store.addWorkspace(workspace);
      store.expandWorkspace(workspace);
    }, other);
    await page.getByRole("button", { name: "Create session group in other" }).click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Other workspace");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    const target = page.getByRole("group", { name: "Other workspace", exact: true });
    await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
    const ownDialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await ownDialog.getByLabel("Group name").fill("Own workspace");
    await ownDialog.getByRole("button", { name: "Create group", exact: true }).click();
    const ownTarget = page.getByRole("group", { name: "Own workspace", exact: true });
    const row = page.locator('.sidebar__session[data-session-file="/preview/review.jsonl"]');
    const before = await page.evaluate(() => window.pivis.invoke("settings.get", undefined));
    await row.dragTo(target.locator(".sidebar__group-header"));
    await expect(target.locator(".sidebar__session")).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).sessionGroups,
    ).toEqual(before.sessionGroups);
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-pi-vis-session", "sidebar-session");
      return transfer;
    });
    await ownTarget.dispatchEvent("dragover", { dataTransfer });
    await ownTarget.dispatchEvent("drop", { dataTransfer });
    const aborts = await page.evaluate(() => {
      const hooks = (window as unknown as PreviewWindow).__pivisPreview;
      hooks.startStreaming();
      return hooks.abortCalls;
    });
    await row.dispatchEvent("dragstart", { dataTransfer });
    expect(
      await page.evaluate(() =>
        (window as unknown as PreviewWindow).__pivisPreview.escapeClaimCount(),
      ),
    ).toBe(1);
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
    ).toBe(aborts);
    await row.dispatchEvent("dragend", { dataTransfer });
    expect(
      await page.evaluate(() =>
        (window as unknown as PreviewWindow).__pivisPreview.escapeClaimCount(),
      ),
    ).toBe(0);
    await ownTarget.dispatchEvent("drop", { dataTransfer });
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).sessionGroups,
    ).toEqual(before.sessionGroups);
    await dataTransfer.dispose();
    const sourceWorkspace = page
      .locator(".sidebar__workspace")
      .filter({ has: page.locator(`.sidebar__workspace-name[title="${WORKSPACE}"]`) });
    const otherWorkspace = page
      .locator(".sidebar__workspace")
      .filter({ has: page.locator(`.sidebar__workspace-name[title="${other}"]`) });
    await sourceWorkspace
      .locator(".sidebar__workspace-grip")
      .dragTo(otherWorkspace.locator(".sidebar__workspace-name"));
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).workspaceOrder,
    ).toEqual([other, WORKSPACE]);
    await expect(page.locator(".sidebar__session-group--drop-target")).toHaveCount(0);
  });

  test("shows an optimistic drop during a slow save, then rolls back and permits retry on failure", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Retry group");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    const group = page.getByRole("group", { name: "Retry group", exact: true });
    const row = page.locator('.sidebar__session[data-session-file="/preview/review.jsonl"]');
    await holdFailingGroupSave(page);
    await row.dragTo(group.locator(".sidebar__group-header"));
    await expect(group.locator(".sidebar__session-name")).toHaveText("Payroll review");
    await expect(page.locator(".sidebar__session-group--drop-target")).toHaveCount(0);
    await rejectGroupSave(page);
    await expect(group.locator(".sidebar__session")).toHaveCount(0);
    await expect(
      page
        .getByRole("group", { name: "Ungrouped", exact: true })
        .locator('[data-session-file="/preview/review.jsonl"]'),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Couldn’t save");
    await row.dragTo(group.locator(".sidebar__group-header"));
    await expect(group.locator(".sidebar__session-name")).toHaveText("Payroll review");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).sessionGroups[0]
        ?.sessionFiles,
    ).toEqual([WORK_FILE]);
  });

  test("defaults to hiding children and applies the Settings toggle immediately without session side effects", async ({
    page,
  }) => {
    const active = await page.evaluate(
      () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
    );
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: CHILD_NAME }),
    ).toHaveCount(0);
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: "Ordinary fork" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("button", { name: "Show sub-agent sessions", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(
      page.locator(".sidebar__session-name").filter({ hasText: CHILD_NAME }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
      ),
    ).toBe(active);
    const settings = await page.evaluate(() => window.pivis.invoke("settings.get", undefined));
    expect(settings.showSubagentSessions).toBe(true);
    expect(settings.archivedSessions).toEqual([]);
  });

  test("groups sessions, owns Escape/focus, and removes only organization metadata", async ({
    page,
  }) => {
    const aborts = await page.evaluate(() => {
      const hooks = (window as unknown as PreviewWindow).__pivisPreview;
      hooks.startStreaming();
      return hooks.abortCalls;
    });
    const row = page.locator(".sidebar__session").filter({ hasText: "Payroll review" });
    await row.hover();
    const move = row.getByTitle("Move session to group");
    await move.focus();
    await page.keyboard.press("Enter");
    const moveDialog = page.getByRole("dialog", { name: "Move session to group" });
    await expect(moveDialog.getByRole("radio", { name: "Ungrouped", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(moveDialog).toHaveCount(0);
    await expect(move).toBeFocused();
    expect(
      await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
    ).toBe(aborts);

    await move.click();
    await moveDialog.getByRole("button", { name: "New group", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New session group", exact: true });
    await expect(create.getByLabel("Group name")).toBeFocused();
    await create.getByLabel("Group name").fill("Research");
    await page.keyboard.press("Shift+Tab");
    await expect(create.getByRole("button", { name: "Create group", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(create.getByLabel("Group name")).toBeFocused();
    await create.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(create).toHaveCount(0);
    const group = page.getByRole("group", { name: "Research", exact: true });
    await expect(group.locator(".sidebar__session-name")).toHaveText("Payroll review");
    await expect(row).toBeFocused();
    const toggle = group.getByRole("button", { name: "Collapse group Research" });
    await toggle.click();
    await expect(group.getByRole("button", { name: "Expand group Research" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(group.locator(".sidebar__session")).toHaveCount(0);
    await group.hover();
    await group.getByRole("button", { name: "Rename group Research" }).click();
    const rename = page.getByRole("dialog", { name: "Rename group", exact: true });
    await rename.getByLabel("Group name").fill("Launch");
    await rename.getByRole("button", { name: "Save", exact: true }).click();
    const renamed = page.getByRole("group", { name: "Launch", exact: true });
    await renamed.getByRole("button", { name: "Expand group Launch" }).click();
    await expect(renamed.locator(".sidebar__session-name")).toHaveText("Payroll review");
    await page
      .locator(".sidebar")
      .screenshot({ path: test.info().outputPath("sidebar-groups.png") });
    await renamed.hover();
    await renamed
      .getByRole("button", { name: "Remove group Launch (keep sessions)", exact: true })
      .click();
    await expect(renamed).toHaveCount(0);
    await expect(row).toBeVisible();
    const settings = await page.evaluate(() => window.pivis.invoke("settings.get", undefined));
    expect(settings.sessionGroups).toEqual([]);
    expect(settings.archivedSessions).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
    ).toBe(aborts);
  });

  test("retains focus during a slow save and returns to the draft on failure", async ({ page }) => {
    await holdFailingGroupSave(page);
    const trigger = page.getByRole("button", { name: "Create session group in pi-vis" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Keep this draft");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    await rejectGroupSave(page);
    await expect(dialog.getByRole("alert")).toContainText("Couldn’t save");
    await expect(dialog.getByLabel("Group name")).toBeFocused();
    await expect(dialog.getByLabel("Group name")).toHaveValue("Keep this draft");
    expect(
      (await page.evaluate(() => window.pivis.invoke("settings.get", undefined))).sessionGroups,
    ).toEqual([]);
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("group", { name: "Keep this draft", exact: true })).toBeVisible();
  });

  test("restores focus to the newly mounted header when group removal rolls back", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
    const dialog = page.getByRole("dialog", { name: "New session group", exact: true });
    await dialog.getByLabel("Group name").fill("Keep this group");
    await dialog.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const group = page.getByRole("group", { name: "Keep this group", exact: true });
    await holdFailingGroupSave(page);
    await group.hover();
    await group
      .getByRole("button", { name: "Remove group Keep this group (keep sessions)", exact: true })
      .click();
    await expect(group).toHaveCount(0);
    await rejectGroupSave(page);
    await expect(group).toBeVisible();
    await expect(
      group.getByRole("button", { name: "Collapse group Keep this group" }),
    ).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Couldn’t save");
  });

  test("contains long group labels and narrow-window dialogs in light and dark themes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 520, height: 600 });
    // Keep the established New session affordance unambiguous for users and automation.
    await expect(page.getByRole("button", { name: "New session" })).toHaveCount(1);
    await page.getByRole("button", { name: "Create session group in pi-vis" }).click();
    const create = page.getByRole("dialog", { name: "New session group", exact: true });
    const name = "Research and investigations with a deliberately long descriptive session group";
    await create.getByLabel("Group name").fill(name);
    await create.getByRole("button", { name: "Create group", exact: true }).click();
    const group = page.getByRole("group", { name, exact: true });
    await expect(group).toBeVisible();
    await expect(group.locator(".sidebar__group-name .fade-text__inner")).toHaveText(name);
    expect(
      await page
        .locator(".sidebar")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page
        .locator(".sidebar")
        .screenshot({ path: test.info().outputPath(`sidebar-groups-${colorScheme}.png`) });
    }
  });
});
