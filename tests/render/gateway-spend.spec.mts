import { type Page, expect, test } from "@playwright/test";
import type { useSessionsStore } from "../../src/renderer/src/stores/sessions-store.js";
import type { GatewaySpendResult } from "../../src/shared/gateway-spend.js";
import type { SessionId } from "../../src/shared/ids.js";

const NOW = "2026-10-15T12:00:00.000Z";

function spend(overrides: Partial<GatewaySpendResult> = {}): GatewaySpendResult {
  return {
    state: "ready",
    scope: "personal_gateway",
    source: "Datadog gateway audit logs",
    period: {
      start: "2026-09-01T00:00:00.000Z",
      endExclusive: "2026-10-01T00:00:00.000Z",
      timeZone: "UTC",
    },
    snapshot: { amountUsd: 42.75, pricedRequests: 12, unpricedRequests: 0, asOf: NOW },
    trackedSince: null,
    stale: false,
    issue: null,
    nextRefreshAt: null,
    ...overrides,
  };
}

function sessionSpend(overrides: Partial<GatewaySpendResult> = {}): GatewaySpendResult {
  return spend({ scope: "direct_session_partial", trackedSince: NOW, ...overrides });
}

type SpendFixtures = {
  month: GatewaySpendResult;
  session: GatewaySpendResult;
  calls: Array<{ channel: string; request: unknown }>;
  holdSession: boolean;
  pending: Array<{ resolve(result: GatewaySpendResult): void }>;
  failNextMonth: boolean;
};

type PreviewWindow = {
  __spendFixtures: SpendFixtures;
  __pivisStore: typeof useSessionsStore;
  __pivisPreview: {
    abortCalls: number;
    startStreaming(): void;
    escapeClaimCount(): number;
  };
};

/** Replaces only the two spend invokes before React mounts. No billing network exists here. */
async function fixtures(page: Page, month = spend(), session = sessionSpend()): Promise<void> {
  await page.clock.install({ time: new Date(NOW) });
  await page.addInitScript(
    ({ month, session }) => {
      const controls: SpendFixtures = {
        month,
        session,
        calls: [],
        holdSession: false,
        pending: [],
        failNextMonth: false,
      };
      Reflect.set(window, "__spendFixtures", controls);
      // Leave `pivis` absent until main.tsx passes its browser-preview guard.
      // The preview hook is published before its API and before React mounts.
      let hooks: unknown;
      Object.defineProperty(window, "__pivisPreview", {
        configurable: true,
        get: () => hooks,
        set: (preview: unknown) => {
          hooks = preview;
          let api: unknown;
          Object.defineProperty(window, "pivis", {
            configurable: true,
            get: () => api,
            set: (value: object) => {
              const original = Reflect.get(value, "invoke") as (
                ...args: unknown[]
              ) => Promise<unknown>;
              Reflect.set(value, "invoke", (...args: unknown[]) => {
                const channel = args[0];
                if (channel !== "gatewaySpend.month" && channel !== "gatewaySpend.session") {
                  return original.apply(value, args);
                }
                controls.calls.push({ channel, request: args[1] });
                if (channel === "gatewaySpend.session" && controls.holdSession) {
                  return new Promise<GatewaySpendResult>((resolve) =>
                    controls.pending.push({ resolve }),
                  );
                }
                if (channel === "gatewaySpend.month" && controls.failNextMonth) {
                  controls.failNextMonth = false;
                  return Promise.reject(new Error("private fixture transport details"));
                }
                return Promise.resolve(
                  structuredClone(
                    channel === "gatewaySpend.month" ? controls.month : controls.session,
                  ),
                );
              });
              api = value;
            },
          });
        },
      });
    },
    { month, session },
  );
}

async function boot(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  // Wait for Sidebar's one-shot boot adoption, not the deliberately early textarea.
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });
}

async function calls(page: Page, channel: string) {
  return page.evaluate(
    (channel) =>
      (window as unknown as PreviewWindow).__spendFixtures.calls.filter(
        (call) => call.channel === channel,
      ),
    channel,
  );
}

async function resolveRead(page: Page, index: number, result: GatewaySpendResult): Promise<void> {
  await page.evaluate(
    ({ index, result }) => {
      const pending = (window as unknown as PreviewWindow).__spendFixtures.pending[index];
      if (!pending) throw new Error("Missing deferred spend fixture");
      pending.resolve(result);
    },
    { index, result },
  );
}

