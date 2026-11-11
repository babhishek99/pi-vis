/**
 * Render test: ESC-to-interrupt timing + unified-panel interception.
 *
 * Two cases jsdom unit tests cannot reproduce:
 *  (a) Two-press under rapid ESC — pins that `useEscapeClaim` uses
 *      `useLayoutEffect` (a passive `useEffect` would swallow the 2nd ESC).
 *  (b) Unified-panel interception — pins the renderer-only decision: a
 *      capture-phase window ESC handler preempts xterm's input while
 *      streaming, while idle ESC still reaches the host editor.
 *
 * Drives the REAL renderer (served by `npm run dev:renderer`) with the
 * stubbed `window.pivis`. Test hooks live on `window.__pivisPreview`
 * (see preview-stub.ts).
 */
import { type Page, expect, test } from "@playwright/test";
import type { EscapeResult } from "../../src/shared/pi-protocol/runtime-state.js";

type PreviewHooks = {
  abortCalls: number;
  panelInputLog: string[];
  startStreaming: () => void;
  stopStreaming: () => void;
};

type PreviewStore = {
  getState: () => {
    activeSessionId: string | null;
    sessions: Map<
      string,
      {
        runtimeSnapshot?: { isStreaming: boolean };
        authorityProjection?: { semantic?: { state?: string } };
      }
    >;
  };
};

