// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import {
  activityAgent,
  activitySnapshot,
  activityWorkflow,
} from "@shared/pi-protocol/__fixtures__/subagent-activity.js";
import type { SessionQueryEnvelope } from "@shared/pi-protocol/runtime-state.js";
import type { SubagentActivityResult } from "@shared/pi-protocol/subagent-activity.js";
import { type ReactElement, act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalEscapeInterrupt } from "../../hooks/useGlobalEscapeInterrupt.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { AgentTray } from "./AgentTray.js";

const a = "tray-a" as SessionId;
const b = "tray-b" as SessionId;
const originalAbort = useSessionsStore.getState().abortSession;
let abort = vi.fn();
let invoke = vi.fn();
let supplied: (request: SessionQueryEnvelope) => Promise<SubagentActivityResult>;
const cleanup: (() => void)[] = [];

function session(id: SessionId, host = `host-${id}`, available = true): SessionViewState {
  return {
    sessionId: id,
    status: "ready",
    availability: available ? "available" : "unavailable",
    hostInstanceId: host,
    sessionEpoch: 0,
    authorityProjection: {
      semantic: { state: available ? "following" : "synchronizing" },
      authoritativeSnapshot: { owner: { hostInstanceId: host, sessionEpoch: 0 } },
    },
  } as SessionViewState;
}

function Harness({ id }: { id: SessionId }): ReactElement {
  useGlobalEscapeInterrupt();
  const current = useSessionsStore((state) => state.sessions.get(id));
  const observation =
    current?.availability === "available" &&
    current.authorityProjection?.semantic.state === "following"
      ? { owner: current.authorityProjection.authoritativeSnapshot!.owner }
      : undefined;
  return <AgentTray key={id} sessionId={id} observation={observation} />;
}

function mount(id = a): { render: (id: SessionId) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (id: SessionId): void => {
    act(() => flushSync(() => root.render(<Harness id={id} />)));
  };
  render(id);
  cleanup.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { render };
}