async function changeFile(page: Page, file: string): Promise<void> {
  await page.evaluate((file) => {
    const store = (window as unknown as PreviewWindow).__pivisStore;
    const state = store.getState();
    const id = state.activeSessionId;
    const session = id ? state.sessions.get(id) : undefined;
    if (!id || !session) throw new Error("Missing preview session");
    const sessions = new Map(state.sessions);
    sessions.set(id, { ...session, sessionFile: file });
    store.setState({ sessions });
  }, file);
}

test("preview defaults are not configured and the opt-in demo is entirely synthetic", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await boot(page);
  await expect(page.locator(".gateway-spend-month")).toHaveCount(0);
  await page.locator(".context-ring").click();
  await expect(page.locator(".gateway-session-spend")).toHaveCount(0);
  const disabled = await page.evaluate(async () => ({
    month: await window.pivis.invoke("gatewaySpend.month", {}),
    session: await window.pivis.invoke("gatewaySpend.session", {
      sessionId: "preview-only" as SessionId,
    }),
  }));
  expect(disabled.month.state).toBe("not_configured");
  expect(disabled.session.state).toBe("not_configured");

  await boot(page, "/?spendDemo=1");
  await expect(page.getByRole("button", { name: "Previous month gateway spend" })).toContainText(
    "$42.75 USD",
  );
  await page.locator(".context-ring").click();
  await expect(page.locator(".gateway-session-spend")).toContainText("$1.18 USD");
  await expect(page.locator(".gateway-session-spend")).toContainText("Partial");
  const demo = await page.evaluate(() => window.pivis.invoke("gatewaySpend.month", {}));
  const now = new Date(NOW);
  expect(demo.period).toEqual({
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(),
    endExclusive: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    timeZone: "UTC",
  });
});

test("monthly disclosure is subdued footer chrome with source, scope, UTC bounds and keyboard ownership", async ({
  page,
}) => {
  await fixtures(page);
  await boot(page);
  const trigger = page.getByRole("button", { name: "Previous month gateway spend" });
  await expect(trigger).toContainText("Gateway · Sep 2026");
  await expect(trigger).toContainText("$42.75 USD");
  expect(
    await trigger.evaluate((button) => button.closest("section")?.nextElementSibling?.className),
  ).toBe("sidebar__footer");
  expect(await calls(page, "gatewaySpend.month")).toEqual([
    { channel: "gatewaySpend.month", request: {} },
  ]);
  expect(await calls(page, "gatewaySpend.session")).toEqual([]);
  await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.startStreaming());
  await trigger.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: "Monthly gateway spend details" });
  await expect(details).toContainText("Personal legacy gateway · all harnesses");
  await expect(details).toContainText("Datadog gateway audit logs");
  await expect(details).toContainText("From (UTC)2026-09-01 00:00:00 UTC");
  await expect(details).toContainText("Until (exclusive, UTC)2026-10-01 00:00:00 UTC");
  await expect(details).toContainText("As of2026-10-15 12:00:00 UTC");
  await expect(details).toContainText("Gateway-recorded USD, not an invoice or token estimate.");
  await expect(trigger.locator(".fade-text")).toHaveCount(2);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Refresh monthly gateway spend" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
  ).toBe(0);
  expect(await calls(page, "gatewaySpend.month")).toHaveLength(1);
});

