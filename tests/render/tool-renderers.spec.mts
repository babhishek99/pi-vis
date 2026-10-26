import { type Page, expect, test } from "@playwright/test";

type Owner = { hostInstanceId: string; sessionEpoch: number };
type ToolQuery = {
  queryId: string;
  expectedOwner: Owner;
  query: { type: string; toolCallId: string; cols: number; expanded: boolean };
};
type PreviewSession = {
  sessionEpoch: number;
  authorityProjection: {
    owner?: Owner;
    authoritativeSnapshot?: { owner: Owner };
    semantic: { state: string; cursor?: Owner };
  };
};
type PreviewState = {
  activeSessionId: string;
  sessions: Map<string, PreviewSession>;
  seedHistory(sessionId: string, history: unknown[]): void;
};
type TestWindow = {
  __pivisStore: {
    getState(): PreviewState;
    setState(update: (state: PreviewState) => Partial<PreviewState>): void;
  };
  pivis: { invoke(channel: string, payload: unknown): Promise<unknown> };
  __toolQueries?: ToolQuery[];
  __toolRenderVersion?: number;
  __resolveOldToolQuery?: () => void;
};

async function prepareTool(page: Page, holdFirst = false): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as TestWindow).__pivisStore?.getState().activeSessionId,
  );
  await page.waitForTimeout(800);
  await page.evaluate((hold) => {
    const target = window as unknown as TestWindow;
    const state = target.__pivisStore.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "custom-rendered-tool",
        type: "tool_call",
        data: {
          toolCallId: "canonical-call-id",
          toolName: "renderer_probe",
          input: { message: "ORIGINAL INPUT" },
          outputText: "ORIGINAL OUTPUT",
          isError: false,
          isStreaming: false,
        },
      },
    ]);
    target.__toolQueries = [];
    target.__toolRenderVersion = 1;
    const original = target.pivis.invoke.bind(target.pivis);
    target.pivis.invoke = (channel, payload) => {
      const request = payload as ToolQuery;
      if (channel !== "session.query" || request.query?.type !== "render_tool") {
        return original(channel, payload);
      }
      target.__toolQueries!.push(request);
      const response = (ansi: string) => ({
        status: "ok",
        queryId: request.queryId,
        owner: request.expectedOwner,
        queryType: "render_tool",
        response: {
          type: "response",
          command: "render_tool",
          success: true,
          data: { rendered: true, ansi },
        },
      });
      if (hold && target.__toolQueries!.length === 1) {
        return new Promise((resolve) => {
          target.__resolveOldToolQuery = () => resolve(response("STALE PREDECESSOR VIEW"));
        });
      }
      return Promise.resolve(
        response(`\u001b[36mCUSTOM TOOL VIEW ${target.__toolRenderVersion}\u001b[0m`),
      );
    };
  }, holdFirst);
}

test("expanded tool cards render extension views and refresh without changing raw results", async ({
  page,
}) => {
  await prepareTool(page);
  const card = page.locator(".tool-card").filter({ hasText: "renderer_probe" });
  const disclosure = card.locator(".tool-card__header");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__toolQueries?.length)).toBe(
    0,
  );
  await disclosure.click();
  await expect(card.getByText("CUSTOM TOOL VIEW 1", { exact: true })).toBeVisible();
  await expect(card).toContainText("ORIGINAL INPUT");
  await expect(card).toContainText("ORIGINAL OUTPUT");
  const query = await page.evaluate(
    () => (window as unknown as TestWindow).__toolQueries?.[0]?.query,
  );
  expect(query).toEqual({
    type: "render_tool",
    toolCallId: "canonical-call-id",
    cols: expect.any(Number),
    expanded: true,
  });
  expect(query!.cols).toBeGreaterThanOrEqual(20);
  expect(query!.cols).toBeLessThanOrEqual(240);

  await page.evaluate(() => {
    (window as unknown as TestWindow).__toolRenderVersion = 2;
  });
  await expect(card.getByText("CUSTOM TOOL VIEW 2", { exact: true })).toBeVisible();
  await disclosure.click();
  const closedCount = await page.evaluate(
    () => (window as unknown as TestWindow).__toolQueries?.length,
  );
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__toolQueries?.length)).toBe(
    closedCount,
  );
});

test("a delayed predecessor tool rendering cannot overwrite the successor view", async ({
  page,
}) => {
  await prepareTool(page, true);
  const card = page.locator(".tool-card").filter({ hasText: "renderer_probe" });
  await card.locator(".tool-card__header").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__toolQueries?.length))
    .toBe(1);
  await page.evaluate(() => {
    const target = window as unknown as TestWindow;
    target.__pivisStore.setState((state) => {
      const current = state.sessions.get(state.activeSessionId)!;
      const projection = current.authorityProjection;
      const snapshot = projection.authoritativeSnapshot!;
      const owner = { ...snapshot.owner, sessionEpoch: snapshot.owner.sessionEpoch + 1 };
      const sessions = new Map(state.sessions);
      sessions.set(state.activeSessionId, {
        ...current,
        sessionEpoch: owner.sessionEpoch,
        authorityProjection: {
          ...projection,
          owner,
          authoritativeSnapshot: { ...snapshot, owner },
          semantic: { ...projection.semantic, cursor: { ...projection.semantic.cursor, ...owner } },
        },
      });
      return { sessions };
    });
  });
  await expect(card.getByText("CUSTOM TOOL VIEW 1", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).__resolveOldToolQuery?.());
  await expect(card.getByText("STALE PREDECESSOR VIEW", { exact: true })).toHaveCount(0);
  await expect(card.getByText("CUSTOM TOOL VIEW 1", { exact: true })).toBeVisible();
});