function button(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".agent-tray__trigger")!;
}
function open(): void {
  act(() => {
    button().focus();
    button().click();
  });
}
function card(): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>(".agent-tray__card");
}
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function dispatchEscape(options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => window.dispatchEvent(event));
  return event;
}
function select(id: SessionId, host = `host-${id}`, available = true): void {
  act(() =>
    useSessionsStore.setState((state) => ({
      activeSessionId: id,
      sessions: new Map(state.sessions).set(id, session(id, host, available)),
    })),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  abort = vi.fn(async () => {});
  supplied = async () => ({ status: "ready", snapshot: activitySnapshot() });
  invoke = vi.fn(async (channel: string, request: SessionQueryEnvelope) => {
    expect(channel).toBe("session.query");
    expect(request.query).toEqual({ type: "get_subagent_activity" });
    const data = await supplied(request);
    return {
      status: "ok",
      owner: request.expectedOwner,
      queryId: request.queryId,
      queryType: request.query.type,
      response: { type: "response", command: request.query.type, success: true, data },
    };
  });
  Object.defineProperty(window, "pivis", { configurable: true, writable: true, value: { invoke } });
  useSessionsStore.setState({
    activeSessionId: a,
    sessions: new Map([
      [a, session(a)],
      [b, session(b)],
    ]),
    abortSession: abort,
  });
});

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  useSessionsStore.setState({
    sessions: new Map(),
    activeSessionId: null,
    abortSession: originalAbort,
  });
  useOverlayStore.setState({ claims: [], count: 0 });
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("compact active-tab agent tray", () => {
  it("shows exact read counts, actual nested/workflow ownership, task summaries and cleanup", async () => {
    const snapshot = activitySnapshot(
      [
        activityAgent("outer", { name: "route-audit", workflowId: "wf-own", phase: "Inspect" }),
        activityAgent("nested", {
          name: "nested-check",
          parentAgentId: "outer",
          state: "unwinding",
          status: "stopped",
        }),
        activityAgent("wf-own:call-2", {
          recordId: null,
          workflowId: "wf-own",
          state: "queued",
          status: "queued",
        }),
        activityAgent("done", { state: "finished", status: "completed" }),
      ],
      [activityWorkflow("wf-own")],
    );
    snapshot.unwindingOperations = true;
    supplied = async () => ({ status: "ready", snapshot });
    const before = useSessionsStore.getState().sessions.get(a);
    mount();
    await settle();
    expect(button().textContent).toBe("31 flow");
    open();
    expect(card()?.textContent).toContain(
      "1 running · 0 starting · 1 queued · 1 unwinding · 1 finished",
    );
    expect(
      card()?.querySelector(
        '[data-activity-id="wf-own"] [data-activity-id="outer"] [data-activity-id="nested"]',
      ),
    ).toBeTruthy();
    expect(card()?.querySelector('[data-activity-id="outer"] .agent-tray__task')?.textContent).toBe(
      "Inspect route definitions",
    );
    expect(card()?.textContent).toContain("Cleanup pending");
    expect(card()?.textContent).toContain("Phase: Inspect");
    expect(card()?.querySelector('[data-activity-id="done"] .spinner')).toBeNull();
    expect(useSessionsStore.getState().sessions.get(a)).toBe(before);
    expect(abort).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "unsupported", "failed"] as const)(
    "does not turn %s support into zero agents",
    async (status) => {
      supplied = async () => ({ status });
      mount();
      await settle();
      expect(button().textContent).toBe("?");
      open();
      expect(card()?.textContent).toContain("Unknown does not mean no agents.");
      expect(card()?.querySelector("[data-activity-id]")).toBeNull();
      expect(card()?.querySelector("button[aria-label='Close agent tray']")).toBeTruthy();
    },
  );

  it("dismisses only its newest normal Escape claim, then permits the next bare Escape to interrupt", async () => {
    mount();
    await settle();
    open();
    expect(useOverlayStore.getState().count).toBe(1);
    for (const options of [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
    ]) {
      dispatchEscape(options);
      expect(card()).toBeTruthy();
    }
    const newer = useOverlayStore.getState()._acquire();
    expect(dispatchEscape().defaultPrevented).toBe(false);
    expect(card()).toBeTruthy();
    useOverlayStore.getState()._release(newer);
    expect(dispatchEscape().defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(abort).not.toHaveBeenCalled();
    expect(useOverlayStore.getState().count).toBe(0);
    dispatchEscape();
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(a);
  });

  it("closes on outside focus without stealing it or interrupting work", async () => {
    mount();
    await settle();
    open();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(abort).not.toHaveBeenCalled();
  });

  it("hides predecessor rows immediately on synchronization loss and fences delayed predecessor replies", async () => {
    let release!: (value: SubagentActivityResult) => void;
    supplied = (request) =>
      request.expectedOwner.hostInstanceId === "host-tray-a"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({
            status: "ready",
            snapshot: activitySnapshot([activityAgent("new-owner")]),
          });
    mount();
    open();
    select(a, "successor");
    await settle();
    expect(card()?.textContent).toContain("new-owner");
    release({ status: "ready", snapshot: activitySnapshot([activityAgent("old-owner")]) });
    await settle();
    expect(card()?.textContent).not.toContain("old-owner");
    select(a, "successor", false);
    expect(button().textContent).toBe("?");
    expect(card()?.textContent).toContain("synchronizes");
    expect(card()?.textContent).not.toContain("new-owner");
    let next!: (value: SubagentActivityResult) => void;
    supplied = () =>
      new Promise((resolve) => {
        next = resolve;
      });
    select(a, "successor", true);
    expect(button().textContent).toBe("?");
    await settle();
    expect(card()?.textContent).toContain("Checking agent activity");
    next({ status: "ready", snapshot: activitySnapshot() });
    await settle();
    expect(button().textContent).toBe("0");
  });

  it("does not reuse a prior tab visit or apply A's delayed result after A→B→A", async () => {
    let release!: (value: SubagentActivityResult) => void;
    let firstA = true;
    supplied = (request) => {
      if (request.sessionId === a && firstA) {
        firstA = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve({
        status: "ready",
        snapshot: activitySnapshot([activityAgent(request.sessionId)]),
      });
    };
    const root = mount();
    select(b);
    root.render(b);
    await settle();
    open();
    expect(card()?.textContent).toContain(b);
    expect(card()?.textContent).not.toContain(a);
    select(a);
    root.render(a);
    await settle();
    open();
    release({ status: "ready", snapshot: activitySnapshot([activityAgent("retired-visit")]) });
    await settle();
    expect(card()?.textContent).toContain(a);
    expect(card()?.textContent).not.toContain("retired-visit");
  });

  it.each(["tab", "availability", "semantic"] as const)(
    "retires reads across a coalesced %s cut, even when the final owner is unchanged",
    async (boundary) => {
      let release!: (value: SubagentActivityResult) => void;
      let first = true;
      supplied = () => {
        if (first) {
          first = false;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({
          status: "ready",
          snapshot: activitySnapshot([activityAgent("fresh-visit")]),
        });
      };
      mount();
      open();
      const before = useSessionsStore.getState();
      act(() => {
        if (boundary === "tab") useSessionsStore.setState({ activeSessionId: b });
        else {
          const prior = before.sessions.get(a)!;
          const fenced =
            boundary === "availability"
              ? { ...prior, availability: "unavailable" as const }
              : {
                  ...prior,
                  authorityProjection: {
                    ...prior.authorityProjection!,
                    semantic: { state: "synchronizing" as const },
                  },
                };
          useSessionsStore.setState({
            sessions: new Map(before.sessions).set(a, fenced as SessionViewState),
          });
        }
        useSessionsStore.setState({ activeSessionId: a, sessions: before.sessions });
      });
      await settle();
      expect(invoke).toHaveBeenCalledTimes(2);
      release({ status: "ready", snapshot: activitySnapshot([activityAgent("retired-read")]) });
      await settle();
      expect(card()?.textContent).toContain("fresh-visit");
      expect(card()?.textContent).not.toContain("retired-read");
    },
  );

  it("polls serially, distinguishes a failed read from an empty fleet, and retires timers", async () => {
    vi.useFakeTimers();
    let release!: (value: SubagentActivityResult) => void;
    supplied = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(invoke).toHaveBeenCalledOnce();
    release({ status: "ready", snapshot: activitySnapshot([activityAgent("live")]) });
    await settle();
    expect(button().textContent).toBe("1");
    supplied = async () => ({ status: "failed" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(button().textContent).toBe("?");
    select(b);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("shows truncation, missing ancestors and omitted-row counts without fabricating a parent", async () => {
    const value = activitySnapshot([
      activityAgent("child", { parentAgentId: "missing", detailsTruncated: true }),
    ]);
    value.omitted.agents = 5;
    value.agentCounts.finished = 5;
    supplied = async () => ({ status: "ready", snapshot: value });
    mount();
    await settle();
    open();
    expect(card()?.textContent).toContain("Parent not in snapshot");
    expect(card()?.textContent).toContain("Name or summary shortened");
    expect(card()?.textContent).toContain("Not shown: 5 agents, 0 workflows");
    expect(card()?.querySelectorAll("[data-activity-id]")).toHaveLength(1);
  });
});