test("missing prices are never zero, partial and stale/errors stay explicit, and manual refresh is sanitized", async ({
  page,
}) => {
  await fixtures(
    page,
    spend({
      snapshot: { amountUsd: null, pricedRequests: 0, unpricedRequests: 3, asOf: NOW },
    }),
  );
  await boot(page);
  const trigger = page.getByRole("button", { name: "Previous month gateway spend" });
  await expect(trigger).toContainText("No priced records · Partial");
  await trigger.click();
  const details = page.getByRole("region", { name: "Monthly gateway spend details" });
  await expect(details).toContainText("Partial: 3 unpriced requests excluded from the total.");
  await expect(details).not.toContainText("$0");
  const refresh = page.getByRole("button", { name: "Refresh monthly gateway spend" });
  await page.evaluate(
    (pending) => {
      (window as unknown as PreviewWindow).__spendFixtures.month = pending;
    },
    spend({ state: "pending", snapshot: null }),
  );
  await refresh.click();
  await expect(details).toContainText("Awaiting audit logs");
  await expect(details).toContainText("Pending: audit records may arrive later.");
  await expect(details).not.toContainText("$0");
  await page.evaluate(
    (zero) => {
      (window as unknown as PreviewWindow).__spendFixtures.month = zero;
    },
    spend({ snapshot: { amountUsd: 0, pricedRequests: 1, unpricedRequests: 0, asOf: NOW } }),
  );
  await refresh.click();
  await expect(details.locator(".gateway-spend__value")).toHaveText("$0.00 USD");
  await page.evaluate(
    (subcent) => {
      (window as unknown as PreviewWindow).__spendFixtures.month = subcent;
    },
    spend({
      snapshot: { amountUsd: 0.00000123456789, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
    }),
  );
  await refresh.click();
  await expect(details.locator(".gateway-spend__value")).toHaveText("<$0.01 USD");
  expect(
    await page.evaluate(
      () => (window as unknown as PreviewWindow).__spendFixtures.month.snapshot?.amountUsd,
    ),
  ).toBe(0.00000123456789);
  await page.evaluate(() => {
    (window as unknown as PreviewWindow).__spendFixtures.failNextMonth = true;
  });
  await refresh.click();
  await expect(details).toContainText("Gateway spend could not be read. Try refreshing.");
  await expect(details).toContainText("Stale · showing the last available audit snapshot.");
  await expect(details).not.toContainText("private fixture transport details");
  expect(
    (await calls(page, "gatewaySpend.month"))
      .slice(1)
      .every((call) => JSON.stringify(call.request) === JSON.stringify({ refresh: true })),
  ).toBe(true);
});

test("month refresh respects its deadline and is hourly, while an open session section never polls", async ({
  page,
}) => {
  await fixtures(page, spend({ nextRefreshAt: "2026-10-15T12:01:00.000Z" }));
  await boot(page);
  await page.getByRole("button", { name: "Previous month gateway spend" }).click();
  const refresh = page.getByRole("button", { name: "Refresh monthly gateway spend" });
  await expect(refresh).toBeDisabled();
  await expect(page.locator(".gateway-spend__refresh-hint")).toContainText(
    "2026-10-15 12:01:00 UTC",
  );
  await page.clock.fastForward(60_000);
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.month")).length).toBe(2);
  await page.locator(".context-ring").click();
  await expect(page.locator(".gateway-session-spend")).toContainText("$42.75 USD");
  await page.clock.fastForward(3_600_000);
  await expect.poll(async () => (await calls(page, "gatewaySpend.month")).length).toBe(3);
  expect(await calls(page, "gatewaySpend.session")).toHaveLength(1);
});

test("ContextMeter reads only while open and presents direct-session Partial tracking independently of token stats", async ({
  page,
}) => {
  await fixtures(page);
  await boot(page);
  expect(await calls(page, "gatewaySpend.session")).toEqual([]);
  const ring = page.locator(".context-ring");
  await ring.click();
  const section = page.getByRole("region", { name: "Direct session gateway spend" });
  await expect(section).toContainText("Partial");
  await expect(section).toContainText("Tracked since 2026-10-15 12:00:00 UTC");
  await expect(section).toContainText(
    "Direct session only. No child rollups; untracked request paths are not included.",
  );
  await expect(section).toContainText("Gateway-recorded USD, not an invoice or token estimate.");
  const id = await page.evaluate(
    () => (window as unknown as PreviewWindow).__pivisStore.getState().activeSessionId,
  );
  expect(await calls(page, "gatewaySpend.session")).toEqual([
    { channel: "gatewaySpend.session", request: { sessionId: id } },
  ]);
  const refresh = section.getByRole("button", { name: "Refresh direct session gateway spend" });
  await refresh.click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(2);
  await refresh.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".context-dropdown")).toHaveCount(0);
  await expect(ring).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as PreviewWindow).__pivisPreview.abortCalls),
  ).toBe(0);
  await ring.click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(3);
  await expect(page.locator(".context-dropdown__rows")).toContainText("Input");
  await expect(page.locator(".context-dropdown__rows")).not.toContainText("USD");
});

