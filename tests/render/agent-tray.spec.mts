import { type Locator, type Page, expect, test } from "@playwright/test";
import type { useSessionsStore } from "../../src/renderer/src/stores/sessions-store.js";
import {
  activityAgent,
  activitySnapshot,
  activityWorkflow,
} from "../../src/shared/pi-protocol/__fixtures__/subagent-activity.js";
import type {
  SessionQueryEnvelope,
  SessionQueryResult,
} from "../../src/shared/pi-protocol/runtime-state.js";
import {
  type ActivitySnapshot,
  type SubagentActivityResult,
  SubagentActivityResultSchema,
} from "../../src/shared/pi-protocol/subagent-activity.js";

type Controls = {
  result: SubagentActivityResult;
  hold: boolean;
  requests: SessionQueryEnvelope[];
  pending: Array<(result: SubagentActivityResult) => void>;
};
type PreviewWindow = {
  __activityFixture: Controls;
  __pivisStore: typeof useSessionsStore;
  __pivisPreview: { abortCalls: number; startStreaming(): void; escapeClaimCount(): number };
};

function populated(): ActivitySnapshot {
  const snapshot = activitySnapshot(
    [
      activityAgent("outer", {
        name: "Repository audit",
        workflowId: "audit",
        phase: "Review public boundary",
      }),
      activityAgent("nested", {
        name: "Detailed nested reviewer ".repeat(4).slice(0, 80),
        parentAgentId: "outer",
        task: "Review the authored task summary. ".repeat(8).slice(0, 240),
        detailsTruncated: true,
      }),
      activityAgent("queued", { name: "Waiting reviewer", state: "queued", status: "queued" }),
      activityAgent("before-record", {
        recordId: null,
        workflowId: "audit",
        name: "Preparing reviewer",
        state: "starting",
      }),
      activityAgent("cleanup", {
        name: "Stopping reviewer",
        parentAgentId: "outer",
        state: "unwinding",
        status: "stopped",
      }),
      activityAgent("missing", {
        name: "Retained child",
        parentAgentId: "evicted",
        state: "finished",
        status: "completed",
      }),
      ...Array.from({ length: 35 }, (_, index) =>
        activityAgent(`finished-${index}`, {
          name: `Finished reviewer ${index}`,
          state: "finished",
          status: index === 0 ? "error" : "completed",
        }),
      ),
    ],
    [
      activityWorkflow("audit"),
      activityWorkflow("paused", { name: "Paused audit", state: "paused", status: "paused" }),
      activityWorkflow("stopping", { name: "Stopping audit", state: "stopping" }),
      activityWorkflow("finished", {
        name: "Finished audit",
        state: "finished",
        status: "completed",
      }),
    ],
  );
  snapshot.omitted = { agents: 7, workflows: 2 };
  snapshot.agentCounts.finished += 7;
  snapshot.workflowCounts.finished += 2;
  snapshot.pendingOperations = true;
  snapshot.unwindingOperations = true;
  snapshot.pendingNotifications = true;
  return snapshot;
}

/** Synthetic interception of only this display read; preview itself stays unavailable. */
async function install(page: Page, result: SubagentActivityResult, hold = false): Promise<void> {
  SubagentActivityResultSchema.parse(result);
  await page.addInitScript(
    ({ result, hold }) => {
      const controls: Controls = { result, hold, requests: [], pending: [] };
      Reflect.set(window, "__activityFixture", controls);
      let hooks: unknown;
      Object.defineProperty(window, "__pivisPreview", {
        configurable: true,
        get: () => hooks,
        set: (value: unknown) => {
          hooks = value;
          let api: unknown;
          Object.defineProperty(window, "pivis", {
            configurable: true,
            get: () => api,
            set: (value: object) => {
              const original = Reflect.get(value, "invoke") as (
                ...args: unknown[]
              ) => Promise<unknown>;
              Reflect.set(value, "invoke", (...args: unknown[]) => {
                const request = args[1] as SessionQueryEnvelope | undefined;
                if (args[0] !== "session.query" || request?.query.type !== "get_subagent_activity")
                  return original.apply(value, args);
                controls.requests.push(structuredClone(request));
                const reply = (data: SubagentActivityResult): SessionQueryResult => ({
                  status: "ok",
                  queryId: request.queryId,
                  owner: request.expectedOwner,
                  queryType: "get_subagent_activity",
                  response: {
                    type: "response",
                    command: "get_subagent_activity",
                    success: true,
                    data: structuredClone(data),
                  },
                });
                return controls.hold
                  ? new Promise<SessionQueryResult>((resolve) =>
                      controls.pending.push((data) => resolve(reply(data))),
                    )
                  : Promise.resolve(reply(controls.result));
              });
              api = value;
            },
          });
        },
      });
    },
    { result, hold },
  );
}

async function boot(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
}

function trigger(page: Page): Locator {
  return page.getByRole("button", { name: /^Agents in this tab:/ });
}
function tray(page: Page): Locator {
  return page.getByRole("dialog", { name: "Agents in this tab", exact: true });
}
async function aborts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls);
}

