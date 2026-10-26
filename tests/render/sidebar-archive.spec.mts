import { expect, test } from "@playwright/test";

type PreviewHooks = {
  abortCalls: number;
  forceRestartCalls: number;
  startStreaming(): void;
};

type PreviewStore = {
  getState(): {
    setExpandedWorkspaces(paths: string[]): void;
    setWorkspaceSessions(
      workspacePath: string,
      sessions: Array<{
        id: string;
        cwd: string;
        filePath: string;
        name: string;
        preview: string;
        mtime: number;
        messageCount: number;
      }>,
    ): void;
  };
};

const WORKSPACE = "/Users/demo/src/pi-vis";

async function seedStoredSession(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((workspace) => {
    const state = (
      window as unknown as {
        __pivisStore: PreviewStore;
      }
    ).__pivisStore.getState();
    state.setExpandedWorkspaces([workspace]);
    state.setWorkspaceSessions(workspace, [
      {
        id: "archive-fixture",
        cwd: workspace,
        filePath: "/preview/archive-fixture.jsonl",
        name: "Archive confirmation design review",
        preview: "Archive confirmation design review",
        mtime: 1,
        messageCount: 1,
      },
    ]);
  }, WORKSPACE);
}

test.describe("sidebar session archive confirmation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
    await seedStoredSession(page);
  });

  test("hard restart confirms during running work and preserves the session row", async ({
    page,
  }) => {
    const counts = await page.evaluate(() => {
      const hooks = (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
      hooks.startStreaming();
      return { aborts: hooks.abortCalls, restarts: hooks.forceRestartCalls };
    });
    const row = page.locator(".sidebar__session").filter({ hasText: "Untitled session" });
    await row.hover();
    const restart = row.getByTitle("Force restart host");
    await restart.click();
    const dialog = page.getByRole("dialog", { name: "Force restart host?" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(restart).toBeFocused();
    await restart.click();
    await dialog.getByRole("button", { name: "Force restart", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hooks = (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
          return { aborts: hooks.abortCalls, restarts: hooks.forceRestartCalls };
        }),
      )
      .toEqual({ aborts: counts.aborts, restarts: counts.restarts + 1 });
  });

  test("defaults to the safe action, restores focus on cancel, and archives only on confirm", async ({
    page,
  }) => {
    const row = page
      .locator(".sidebar__session")
      .filter({ hasText: "Archive confirmation design review" });
    const archiveButton = row.getByTitle("Archive session");

    const abortsBefore = await page.evaluate(() => {
      const hooks = (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
      hooks.startStreaming();
      return hooks.abortCalls;
    });
    const dialog = page.getByRole("dialog", { name: "Archive session?" });

    const liveRow = page.locator(".sidebar__session").filter({ hasText: "Untitled session" });
    const liveArchiveButton = liveRow.getByTitle("Archive session");
    await liveRow.hover();
    await liveArchiveButton.focus();
    await page.keyboard.press("Space");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(liveArchiveButton).toBeFocused();

    await row.hover();
    await archiveButton.focus();
    await page.keyboard.press("Enter");

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Archive confirmation design review");
    await expect(dialog).toContainText("You can’t undo this in Pi-Vis");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(row).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(archiveButton).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.abortCalls,
        ),
      )
      .toBe(abortsBefore);

    await page.keyboard.press("Space");
    await expect(dialog).toBeVisible();
    await page.locator(".confirm-dialog-scrim").click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(archiveButton).toBeFocused();

    await archiveButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(page.locator(".sidebar__session:focus, .sidebar__new-session:focus")).toHaveCount(
      1,
    );
  });
});
