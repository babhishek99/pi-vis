// @vitest-environment jsdom
import type { GatewaySpendResult } from "@shared/gateway-spend.js";
import type { SessionId } from "@shared/ids.js";
import type { SessionStats } from "@shared/pi-protocol/responses.js";
import { type ReactElement, act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { createTranscriptState } from "../../stores/transcript.js";
import { ContextMeter } from "./ContextMeter.js";

const sessionId = "s-context" as SessionId;

function mount(node: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(node));
  });
  return {
    container,
    unmount: () => {
      act(() => {
        flushSync(() => root.unmount());
      });
      document.body.removeChild(container);
    },
  };
}

function setStats(stats: SessionStats): void {
  const session = {
    sessionId,
    workspacePath: "/tmp/project",
    status: "ready",
    transcript: createTranscriptState(),
    availability: "unavailable",
    sessionEpoch: 0,
    editorRevision: 0,
    turnErrored: false,
    pendingDialogs: [],
    statusSegments: new Map(),
    widgets: new Map(),
    toasts: [],
    availableModels: [],
    commands: [],
    resumed: false,
    modelInitialized: true,
    stats,
  } as unknown as SessionViewState;

  useSessionsStore.setState({ sessions: new Map([[sessionId, session]]) });
}

function openDropdown(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>(".context-ring");
  expect(button).toBeTruthy();
  act(() => button!.click());
}

const disabledSpend: GatewaySpendResult = {
  state: "not_configured",
  scope: "direct_session_partial",
  source: "Datadog gateway audit logs",
  period: null,
  snapshot: null,
  trackedSince: null,
  stale: false,
  issue: null,
  nextRefreshAt: null,
};

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const stats = {
  sessionId,
  tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
  contextUsage: { tokens: 125, contextWindow: 1000, percent: 12.5 },
} satisfies SessionStats;

let invoke = vi.fn();

describe("ContextMeter", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    invoke = vi.fn().mockResolvedValue(disabledSpend);
    Object.defineProperty(window, "pivis", {
      configurable: true,
      writable: true,
      value: { invoke },
    });
  });

  afterEach(() => {
    useSessionsStore.setState({ sessions: new Map() });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("shows cache rows only when the values are non-zero, in the expected order", () => {
    setStats({
      sessionId,
      tokens: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, total: 175 },
      contextUsage: { tokens: 175, contextWindow: 1000, percent: 17.5 },
    });

    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);

    expect(
      [...container.querySelectorAll(".context-dropdown__row dt")].map((el) => el.textContent),
    ).toEqual(["Input", "Output", "Cache read", "Cache hit rate"]);
    expect(container.textContent).not.toContain("Cache write");
    unmount();
  });

  it("includes cache write when it is non-zero", () => {
    setStats({
      sessionId,
      tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 40, total: 165 },
      contextUsage: { tokens: 165, contextWindow: 1000, percent: 16.5 },
    });

    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);

    expect(
      [...container.querySelectorAll(".context-dropdown__row dt")].map((el) => el.textContent),
    ).toEqual(["Input", "Output", "Cache write"]);
    expect(container.textContent).not.toContain("Cache read");
    expect(container.textContent).not.toContain("Cache hit rate");
    unmount();
  });

  it("toggles closed on a second trigger click when the title-bar mousedown is retargeted", () => {
    setStats({
      sessionId,
      tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
      contextUsage: { tokens: 125, contextWindow: 1000, percent: 12.5 },
    });

    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    const button = container.querySelector<HTMLButtonElement>(".context-ring");
    expect(button).toBeTruthy();
    openDropdown(container);
    expect(container.querySelector(".context-dropdown")).toBeTruthy();

    const retargetedMouseDown = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(retargetedMouseDown, "composedPath", {
      value: () => [button, button!.parentElement, container, document.body, document, window],
    });
    act(() => {
      document.dispatchEvent(retargetedMouseDown);
      button!.click();
    });

    expect(button!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".context-dropdown")).toBeNull();
    unmount();
  });

  it("reads direct-session spend only on open and hides the config-disabled section", async () => {
    setStats(stats);
    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    openDropdown(container);
    await settle();
    expect(invoke.mock.calls).toEqual([["gatewaySpend.session", { sessionId }]]);
    expect(container.querySelector(".gateway-session-spend")).toBeNull();
    act(() => setStats({ ...stats, tokens: { ...stats.tokens, output: 50 } }));
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    openDropdown(container); // Close.
    openDropdown(container); // A new open is a new read, never a background poll.
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps gateway-recorded USD separate from token stats and returns focus on Escape", async () => {
    invoke.mockResolvedValue({
      ...disabledSpend,
      state: "ready",
      snapshot: {
        amountUsd: 1.25,
        pricedRequests: 3,
        unpricedRequests: 0,
        asOf: "2026-10-15T12:00:00.000Z",
      },
      trackedSince: "2026-10-15T11:00:00.000Z",
    } satisfies GatewaySpendResult);
    setStats(stats);
    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);
    await settle();
    expect(container.querySelector(".gateway-session-spend")?.textContent).toContain("$1.25 USD");
    expect(container.querySelector(".gateway-session-spend")?.textContent).toContain("Partial");
    expect(useSessionsStore.getState().sessions.get(sessionId)?.stats).toEqual(stats);
    const refresh = container.querySelector<HTMLButtonElement>(".gateway-spend__refresh")!;
    refresh.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector(".context-dropdown")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".context-ring"));
    unmount();
  });

  it("retires an outstanding read on close so it cannot paint a reopened card", async () => {
    let resolveOld!: (value: GatewaySpendResult) => void;
    let resolveNew!: (value: GatewaySpendResult) => void;
    invoke
      .mockReturnValueOnce(
        new Promise<GatewaySpendResult>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<GatewaySpendResult>((resolve) => {
          resolveNew = resolve;
        }),
      );
    setStats(stats);
    const { container, unmount } = mount(<ContextMeter sessionId={sessionId} />);
    openDropdown(container);
    openDropdown(container);
    openDropdown(container);
    await act(async () =>
      resolveOld({
        ...disabledSpend,
        state: "ready",
        snapshot: {
          amountUsd: 999,
          pricedRequests: 1,
          unpricedRequests: 0,
          asOf: "2026-10-15T12:00:00.000Z",
        },
      }),
    );
    expect(container.textContent).not.toContain("$999");
    expect(container.textContent).toContain("Reading audit logs");
    await act(async () => resolveNew({ ...disabledSpend, state: "not_tracked" }));
    expect(container.textContent).toContain("Not tracked");
    expect(invoke).toHaveBeenCalledTimes(2);
    unmount();
  });
});