async function assertFits(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  await expect
    .poll(() =>
      tray(page).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const anchor = document.querySelector(".agent-tray__trigger")!.getBoundingClientRect();
        const scroller = element.querySelector(".agent-tray__list")!;
        const footer = element.querySelector(".agent-tray__footer")!.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= anchor.bottom &&
          rect.bottom <= innerHeight &&
          element.scrollWidth <= element.clientWidth &&
          scroller.scrollWidth <= scroller.clientWidth &&
          getComputedStyle(scroller).overflowY === "auto" &&
          scroller.getBoundingClientRect().bottom <= footer.top &&
          footer.bottom <= rect.bottom
        );
      }),
    )
    .toBe(true);
}

test("unmodified preview honestly reports unavailable rather than an invented empty fleet", async ({
  page,
}) => {
  await boot(page);
  await expect(trigger(page).locator(".agent-tray__count")).toHaveText("?");
  await trigger(page).click();
  await expect(tray(page)).toContainText("Agent activity is unavailable in this runtime.");
  await expect(tray(page)).toContainText("Unknown does not mean no agents.");
  await expect(tray(page).locator("[data-activity-id]")).toHaveCount(0);
  expect(await aborts(page)).toBe(0);
});

for (const status of ["unsupported", "failed"] as const) {
  test(`${status} support stays unknown, and explicit retry can recover an actually empty snapshot`, async ({
    page,
  }) => {
    await install(page, { status });
    await boot(page);
    await trigger(page).click();
    await expect(trigger(page).locator(".agent-tray__count")).toHaveText("?");
    await expect(tray(page)).toContainText("Unknown does not mean no agents.");
    await page.evaluate(() => {
      (window as unknown as PreviewWindow).__activityFixture.result = {
        status: "ready",
        snapshot: {
          version: 1,
          observedAt: 1_700_000_000_000,
          agents: [],
          workflows: [],
          agentCounts: { running: 0, starting: 0, queued: 0, unwinding: 0, finished: 0 },
          workflowCounts: { running: 0, paused: 0, stopping: 0, finished: 0 },
          omitted: { agents: 0, workflows: 0 },
          pendingOperations: false,
          unwindingOperations: false,
          pendingNotifications: false,
        },
      };
    });
    await tray(page).getByRole("button", { name: "Retry activity read" }).click();
    await expect(trigger(page).locator(".agent-tray__count")).toHaveText("0");
    await expect(tray(page)).toContainText("No agents or workflows in this runtime.");
    expect(await aborts(page)).toBe(0);
  });
}

test("real browser hierarchy, queued and unwinding rows, scroll fades and native Escape ownership", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await install(page, { status: "ready", snapshot: populated() });
  await boot(page, "/?spendDemo=1");
  await expect(trigger(page).locator(".agent-tray__count")).toHaveText("5");
  await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.startStreaming());
  const before = await aborts(page);
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(tray(page).locator(".agent-tray__list")).toBeFocused();
  await expect(tray(page)).toContainText(
    "2 running · 1 starting · 1 queued · 1 unwinding · 43 finished",
  );
  await expect(
    tray(page).locator(
      '[data-activity-id="audit"] [data-activity-id="outer"] [data-activity-id="nested"]',
    ),
  ).toHaveCount(1);
  await expect(
    tray(page).locator('[data-activity-id="audit"] [data-activity-id="before-record"]'),
  ).toHaveCount(1);
  await expect(
    tray(page).locator('[data-activity-id="outer"] [data-activity-id="cleanup"]'),
  ).toHaveCount(1);
  await expect(tray(page)).toContainText("Phase: Review public boundary");
  await expect(tray(page).locator('[data-activity-id="queued"] .spinner')).toHaveCount(0);
  await expect(tray(page).locator('[data-activity-id="cleanup"] .spinner')).toHaveCount(1);
  await expect(tray(page).locator('[data-activity-id="finished-0"] .spinner')).toHaveCount(0);
  await expect(tray(page).locator('[data-activity-id="nested"] .agent-tray__name')).toHaveAttribute(
    "data-overflow",
    "true",
  );
  await assertFits(page);
  await expect(tray(page).locator(".scroll-fade-frame__edge--bottom")).toHaveCount(1);
  await expect(tray(page).locator(".scroll-fade-frame__edge--top")).toHaveCount(0);
  await page.evaluate(() => {
    for (const options of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ])
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      );
  });
  await expect(tray(page)).toBeVisible();
  expect(await aborts(page)).toBe(before);
  await tray(page).locator(".agent-tray__list").press("End");
  await expect(
    tray(page).getByText("Not shown: 7 agents, 2 workflows. Counts include these rows."),
  ).toBeInViewport();
  await expect(tray(page).locator(".scroll-fade-frame__edge--top")).toHaveCount(1);
  await expect(tray(page).locator(".scroll-fade-frame__edge--bottom")).toHaveCount(0);
  await expect(tray(page)).toContainText("Parent not in snapshot");
  await expect(tray(page)).toContainText(
    "Preparations pending · Cleanup pending · Notifications pending",
  );
  await page.keyboard.press("Escape");
  await expect(tray(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(await aborts(page)).toBe(before);
  expect(
    await page.evaluate(() =>
      (window as unknown as PreviewWindow).__pivisPreview.escapeClaimCount(),
    ),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await expect.poll(() => aborts(page)).toBe(before + 1);
  const requests = await page.evaluate(
    () => (window as unknown as PreviewWindow).__activityFixture.requests,
  );
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (request) =>
        Object.keys(request.query).length === 1 && request.query.type === "get_subagent_activity",
    ),
  ).toBe(true);
});