test("direct-session Not tracked, pending, stale/error and disabled states do not imply complete or zero spend", async ({
  page,
}) => {
  await fixtures(
    page,
    spend(),
    sessionSpend({ state: "not_tracked", snapshot: null, trackedSince: null }),
  );
  await boot(page);
  await page.locator(".context-ring").click();
  const section = page.getByRole("region", { name: "Direct session gateway spend" });
  await expect(section.locator(".gateway-spend__value")).toHaveText("Not tracked");
  await expect(section).toContainText("Partial");
  await expect(section).not.toContainText("$0");
  const refresh = section.getByRole("button", { name: "Refresh direct session gateway spend" });
  await page.evaluate(
    (pending) => {
      (window as unknown as PreviewWindow).__spendFixtures.session = pending;
    },
    sessionSpend({ state: "pending", snapshot: null }),
  );
  await refresh.click();
  await expect(section).toContainText("Awaiting audit logs");
  await expect(section).toContainText("Tracked since");
  await page.evaluate(
    (stale) => {
      (window as unknown as PreviewWindow).__spendFixtures.session = stale;
    },
    sessionSpend({ state: "unavailable", stale: true, issue: "timeout" }),
  );
  await refresh.click();
  await expect(section).toContainText("Stale · showing the last available audit snapshot.");
  await expect(section).toContainText("The audit-log read timed out.");
  await expect(section).toContainText("Partial");
  await page.evaluate(
    (disabled) => {
      (window as unknown as PreviewWindow).__spendFixtures.session = disabled;
    },
    sessionSpend({ state: "not_configured", snapshot: null }),
  );
  await refresh.click();
  await expect(section).toHaveCount(0);
});

