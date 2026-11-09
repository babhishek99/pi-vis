import { expect, test } from "@playwright/test";
import type { useSessionsStore } from "../../src/renderer/src/stores/sessions-store.js";
import type { SessionId } from "../../src/shared/ids.js";
import type { InputUiRequest } from "../../src/shared/pi-protocol/extension-ui.js";

type PreviewWindow = {
  __pivisStore: typeof useSessionsStore;
  __pivisPreview: { startStreaming(): void };
};

const WAITING_ID = "preview-input-wait" as SessionId;

test("user-input dialogs and custom panels are yellow even while their requesting tool is active", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate((waitingId) => {
    const preview = window as unknown as PreviewWindow;
    preview.__pivisPreview.startStreaming();
    const state = preview.__pivisStore.getState();
    const source = state.sessions.get(state.activeSessionId!)!;
    const sessions = new Map(state.sessions);
    sessions.set(waitingId, {
      ...source,
      sessionId: waitingId,
      sessionFile: "/preview/waiting-for-input.jsonl",
      sessionName: "Waiting for your input",
      hasTreeHistory: true,
      pendingDialogs: [],
      panel: undefined,
      transcript: { ...source.transcript, activeToolCallIds: new Set(["ask-user-tool"]) },
    });
    preview.__pivisStore.setState({ sessions });
  }, WAITING_ID);

  const row = page.locator(
    '.sidebar__session[data-session-file="/preview/waiting-for-input.jsonl"]',
  );
  await expect(row.locator(".status-dot--streaming")).toBeVisible();

  for (const surface of ["dialog", "panel"] as const) {
    await page.evaluate(
      ({ waitingId, surface }) => {
        const store = (window as unknown as PreviewWindow).__pivisStore;
        const state = store.getState();
        const session = state.sessions.get(waitingId)!;
        const request: InputUiRequest = {
          type: "extension_ui_request",
          id: "preview-answer",
          method: "input",
          title: "Your answer?",
        };
        const sessions = new Map(state.sessions);
        sessions.set(waitingId, {
          ...session,
          pendingDialogs: surface === "dialog" ? [request] : [],
          panel:
            surface === "panel"
              ? {
                  id: 91,
                  overlay: true,
                  hostInstanceId: session.hostInstanceId!,
                  sessionEpoch: session.sessionEpoch,
                  buffer: [],
                }
              : undefined,
        });
        store.setState({ sessions });
      },
      { waitingId: WAITING_ID, surface },
    );

    const attention = row.getByTitle("Needs attention", { exact: true });
    await expect(attention).toBeVisible();
    await expect(row.locator(".status-dot--streaming")).toHaveCount(0);
    await expect(attention).toHaveCSS("animation-name", "none");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const colors = await attention.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--warning)";
        document.body.append(probe);
        const warning = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = "var(--accent)";
        const accent = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: getComputedStyle(element).backgroundColor, warning, accent };
      });
      expect(colors.actual).toBe(colors.warning);
      expect(colors.actual).not.toBe(colors.accent);
      await page
        .locator(".sidebar")
        .screenshot({
          path: test.info().outputPath(`sidebar-input-${surface}-${colorScheme}.png`),
        });
    }

    await page.evaluate((waitingId) => {
      const store = (window as unknown as PreviewWindow).__pivisStore;
      const state = store.getState();
      const session = state.sessions.get(waitingId)!;
      const sessions = new Map(state.sessions);
      sessions.set(waitingId, { ...session, pendingDialogs: [], panel: undefined });
      store.setState({ sessions });
    }, WAITING_ID);
    await expect(attention).toHaveCount(0);
    await expect(row.locator(".status-dot--streaming")).toBeVisible();
  }
});