test("outside focus and existing model/context/spend controls coexist without cancellation", async ({
  page,
}) => {
  await install(page, { status: "ready", snapshot: populated() });
  await boot(page, "/?spendDemo=1");
  await trigger(page).click();
  await page.locator(".composer__textarea").focus();
  await expect(tray(page)).toHaveCount(0);
  await expect(page.locator(".composer__textarea")).toBeFocused();
  await trigger(page).click();
  await page.locator(".context-ring").click();
  await expect(tray(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Direct session gateway spend" })).toContainText(
    "Partial",
  );
  await page.keyboard.press("Escape");
  await trigger(page).click();
  await page.locator(".session-header__model-btn").click();
  await expect(tray(page)).toHaveCount(0);
  await expect(
    page.locator(".session-header__model-picker .session-header__dropdown"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Current month gateway spend" })).toBeVisible();
  expect(await aborts(page)).toBe(0);
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`full/compact/minimum-height geometry and semantic surfaces in ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await install(page, { status: "ready", snapshot: populated() });
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, "/?spendDemo=1");
    await trigger(page).click();
    await assertFits(page);
    await expect(page.locator(".titlebar .agent-tray__trigger")).toHaveCount(1);
    await tray(page).screenshot({
      path: test.info().outputPath(`agent-tray-full-${colorScheme}.png`),
    });
    await page.setViewportSize({ width: 480, height: 400 });
    await expect(page.locator(".session-sub-bar .agent-tray__trigger")).toBeVisible();
    // Reflow remounts the common controls; a departed tray owns no Escape.
    await expect(tray(page)).toHaveCount(0);
    await trigger(page).click();
    await assertFits(page);
    const semantic = await tray(page).evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface)";
      probe.style.color = "var(--accent)";
      document.body.appendChild(probe);
      const styles = getComputedStyle(probe);
      const matches =
        getComputedStyle(element).backgroundColor === styles.backgroundColor &&
        getComputedStyle(element.querySelector(".spinner")!).color === styles.color;
      probe.remove();
      return matches;
    });
    expect(semantic).toBe(true);
    await expect(page.locator(".context-ring")).toBeInViewport();
    await expect(page.locator(".session-header__model-btn")).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath(`agent-tray-minimum-${colorScheme}.png`),
    });
    await tray(page).locator(".agent-tray__list").press("End");
    await expect(
      tray(page).getByText("Not shown: 7 agents, 2 workflows. Counts include these rows."),
    ).toBeInViewport();
    await tray(page).getByRole("button", { name: "Close agent tray" }).click();
    await expect(trigger(page)).toBeFocused();
    expect(await aborts(page)).toBe(0);
  });
}

test("a coalesced synchronization gap retires an outstanding browser read before its late reply", async ({
  page,
}) => {
  await install(page, { status: "ready", snapshot: activitySnapshot() }, true);
  await boot(page);
  await trigger(page).click();
  await expect(tray(page)).toContainText("Checking agent activity");
  const before = await page.evaluate(
    () => (window as unknown as PreviewWindow).__activityFixture.pending.length,
  );
  expect(before).toBeGreaterThan(0);
  // StrictMode may already have retired an initial mount's read. Capture the
  // active visit's last pending read instead of assuming one mount globally.
  await page.evaluate(() => {
    const store = (window as unknown as PreviewWindow).__pivisStore;
    const state = store.getState();
    const id = state.activeSessionId!;
    const session = state.sessions.get(id)!;
    store.setState({
      sessions: new Map(state.sessions).set(id, { ...session, availability: "unavailable" }),
    });
    store.setState({ sessions: state.sessions });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as PreviewWindow).__activityFixture.pending.length),
    )
    .toBe(before + 1);
  await page.evaluate(
    ({ index, result }) =>
      (window as unknown as PreviewWindow).__activityFixture.pending[index]!(result),
    {
      index: before - 1,
      result: {
        status: "ready" as const,
        snapshot: activitySnapshot([activityAgent("retired-read")]),
      },
    },
  );
  await expect(tray(page)).not.toContainText("retired-read");
  await expect(trigger(page).locator(".agent-tray__count")).toHaveText("?");
  await page.evaluate(
    ({ index, result }) =>
      (window as unknown as PreviewWindow).__activityFixture.pending[index]!(result),
    {
      index: before,
      result: {
        status: "ready" as const,
        snapshot: activitySnapshot([activityAgent("current-read")]),
      },
    },
  );
  await expect(tray(page)).toContainText("current-read");
  await expect(trigger(page).locator(".agent-tray__count")).toHaveText("1");
  expect(await aborts(page)).toBe(0);
});