test("late session/file generations cannot paint a successor, including A → B → A before a render", async ({
  page,
}) => {
  await fixtures(page);
  await boot(page);
  await page.evaluate(() => {
    (window as unknown as PreviewWindow).__spendFixtures.holdSession = true;
  });
  await page.locator(".context-ring").click();
  const section = page.getByRole("region", { name: "Direct session gateway spend" });
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(1);
  await changeFile(page, "/preview/spend-successor.jsonl");
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(2);
  await resolveRead(
    page,
    0,
    sessionSpend({
      snapshot: { amountUsd: 999, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
    }),
  );
  await expect(section).not.toContainText("$999");
  await expect(section).toContainText("Reading audit logs");
  await resolveRead(page, 1, sessionSpend());
  await expect(section).toContainText("$42.75 USD");
  await section.getByRole("button", { name: "Refresh direct session gateway spend" }).click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(3);
  await page.evaluate(() => {
    const store = (window as unknown as PreviewWindow).__pivisStore;
    const id = store.getState().activeSessionId;
    if (!id) throw new Error("Missing preview session");
    for (const file of ["/preview/spend-temporary.jsonl", "/preview/spend-successor.jsonl"]) {
      const sessions = new Map(store.getState().sessions);
      const session = sessions.get(id)!;
      sessions.set(id, { ...session, sessionFile: file });
      store.setState({ sessions });
    }
  });
  await expect(section).not.toContainText("$42.75");
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(4);
  await resolveRead(
    page,
    2,
    sessionSpend({
      snapshot: { amountUsd: 777, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
    }),
  );
  await expect(section).not.toContainText("$777");
  await resolveRead(page, 3, sessionSpend({ state: "pending", snapshot: null }));
  await expect(section).toContainText("Awaiting audit logs");
  // An outstanding read for A must not appear after the active renderer switches to B.
  await section.getByRole("button", { name: "Refresh direct session gateway spend" }).click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(5);
  await page.evaluate(() => {
    const store = (window as unknown as PreviewWindow).__pivisStore.getState();
    const id = "spend-render-b" as SessionId;
    store.createSession(id, "/Users/demo/src/pi-vis", "/preview/spend-b.jsonl", "Spend B");
    store.setActiveSession(id);
  });
  await expect(page.locator(".context-dropdown")).toHaveCount(0);
  await page.locator(".context-ring").click();
  await expect.poll(async () => (await calls(page, "gatewaySpend.session")).length).toBe(6);
  await resolveRead(
    page,
    4,
    sessionSpend({
      snapshot: { amountUsd: 555, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
    }),
  );
  await expect(section).not.toContainText("$555");
  await resolveRead(
    page,
    5,
    sessionSpend({
      snapshot: { amountUsd: 8.5, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
    }),
  );
  await expect(section).toContainText("$8.50 USD");
  const reads = await calls(page, "gatewaySpend.session");
  expect(reads.at(-1)?.request).toEqual({ sessionId: "spend-render-b" });
  expect(
    reads.every((read) =>
      Object.keys(read.request as object).every((key) => key === "sessionId" || key === "refresh"),
    ),
  ).toBe(true);
});

test("narrow light/dark layouts contain details, preserve footer reachability and use semantic surfaces", async ({
  page,
}) => {
  await fixtures(
    page,
    spend({ snapshot: { amountUsd: 42.75, pricedRequests: 12, unpricedRequests: 3, asOf: NOW } }),
  );
  await page.setViewportSize({ width: 480, height: 400 });
  await boot(page);
  const trigger = page.getByRole("button", { name: "Previous month gateway spend" });
  await trigger.click();
  const details = page.getByRole("region", { name: "Monthly gateway spend details" });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
  const geometry = await details.evaluate((element) => {
    const sidebar = element.closest(".sidebar")!;
    const rect = element.getBoundingClientRect();
    return {
      horizontal: element.scrollWidth <= element.clientWidth,
      sidebarHorizontal: sidebar.scrollWidth <= sidebar.clientWidth,
      inViewport: rect.top >= 0 && rect.bottom <= innerHeight,
      scrollable: element.scrollHeight > element.clientHeight,
    };
  });
  expect(geometry).toEqual({
    horizontal: true,
    sidebarHorizontal: true,
    inViewport: true,
    scrollable: true,
  });
  await details
    .getByRole("button", { name: "Refresh monthly gateway spend" })
    .scrollIntoViewIfNeeded();
  await expect(
    details.getByRole("button", { name: "Refresh monthly gateway spend" }),
  ).toBeInViewport();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const semantic = await details.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface)";
      probe.style.color = "var(--warning-soft)";
      document.body.appendChild(probe);
      const matches =
        getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor &&
        getComputedStyle(element.querySelector(".gateway-spend__notice")!).color ===
          getComputedStyle(probe).color;
      probe.remove();
      return matches;
    });
    expect(semantic).toBe(true);
    await page
      .locator(".sidebar")
      .screenshot({ path: test.info().outputPath(`gateway-month-${colorScheme}.png`) });
  }
  await page.keyboard.press("Escape");
  await page.locator(".context-ring").click();
  await expect(page.locator(".gateway-session-spend")).toContainText("$42.75 USD");
  const context = page.locator(".context-dropdown");
  const fitsContext = () =>
    context.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const clip = element.closest(".app__main")!.getBoundingClientRect();
      return (
        rect.left >= clip.left &&
        rect.right <= clip.right &&
        rect.bottom <= clip.bottom &&
        element.scrollWidth <= element.clientWidth
      );
    });
  // Opening the card can load an additional font weight and wrap its anchor
  // onto a second controls row. Wait for that layout, not a fixed sleep.
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  await expect.poll(fitsContext).toBe(true);
  await context
    .getByRole("button", { name: "Refresh direct session gateway spend" })
    .scrollIntoViewIfNeeded();
  await expect(
    context.getByRole("button", { name: "Refresh direct session gateway spend" }),
  ).toBeInViewport();
  await context.screenshot({ path: test.info().outputPath("gateway-session-narrow.png") });
  // The sidebar seam changes the clipping pane without a window resize. First
  // widen the pane, then shrink it to the shell's 38% sidebar cap; merely
  // increasing an already-capped sidebar width would not exercise a resize.
  const clipWidth = () =>
    context.evaluate((element) => element.closest(".app__main")!.getBoundingClientRect().width);
  const initialWidth = await clipWidth();
  await page.locator(".app").evaluate((element) => {
    (element as HTMLElement).style.setProperty("--sidebar-width", "160px");
  });
  await expect.poll(clipWidth).toBeGreaterThan(initialWidth);
  await expect.poll(fitsContext).toBe(true);
  const widerWidth = await clipWidth();
  await page.locator(".app").evaluate((element) => {
    (element as HTMLElement).style.setProperty("--sidebar-width", "260px");
  });
  await expect.poll(clipWidth).toBeLessThan(widerWidth);
  await expect.poll(fitsContext).toBe(true);
  expect(await calls(page, "gatewaySpend.session")).toHaveLength(1);
});