async function getHooks(page: import("@playwright/test").Page): Promise<PreviewHooks> {
  return page.evaluate(() => {
    return (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview;
  });
}

async function waitForBaseline(page: Page): Promise<void> {
  // Wait for the initial authority baseline before publishing the fake turn;
  // otherwise a late baseline can overwrite its streaming snapshot.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = (window as unknown as { __pivisStore?: PreviewStore }).__pivisStore;
          const state = store?.getState();
          const sid = state?.activeSessionId;
          return sid
            ? state.sessions.get(sid)?.authorityProjection?.semantic?.state === "following"
            : false;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function startStreaming(page: Page): Promise<void> {
  await waitForBaseline(page);
  await page.evaluate(() => {
    (window as unknown as { __pivisPreview: PreviewHooks }).__pivisPreview.startStreaming();
  });
  // Wait until the ACTIVE session is actually interruptible — the global ESC
  // handler aborts only the active session.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = (window as unknown as { __pivisStore?: PreviewStore }).__pivisStore;
          const state = store?.getState();
          const sid = state?.activeSessionId;
          const session = sid ? state.sessions.get(sid) : undefined;
          return session?.runtimeSnapshot?.isStreaming === true;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function receiptFixture(page: Page, status: "requested" | "unsupported"): Promise<void> {
  await page.evaluate((resultStatus) => {
    const invoke = Reflect.get(window.pivis, "invoke") as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(window.pivis, "invoke", async (...args: unknown[]) => {
      const result = await invoke(...args);
      if (args[0] !== "session.escape") return result;
      const parent = result as EscapeResult;
      return resultStatus === "requested"
        ? {
            ...parent,
            disposition: "abort_requested",
            target: "subagents",
            subagents: {
              status: "requested",
              agents: 1,
              workflows: 0,
              pendingOperations: false,
              pendingNotifications: false,
            },
          }
        : {
            ...parent,
            disposition: "outcome_unknown",
            subagents: { status: "unsupported" },
            message:
              "Parent interruption was handled, but this subagent extension needs the stop-all update.",
          };
    });
  }, status);
}

test.describe("ESC-to-interrupt — renderer", () => {
  test("idle-parent background stop still reaches the host; IME and modifiers do not", async ({
    page,
  }) => {
    await page.goto("/");
    const textarea = page.locator(".composer__textarea");
    await expect(textarea).toBeEnabled({ timeout: 20_000 });
    await waitForBaseline(page);
    await receiptFixture(page, "requested");
    const before = (await getHooks(page)).abortCalls;
    await page.evaluate(() => {
      for (const options of [
        { shiftKey: true },
        { ctrlKey: true },
        { altKey: true },
        { metaKey: true },
        { isComposing: true },
      ]) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      }
    });
    expect((await getHooks(page)).abortCalls).toBe(before);
    await textarea.focus();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await getHooks(page)).abortCalls).toBe(before + 1);
    await expect(page.locator(".notification-card--warning")).toHaveCount(0);
  });

  test("an unsupported extension warns only after parent interruption", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });
    await startStreaming(page);
    await receiptFixture(page, "unsupported");
    const before = (await getHooks(page)).abortCalls;
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await getHooks(page)).abortCalls).toBe(before + 1);
    await expect(page.locator(".notification-card--warning")).toContainText(
      "needs the stop-all update",
    );
  });
  test("(a) two-press under rapid ESC: first closes autocomplete, second aborts", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Wait for the composer to mount.
    const textarea = page.locator(".composer__textarea");
    await expect(textarea).toBeEnabled({ timeout: 20_000 });

    // Start a fake turn so the active session is interruptible.
    await startStreaming(page);

    // Focus the composer and type "/" to open the autocomplete.
    await textarea.focus();
    await textarea.fill("/");
    await expect(page.locator(".composer__suggestion").first()).toBeVisible({
      timeout: 5_000,
    });

    // First ESC closes autocomplete — even though a turn is streaming, an open
    // autocomplete ALWAYS consumes the first ESC (the two-press model). It does
    // NOT abort. (useLayoutEffect guarantees the claim is released within this
    // turn, so the second ESC reaches the interrupt path, not the deferred one —
    // the pin against a passive useEffect.)
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".composer__textarea")!;
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator(".composer__suggestion")).toHaveCount(0);

    // Second ESC (autocomplete now closed) aborts the running turn.
    const beforeAbort = (await getHooks(page)).abortCalls;
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".composer__textarea")!;
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    const hooks = await getHooks(page);
    expect(hooks.abortCalls).toBeGreaterThan(beforeAbort);
  });

  test("(b) unified-panel + streaming: ESC aborts and does NOT forward to panelInput", async ({
    page,
  }) => {
    await page.goto("/?unified=1");
    await page.waitForLoadState("domcontentloaded");
    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // Start streaming.
    await startStreaming(page);

    // Dispatch ESC at the window level (the global capture handler is what
    // we're pinning — it preempts regardless of where focus is, which is the
    // renderer-only decision).
    const before = (await getHooks(page)).abortCalls;
    const beforeInput = (await getHooks(page)).panelInputLog.length;
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    const afterStreaming = await getHooks(page);
    // Streaming ESC aborted the turn.
    expect(afterStreaming.abortCalls).toBeGreaterThan(before);
    // And it did NOT forward an ESC byte to the host editor (the capture
    // handler preempted the path). The idle autocomplete-cancel path is
    // covered by the host-side unified-tui.test.mjs gate.
    expect(afterStreaming.panelInputLog.length).toBe(beforeInput);
  });

  test("(c) unified-panel overlay (viewport) + streaming: ESC does NOT abort", async ({ page }) => {
    // Issue 2 parity: an extension overlay is open on the unified TUI (the
    // "ESC to close" box), signalled to the renderer as viewport mode. ESC must
    // behave exactly as in pi's TUI — close the overlay, NOT abort the agent.
    // The UnifiedTuiHost claims ESC in viewport mode, so the global handler
    // defers and the keystroke flows to the host instead of aborting.
    await page.goto("/?unified=overlay");
    await page.waitForLoadState("domcontentloaded");
    const panel = page.locator(".unified-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // Wait until the overlay box has painted — by then viewport mode is set and
    // the ESC claim is active.
    await expect(panel.locator(".xterm-rows")).toContainText("inspect", { timeout: 15_000 });

    await startStreaming(page);

    const before = (await getHooks(page)).abortCalls;
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    // No abort: the claim deferred ESC to the host (which closes the overlay).
    expect((await getHooks(page)).abortCalls).toBe(before);
  });
});
