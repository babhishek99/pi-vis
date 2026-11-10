// @vitest-environment jsdom
import type { GatewaySpendResult } from "@shared/gateway-spend.js";
import type { SessionId } from "@shared/ids.js";
import { type ReactElement, StrictMode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { GatewayMonthSpend } from "./GatewayMonthSpend.js";
import { GatewaySessionSpend } from "./GatewaySessionSpend.js";

const A = "spend-session-a" as SessionId;
const B = "spend-session-b" as SessionId;
const NOW = "2026-10-15T12:00:00.000Z";
const OCTOBER_PERIOD = {
  start: "2026-10-01T00:00:00.000Z",
  endExclusive: NOW,
  timeZone: "UTC" as const,
};
const NOVEMBER_PERIOD = {
  start: "2026-11-01T00:00:00.000Z",
  endExclusive: "2026-11-30T23:59:59.000Z",
  timeZone: "UTC" as const,
};
const DECEMBER_PERIOD = {
  start: "2026-12-01T00:00:00.000Z",
  endExclusive: "2026-12-01T00:00:01.000Z",
  timeZone: "UTC" as const,
};
const roots = new Set<Root>();

function result(overrides: Partial<GatewaySpendResult> = {}): GatewaySpendResult {
  return {
    state: "ready",
    scope: "personal_gateway",
    source: "Datadog gateway audit logs",
    period: OCTOBER_PERIOD,
    snapshot: {
      amountUsd: 42.75,
      pricedRequests: 12,
      unpricedRequests: 0,
      asOf: overrides.period?.endExclusive ?? NOW,
    },
    trackedSince: null,
    stale: false,
    issue: null,
    nextRefreshAt: null,
    ...overrides,
  };
}

function sessionResult(overrides: Partial<GatewaySpendResult> = {}): GatewaySpendResult {
  return result({ scope: "direct_session_partial", trackedSince: NOW, ...overrides });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount(node: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const render = (element: ReactElement): void => {
    act(() => root.render(element));
  };
  render(node);
  return {
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      roots.delete(root);
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: ParentNode, selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  act(() => button!.click());
  return button!;
}

function changeFile(sessionId: SessionId, file: string | undefined): void {
  const sessions = new Map(useSessionsStore.getState().sessions);
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Missing fixture session");
  sessions.set(sessionId, { ...session, sessionFile: file });
  useSessionsStore.setState({ sessions });
}

let invoke = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke = vi.fn().mockResolvedValue(result());
  Object.defineProperty(window, "pivis", {
    configurable: true,
    writable: true,
    value: { invoke },
  });
  useSessionsStore.getState().createSession(A, "/preview/workspace", "/preview/a.jsonl");
  useSessionsStore.getState().createSession(B, "/preview/workspace", "/preview/b.jsonl");
});

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  useSessionsStore.setState({ sessions: new Map() });
  useOverlayStore.setState({ claims: [], count: 0 });
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current month-to-date gateway spend", () => {
  it("reads once on mount and stays hidden when configuration is disabled", async () => {
    const pending = deferred<GatewaySpendResult>();
    invoke.mockReturnValue(pending.promise);
    const { container } = mount(<GatewayMonthSpend />);
    expect(container.textContent).toContain("Gateway · Current month · MTD");
    expect(container.textContent).toContain("Reading audit logs");
    expect(container.textContent).not.toContain("$0");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Current month gateway spend",
    );
    await act(async () => pending.resolve(result({ state: "not_configured", snapshot: null })));
    expect(container.textContent).toBe("");
    expect(invoke.mock.calls).toEqual([["gatewaySpend.month", {}]]);
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("coalesces StrictMode mount-effect replay without losing the successor presentation", async () => {
    const { container } = mount(
      <StrictMode>
        <GatewayMonthSpend />
      </StrictMode>,
    );
    await settle();
    expect(invoke.mock.calls).toEqual([["gatewaySpend.month", {}]]);
    expect(container.textContent).toContain("$42.75 USD");
  });

  it("shows the source period, UTC exclusive bounds, scope, freshness and USD provenance", async () => {
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("Gateway · Oct 2026 · MTD");
    expect(trigger.textContent).toContain("$42.75 USD");
    expect(trigger.getAttribute("aria-controls")).toBe(
      container.querySelector('[role="region"]')?.id,
    );
    expect(container.textContent).toContain(
      "Current month-to-date · Personal legacy gateway · all harnesses",
    );
    expect(container.textContent).toContain("Datadog gateway audit logs");
    expect(container.textContent).toContain("From (UTC)2026-10-01 00:00:00 UTC");
    expect(container.textContent).toContain("Until (exclusive, UTC)2026-10-15 12:00:00 UTC");
    expect(container.textContent).toContain("As of2026-10-15 12:00:00 UTC");
    expect(container.textContent).toContain("Checked");
    expect(container.textContent).toContain(
      "Gateway-recorded USD, not an invoice or token estimate.",
    );
    expect(invoke).toHaveBeenCalledTimes(1); // Opening is not a second query.
  });

  it("keeps the cached MTD coverage and as-of instead of advancing them with the wall clock", async () => {
    const cachedPeriod = { ...OCTOBER_PERIOD, endExclusive: "2026-10-15T11:15:00.000Z" };
    invoke.mockResolvedValue(result({ period: cachedPeriod }));
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    await act(async () => vi.advanceTimersByTime(30 * 60_000));
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("Gateway · Oct 2026 · MTD");
    expect(container.textContent).toContain("Until (exclusive, UTC)2026-10-15 11:15:00 UTC");
    expect(container.textContent).toContain("As of2026-10-15 11:15:00 UTC");
    expect(container.textContent).toContain("Checked2026-10-15 12:00:00 UTC");
    expect(container.textContent).not.toContain("12:30:00");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("uses the current-month fallback when the read has no period or snapshot", async () => {
    invoke.mockResolvedValue(
      result({ state: "unavailable", period: null, snapshot: null, issue: "timeout" }),
    );
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("Gateway · Current month · MTD");
    expect(trigger.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("PeriodUnavailable");
    expect(container.textContent).toContain("As ofNo audit snapshot");
    expect(container.textContent).not.toContain("$0");
    expect(container.textContent).not.toContain("Previous month");
  });

  it.each([
    { state: "ready" as const, amount: null, label: "No priced records" },
    { state: "pending" as const, amount: null, label: "Awaiting audit logs" },
    { state: "ready" as const, amount: 0, label: "$0.00 USD" },
    { state: "ready" as const, amount: 0.001, label: "<$0.01 USD" },
  ])(
    "distinguishes $label from a missing or known-zero amount",
    async ({ state, amount, label }) => {
      invoke.mockResolvedValue(
        result({
          state,
          snapshot: {
            amountUsd: amount,
            pricedRequests: amount === null ? 0 : 1,
            unpricedRequests: 0,
            asOf: NOW,
          },
        }),
      );
      const { container } = mount(<GatewayMonthSpend />);
      await settle();
      click(container, ".gateway-spend-month__trigger");
      expect(container.querySelector(".gateway-spend__value")?.textContent).toBe(label);
      if (amount === null) expect(container.textContent).not.toContain("$0");
    },
  );

  it("labels a total partial whenever unpriced records are excluded, even with no priced records", async () => {
    invoke.mockResolvedValue(
      result({ snapshot: { amountUsd: null, pricedRequests: 0, unpricedRequests: 3, asOf: NOW } }),
    );
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("No priced records · Partial");
    expect(container.textContent).toContain(
      "Partial: 3 unpriced requests excluded from the total.",
    );
    expect(container.textContent).not.toContain("$0");
  });

  it("retains a stale source snapshot and renders only sanitized issue labels", async () => {
    invoke.mockResolvedValue(result({ state: "unavailable", stale: true, issue: "timeout" }));
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    click(container, ".gateway-spend-month__trigger");
    expect(container.textContent).toContain("$42.75 USD");
    expect(container.textContent).toContain("Stale · showing the last available audit snapshot.");
    expect(container.textContent).toContain("The audit-log read timed out.");
  });

  it("surfaces a failed first read without converting it to zero or displaying rejection details", async () => {
    invoke.mockRejectedValue(new Error("private transport details"));
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    click(container, ".gateway-spend-month__trigger");
    expect(container.textContent).toContain("Gateway · Current month · MTD");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Gateway spend could not be read. Try refreshing.");
    expect(container.textContent).not.toContain("private transport details");
    expect(container.textContent).not.toContain("$0");
  });

  it("refreshes hourly, not on session updates, and cancels its timer on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rendered = mount(<GatewayMonthSpend />);
    await settle();
    act(() => changeFile(A, "/preview/another.jsonl"));
    await act(async () => vi.advanceTimersByTime(3_599_999));
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(invoke.mock.calls).toEqual([
      ["gatewaySpend.month", {}],
      ["gatewaySpend.month", { refresh: true }],
    ]);
    rendered.unmount();
    await act(async () => vi.advanceTimersByTime(2 * 3_600_000));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("starts exactly one December MTD read at UTC rollover and ignores the old November flight", async () => {
    vi.setSystemTime(NOVEMBER_PERIOD.endExclusive);
    const oldRead = deferred<GatewaySpendResult>();
    const freshRead = deferred<GatewaySpendResult>();
    invoke.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    const { container } = mount(
      <StrictMode>
        <GatewayMonthSpend />
      </StrictMode>,
    );
    expect(invoke.mock.calls).toEqual([["gatewaySpend.month", {}]]);
    await act(async () => vi.advanceTimersByTime(999));
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(new Date().toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(invoke.mock.calls).toEqual([
      ["gatewaySpend.month", {}],
      ["gatewaySpend.month", {}],
    ]);
    await act(async () => oldRead.resolve(result({ period: NOVEMBER_PERIOD })));
    expect(container.textContent).toContain("Gateway · Current month · MTD");
    expect(container.textContent).toContain("Reading audit logs");
    expect(container.textContent).not.toContain("$42.75");
    expect(container.textContent).not.toContain("Nov 2026");
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () =>
      freshRead.resolve(
        result({
          period: DECEMBER_PERIOD,
          snapshot: {
            amountUsd: 8.5,
            pricedRequests: 2,
            unpricedRequests: 0,
            asOf: DECEMBER_PERIOD.endExclusive,
          },
        }),
      ),
    );
    expect(container.textContent).toContain("Gateway · Dec 2026 · MTD");
    expect(container.textContent).toContain("$8.50 USD");
    expect(container.textContent).not.toContain("$42.75");
    click(container, ".gateway-spend-month__trigger");
    expect(container.textContent).toContain("From (UTC)2026-12-01 00:00:00 UTC");
    expect(container.textContent).toContain("Until (exclusive, UTC)2026-12-01 00:00:01 UTC");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("hides a displayed November amount at rollover and cleans up both monthly timers", async () => {
    vi.setSystemTime(NOVEMBER_PERIOD.endExclusive);
    const freshRead = deferred<GatewaySpendResult>();
    invoke
      .mockResolvedValueOnce(result({ period: NOVEMBER_PERIOD }))
      .mockReturnValueOnce(freshRead.promise);
    const rendered = mount(<GatewayMonthSpend />);
    await settle();
    expect(rendered.container.textContent).toContain("Gateway · Nov 2026 · MTD");
    expect(rendered.container.textContent).toContain("$42.75 USD");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(rendered.container.textContent).toContain("Reading audit logs");
    expect(rendered.container.textContent).not.toContain("$42.75");
    expect(rendered.container.textContent).not.toContain("Nov 2026");
    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => freshRead.resolve(result({ period: DECEMBER_PERIOD })));
    await act(async () => vi.advanceTimersByTime(31 * 24 * 3_600_000));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not retain November's amount when December has no audit snapshot", async () => {
    vi.setSystemTime(NOVEMBER_PERIOD.endExclusive);
    invoke
      .mockResolvedValueOnce(result({ period: NOVEMBER_PERIOD }))
      .mockResolvedValueOnce(
        result({ state: "unavailable", period: DECEMBER_PERIOD, snapshot: null, issue: "timeout" }),
      );
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    expect(container.textContent).toContain("$42.75 USD");
    await act(async () => vi.advanceTimersByTime(2000));
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("Gateway · Dec 2026 · MTD");
    expect(trigger.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("As ofNo audit snapshot");
    expect(container.textContent).not.toContain("Nov 2026");
    expect(container.textContent).not.toContain("$42.75");
    expect(container.textContent).not.toContain("$0");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("fences a November response even before the rollover timer callback runs", async () => {
    vi.setSystemTime(NOVEMBER_PERIOD.endExclusive);
    const oldRead = deferred<GatewaySpendResult>();
    invoke.mockReturnValueOnce(oldRead.promise);
    const { container } = mount(<GatewayMonthSpend />);
    // Changing the fake wall clock does not fire timers, like a read settling
    // before a delayed deadline callback after system resume.
    vi.setSystemTime("2026-12-01T00:00:00.000Z");
    await act(async () => oldRead.resolve(result({ period: NOVEMBER_PERIOD })));
    expect(container.textContent).not.toContain("$42.75");
    expect(container.textContent).not.toContain("Nov 2026");
    expect(container.textContent).toContain("Reading audit logs");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "November period", period: NOVEMBER_PERIOD },
    { name: "missing period", period: null },
  ])("rejects a new-month amount with a $name instead of relabeling it", async ({ period }) => {
    vi.setSystemTime(DECEMBER_PERIOD.endExclusive);
    invoke.mockResolvedValue(result({ period }));
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(trigger.textContent).toContain("Gateway · Current month · MTD");
    expect(container.textContent).toContain("Gateway spend could not be read. Try refreshing.");
    expect(container.textContent).not.toContain("Nov 2026");
    expect(container.textContent).not.toContain("$42.75");
    expect(container.textContent).not.toContain("$0");
    invoke.mockResolvedValue(result({ period: DECEMBER_PERIOD }));
    click(container, ".gateway-spend__refresh");
    await settle();
    expect(trigger.textContent).toContain("Gateway · Dec 2026 · MTD");
    expect(container.textContent).toContain("$42.75 USD");
  });

  it("honors nextRefreshAt, wakes at its boundary, and coalesces repeated manual clicks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    invoke.mockResolvedValue(result({ nextRefreshAt: "2026-10-15T12:01:00.000Z" }));
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    click(container, ".gateway-spend-month__trigger");
    const refresh = click(container, ".gateway-spend__refresh");
    expect(refresh.disabled).toBe(true);
    expect(container.textContent).toContain("Refresh available 2026-10-15 12:01:00 UTC");
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(refresh.disabled).toBe(false);
    const pending = deferred<GatewaySpendResult>();
    invoke.mockReturnValue(pending.promise);
    act(() => {
      refresh.click();
      refresh.click();
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("gatewaySpend.month", { refresh: true });
    await act(async () => pending.reject(new Error("private refresh failure")));
    expect(container.textContent).toContain("Stale · showing the last available audit snapshot.");
    expect(container.textContent).toContain("$42.75 USD");
    expect(container.textContent).not.toContain("private refresh failure");
  });

  it("claims bare Escape, returns trigger focus, and dismisses on outside focus without stealing it", async () => {
    const { container } = mount(<GatewayMonthSpend />);
    await settle();
    const trigger = click(container, ".gateway-spend-month__trigger");
    expect(useOverlayStore.getState().count).toBe(1);
    const refresh = container.querySelector<HTMLButtonElement>(".gateway-spend__refresh")!;
    refresh.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(useOverlayStore.getState().count).toBe(0);
    click(container, ".gateway-spend-month__trigger");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(outside);
  });
});

describe("direct session gateway spend", () => {
  beforeEach(() => invoke.mockResolvedValue(sessionResult()));

  it("is always partial, identifies tracking/source/bounds, and sends only the session ID", async () => {
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    await settle();
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).toContain(
      "No child rollups; untracked request paths are not included.",
    );
    expect(container.textContent).toContain("Tracked since 2026-10-15 12:00:00 UTC");
    expect(container.textContent).toContain("Datadog gateway audit logs");
    expect(container.textContent).toContain("Until (exclusive, UTC)");
    expect(invoke.mock.calls).toEqual([["gatewaySpend.session", { sessionId: A }]]);
    click(container, ".gateway-spend__refresh");
    await settle();
    expect(invoke).toHaveBeenLastCalledWith("gatewaySpend.session", {
      sessionId: A,
      refresh: true,
    });
  });

  it("hides the section when configuration is disabled", async () => {
    invoke.mockResolvedValue(sessionResult({ state: "not_configured", snapshot: null }));
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it.each([
    { state: "not_tracked" as const, value: "Not tracked", trackedSince: null },
    { state: "pending" as const, value: "Awaiting audit logs", trackedSince: NOW },
    { state: "ready" as const, value: "No priced records", trackedSince: NOW },
    { state: "unavailable" as const, value: "Unavailable", trackedSince: NOW },
  ])(
    "shows $state without suggesting known-zero or complete coverage",
    async ({ state, value, trackedSince }) => {
      invoke.mockResolvedValue(sessionResult({ state, snapshot: null, trackedSince }));
      const { container } = mount(<GatewaySessionSpend sessionId={A} />);
      await settle();
      expect(container.querySelector(".gateway-spend__value")?.textContent).toBe(value);
      expect(container.textContent).toContain("Partial");
      expect(container.textContent).not.toContain("$0");
    },
  );

  it("does not refresh from streaming/stats updates or an hourly timer", async () => {
    vi.useFakeTimers();
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    await settle();
    act(() => {
      const sessions = new Map(useSessionsStore.getState().sessions);
      const session = sessions.get(A)!;
      sessions.set(A, { ...session, editorRevision: 2 });
      useSessionsStore.setState({ sessions });
    });
    await act(async () => vi.advanceTimersByTime(2 * 3_600_000));
    expect(container.textContent).toContain("$42.75 USD");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("discards a late A result after switching to B and never displays the prior session while B reads", async () => {
    const a = deferred<GatewaySpendResult>();
    const b = deferred<GatewaySpendResult>();
    invoke.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const rendered = mount(<GatewaySessionSpend sessionId={A} />);
    rendered.render(<GatewaySessionSpend sessionId={B} />);
    await act(async () => a.resolve(sessionResult()));
    expect(rendered.container.textContent).not.toContain("$42.75");
    expect(rendered.container.textContent).toContain("Reading audit logs");
    await act(async () =>
      b.resolve(
        sessionResult({
          snapshot: { amountUsd: 8.5, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
        }),
      ),
    );
    expect(rendered.container.textContent).toContain("$8.50 USD");
    expect(invoke.mock.calls).toEqual([
      ["gatewaySpend.session", { sessionId: A }],
      ["gatewaySpend.session", { sessionId: B }],
    ]);
  });

  it("immediately clears a shown value on a same-ID file transition and fences its pending refresh", async () => {
    const oldRefresh = deferred<GatewaySpendResult>();
    const successor = deferred<GatewaySpendResult>();
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    await settle();
    invoke.mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(successor.promise);
    click(container, ".gateway-spend__refresh");
    act(() => changeFile(A, "/preview/successor.jsonl"));
    expect(container.textContent).not.toContain("$42.75");
    await act(async () => oldRefresh.resolve(sessionResult()));
    expect(container.textContent).not.toContain("$42.75");
    await act(async () => successor.resolve(sessionResult({ state: "pending", snapshot: null })));
    expect(container.textContent).toContain("Awaiting audit logs");
    expect(invoke.mock.calls).toEqual([
      ["gatewaySpend.session", { sessionId: A }],
      ["gatewaySpend.session", { sessionId: A, refresh: true }],
      ["gatewaySpend.session", { sessionId: A }],
    ]);
  });

  it("fences a predecessor even when file A → B → A is batched before React renders", async () => {
    const predecessor = deferred<GatewaySpendResult>();
    const successor = deferred<GatewaySpendResult>();
    invoke.mockReturnValueOnce(predecessor.promise).mockReturnValueOnce(successor.promise);
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    act(() => {
      changeFile(A, "/preview/b.jsonl");
      changeFile(A, "/preview/a.jsonl");
    });
    await act(async () => predecessor.resolve(sessionResult()));
    expect(container.textContent).not.toContain("$42.75");
    await act(async () =>
      successor.resolve(
        sessionResult({ state: "not_tracked", snapshot: null, trackedSince: null }),
      ),
    );
    expect(container.textContent).toContain("Not tracked");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("retires reads when a session disappears and the same renderer ID is recreated", async () => {
    const predecessor = deferred<GatewaySpendResult>();
    invoke.mockReturnValueOnce(predecessor.promise);
    const { container } = mount(<GatewaySessionSpend sessionId={A} />);
    act(() => {
      const sessions = new Map(useSessionsStore.getState().sessions);
      sessions.delete(A);
      useSessionsStore.setState({ sessions });
      useSessionsStore.getState().createSession(A, "/preview/workspace", "/preview/a.jsonl");
    });
    await settle();
    await act(async () =>
      predecessor.resolve(
        sessionResult({
          snapshot: { amountUsd: 999, pricedRequests: 1, unpricedRequests: 0, asOf: NOW },
        }),
      ),
    );
    expect(container.textContent).toContain("$42.75 USD");
    expect(container.textContent).not.toContain("$999");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
