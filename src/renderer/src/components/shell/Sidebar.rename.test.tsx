// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type {
  IntentEnvelope,
  IntentOutcome,
  RuntimeIdentity,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import { defaultSettings } from "@shared/settings.js";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRendererAuthorityState } from "../../stores/authority-reducer.js";
import { useOverlayStore } from "../../stores/overlay-store.js";
import { type SessionViewState, useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { Sidebar } from "./Sidebar.js";

const WS = "/repo";
const FILE = "/sessions/planning.jsonl";
const SID = "sidebar-rename" as SessionId;
const NAME = "Project planning";
const OWNER: RuntimeIdentity = { hostInstanceId: "rename-host", sessionEpoch: 1 };
let container: HTMLDivElement;
let unmount: (() => void) | undefined;
let receipt: "admitted" | "not_admitted" | "delivery_unknown" | "throw" | "throw_sync" = "admitted";

const summary: SessionSummary = {
  id: "planning",
  filePath: FILE,
  cwd: WS,
  preview: "A saved conversation",
  name: NAME,
  mtime: 1,
  lastActiveAt: 1,
  messageCount: 1,
};

async function invokeAsync(channel: string, payload?: Record<string, unknown>) {
  if (channel === "workspace.list" || channel === "themes.listUser") return [];
  if (channel === "workspace.listSessions") {
    return [
      { ...summary, name: useSessionsStore.getState().sessions.get(SID)?.sessionName ?? NAME },
    ];
  }
  if (channel === "session.dispatchIntent") {
    if (receipt === "throw") throw new Error("Synthetic IPC failure");
    return {
      status: receipt,
      intentId: payload?.intentId,
      ...(receipt === "not_admitted" ? { reason: "stale_owner" } : { owner: OWNER }),
    };
  }
  if (channel === "session.activate" || channel === "session.releaseActivationVisit") return {};
  if (channel === "gatewaySpend.month") {
    return {
      state: "not_configured",
      scope: "personal_gateway",
      source: "Datadog gateway audit logs",
      period: null,
      snapshot: null,
      trackedSince: null,
      stale: false,
      issue: null,
      nextRefreshAt: null,
    };
  }
  throw new Error(`Unexpected IPC channel ${channel}`);
}

const invoke = vi.fn((channel: string, payload?: Record<string, unknown>) => {
  if (channel === "session.dispatchIntent" && receipt === "throw_sync")
    throw new Error("Synthetic synchronous IPC failure");
  return invokeAsync(channel, payload);
});

function publish(
  outcomes: IntentOutcome[] = [],
  name = NAME,
  owner = OWNER,
  overrides: Partial<SessionViewState> = {},
): void {
  const store = useSessionsStore.getState();
  const session = store.sessions.get(SID)!;
  const snapshot: SemanticSnapshot = {
    owner,
    snapshotSequence: 1,
    capturedAt: 1,
    sdk: {
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
    },
    activity: {},
    queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
    custody: [],
    editor: { revision: 0, text: "", attachments: [] },
    activeIntents: [],
    recentIntentOutcomes: outcomes,
    recentObservedOperations: [],
    operationJournalLowWatermark: 0,
    operationJournalHighWatermark: 0,
    operationJournalTruncated: false,
    model: null,
    thinkingLevel: "off",
    sessionName: name,
    catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
  };
  useSessionsStore.setState({
    sessions: new Map(store.sessions).set(SID, {
      ...session,
      status: "ready",
      availability: "available",
      hostInstanceId: owner.hostInstanceId,
      sessionEpoch: owner.sessionEpoch,
      hasTreeHistory: true,
      sessionName: name,
      authorityProjection: {
        ...createRendererAuthorityState(),
        semantic: {
          state: "following",
          cursor: { ...owner, transportSequence: 1, snapshotSequence: 1 },
        },
        authoritativeSnapshot: snapshot,
      },
      ...overrides,
    }),
  });
}

async function mount(live = true): Promise<void> {
  const store = useSessionsStore.getState();
  store.addWorkspace(WS);
  store.setExpandedWorkspaces([WS]);
  store.setWorkspaceSessions(WS, [summary]);
  if (live) {
    store.createSession(SID, WS, FILE, NAME);
    publish();
    useSessionsStore.setState({ activeSessionId: SID, activeWorkspacePath: WS });
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    root.render(
      <StrictMode>
        <Sidebar onOpenSettings={() => {}} />
      </StrictMode>,
    );
  });
}

function row(): HTMLElement {
  return container.querySelector<HTMLElement>(`.sidebar__session[data-session-file="${FILE}"]`)!;
}

function editor(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[aria-label="Session name"]')!;
}

async function begin(): Promise<void> {
  await act(async () => {
    row().dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0, detail: 2 }),
    );
  });
}

function dispatches(): IntentEnvelope[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === "session.dispatchIntent")
    .map(([, payload]) => payload as IntentEnvelope);
}

async function fill(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      editor(),
      value,
    );
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  key: string,
  target: HTMLElement = editor(),
  options: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

function outcome(index = 0, state: IntentOutcome["state"] = "completed"): IntentOutcome {
  const envelope = dispatches()[index]!;
  return { intentId: envelope.intentId, owner: envelope.expectedOwner, kind: "rename", state };
}

function patch(overrides: Partial<SessionViewState>): void {
  const sessions = useSessionsStore.getState().sessions;
  useSessionsStore.setState({
    sessions: new Map(sessions).set(SID, { ...sessions.get(SID)!, ...overrides }),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  receipt = "admitted";
  invoke.mockClear();
  Object.assign(window, { pivis: { invoke } });
  useSessionsStore.setState({
    workspaces: new Map(),
    sessions: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
    expandedWorkspaces: [],
  });
  useSettingsStore.setState({ settings: structuredClone(defaultSettings), loaded: false });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = "";
  useSessionsStore.setState({
    workspaces: new Map(),
    sessions: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
    expandedWorkspaces: [],
  });
  useSettingsStore.setState({ settings: defaultSettings, loaded: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sidebar inline session rename", () => {
  it("double-clicks into a focused, selected name field without admitting a mutation", async () => {
    await mount();
    await begin();
    expect(editor()).not.toBeNull();
    expect(editor().value).toBe(NAME);
    expect(document.activeElement).toBe(editor());
    expect(editor().selectionStart).toBe(0);
    expect(editor().selectionEnd).toBe(NAME.length);
    expect(row().draggable).toBe(false);
    expect(dispatches()).toEqual([]);
    expect(useOverlayStore.getState().count).toBe(1);
  });

  it("keeps the same native row when a stored session becomes live between double-click events", async () => {
    await mount(false);
    const stored = row();
    await act(async () => {
      useSessionsStore.getState().createSession(SID, WS, FILE, NAME);
      publish();
    });
    expect(row()).toBe(stored);
    await act(async () => {
      stored.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
    });
    expect(editor().value).toBe(NAME);
    expect(document.activeElement).toBe(editor());
  });

  it("trims and dispatches once on Enter, waits for its authority outcome, and restores row focus", async () => {
    await mount();
    await begin();
    await fill("  Launch review  ");
    await press("Enter");
    await press("Enter");
    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]).toMatchObject({
      sessionId: SID,
      expectedOwner: OWNER,
      observedCursor: { ...OWNER, transportSequence: 1, snapshotSequence: 1 },
      intent: { kind: "rename", name: "Launch review" },
    });
    expect(editor().readOnly).toBe(true);
    expect(useSessionsStore.getState().sessions.get(SID)?.sessionName).toBe(NAME);
    await act(async () => publish([outcome()], "Launch review"));
    expect(editor()).toBeNull();
    expect(row().querySelector(".sidebar__session-name")?.textContent).toBe("Launch review");
    expect(document.activeElement).toBe(row());
    expect(row().draggable).toBe(true);
    expect(useOverlayStore.getState().count).toBe(0);
    expect(dispatches()).toHaveLength(1);
  });

  it("cancels an edit on Escape without blur-save, an interrupt or a metadata write", async () => {
    await mount();
    await begin();
    await fill("Not saved");
    const escapeEvent = await press("Escape");
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(row());
    expect(row().querySelector(".sidebar__session-name")?.textContent).toBe(NAME);
    expect(dispatches()).toEqual([]);
    expect(invoke.mock.calls.some(([channel]) => channel === "session.escape")).toBe(false);
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("offers F2 without changing pins, groups or workspace order", async () => {
    const settings = structuredClone(defaultSettings);
    settings.pinnedSessions = [FILE];
    settings.workspaceOrder = [WS];
    settings.sessionGroups = [
      {
        id: "research",
        workspacePath: WS,
        name: "Research",
        sessionFiles: [FILE],
        collapsed: false,
      },
    ];
    useSettingsStore.setState({ settings });
    await mount();
    await act(async () => row().focus());
    await press("F2", row());
    expect(editor().value).toBe(NAME);
    await fill("Renamed research");
    await press("Enter");
    await act(async () => publish([outcome()], "Renamed research"));
    expect(useSettingsStore.getState().settings).toEqual(settings);
    expect(row().classList.contains("sidebar__session--pinned")).toBe(true);
    expect(row().closest('[role="group"]')?.getAttribute("aria-label")).toBe("Research");
    expect(invoke.mock.calls.some(([channel]) => channel === "settings.set")).toBe(false);
  });

  it("does not mutate an unchanged name and keeps an empty draft editable with an error", async () => {
    await mount();
    await begin();
    await press("Enter");
    expect(editor()).toBeNull();
    expect(dispatches()).toEqual([]);
    await begin();
    await fill("   ");
    await press("Enter");
    expect(editor().value).toBe("   ");
    expect(editor().getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Enter a session name",
    );
    expect(dispatches()).toEqual([]);
    await fill("Recovered draft");
    expect(editor().getAttribute("aria-invalid")).toBeNull();
  });

  it("does not treat IME or modified Enter/Escape as save or cancel", async () => {
    await mount();
    await begin();
    await fill("A new name");
    for (const key of ["Enter", "Escape"]) {
      await press(key, editor(), { isComposing: true });
      await press(key, editor(), { keyCode: 229 });
      await press(key, editor(), { ctrlKey: true });
      expect(editor().value).toBe("A new name");
    }
    expect(dispatches()).toEqual([]);
  });

  it("does not start an editor from a row action or restart editing on an input double-click", async () => {
    await mount();
    const pin = row().querySelector<HTMLButtonElement>(".sidebar__session-pin")!;
    await act(async () =>
      pin.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 })),
    );
    await press("F2", pin);
    expect(editor()).toBeNull();
    await begin();
    await fill("My draft");
    const input = editor();
    await act(async () =>
      input.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 })),
    );
    expect(editor()).toBe(input);
    expect(input.value).toBe("My draft");
  });

  it("preserves a refused draft and requires a new explicit save to retry", async () => {
    receipt = "not_admitted";
    await mount();
    await begin();
    await fill("Retry me");
    await press("Enter");
    expect(editor().value).toBe("Retry me");
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("wasn't accepted");
    expect(dispatches()).toHaveLength(1);
    receipt = "admitted";
    await press("Enter");
    expect(dispatches()).toHaveLength(2);
    expect(dispatches()[1]?.intentId).not.toBe(dispatches()[0]?.intentId);
    await act(async () => publish([outcome(1)], "Retry me"));
    expect(editor()).toBeNull();
  });

  it.each(["delivery_unknown", "throw", "throw_sync"] as const)(
    "still accepts a terminal frame after %s without replaying",
    async (status) => {
      receipt = status;
      await mount();
      await begin();
      await fill("Frame confirmed");
      await press("Enter");
      expect(editor().readOnly).toBe(true);
      await act(async () => publish([outcome()], "Frame confirmed"));
      expect(editor()).toBeNull();
      expect(dispatches()).toHaveLength(1);
    },
  );

  it("ignores foreign-owner outcomes and never replays against a replacement owner", async () => {
    await mount();
    await begin();
    await fill("Keep this draft");
    await press("Enter");
    const successor = { hostInstanceId: "successor", sessionEpoch: 2 };
    await act(async () => publish([{ ...outcome(), owner: successor }]));
    expect(editor().readOnly).toBe(true);
    await act(async () => publish([], NAME, successor));
    expect(editor().value).toBe("Keep this draft");
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("wasn't confirmed");
    await act(async () => publish([], NAME, successor));
    const elsewhere = container.querySelector<HTMLButtonElement>(".sidebar__add-workspace")!;
    await act(async () => elsewhere.focus());
    expect(dispatches()).toHaveLength(1);
    await act(async () => editor().focus());
    await press("Enter");
    expect(dispatches()).toHaveLength(2);
    expect(dispatches()[1]?.expectedOwner).toEqual(successor);
  });

  it("keeps failed SDK outcomes editable without displaying raw host errors", async () => {
    await mount();
    await begin();
    await fill("Try again");
    await press("Enter");
    await act(async () =>
      publish([{ ...outcome(0, "failed"), error: "Synthetic internal error detail" }]),
    );
    expect(editor().value).toBe("Try again");
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't rename");
    expect(container.textContent).not.toContain("Synthetic internal error detail");
  });

  it("waits for initial following authority before dispatching a cold row's save", async () => {
    await mount();
    await act(async () =>
      patch({
        status: "cold",
        availability: "unavailable",
        authorityProjection: createRendererAuthorityState(),
      }),
    );
    await begin();
    await fill("Opened and renamed");
    await press("Enter");
    expect(dispatches()).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waiting for session…");
    await act(async () => publish());
    expect(dispatches()).toHaveLength(1);
    await act(async () => publish([outcome()], "Opened and renamed"));
    expect(editor()).toBeNull();
  });

  it("Escape cancels a cold save before admission and later readiness does not replay it", async () => {
    await mount();
    await act(async () =>
      patch({
        status: "cold",
        availability: "unavailable",
        authorityProjection: createRendererAuthorityState(),
      }),
    );
    await begin();
    await fill("Cancelled before ready");
    await press("Enter");
    await press("Escape");
    await act(async () => publish());
    expect(editor()).toBeNull();
    expect(dispatches()).toEqual([]);
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("bounds both initial-readiness and submitted-outcome waits without automatic retries", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () =>
      patch({
        status: "cold",
        availability: "unavailable",
        authorityProjection: createRendererAuthorityState(),
      }),
    );
    await begin();
    await fill("Timed draft");
    await press("Enter");
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });
    expect(editor().readOnly).toBe(false);
    expect(editor().value).toBe("Timed draft");
    await act(async () => publish());
    expect(dispatches()).toEqual([]);
    await press("Enter");
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("wasn't confirmed");
    expect(dispatches()).toHaveLength(1);
  });

  it("does not rename a different file adopted by the same renderer session", async () => {
    await mount();
    await act(async () =>
      patch({
        status: "cold",
        availability: "unavailable",
        authorityProjection: createRendererAuthorityState(),
      }),
    );
    await begin();
    await fill("Old file only");
    await press("Enter");
    await act(async () =>
      publish([], "Different session", OWNER, { sessionFile: "/sessions/different.jsonl" }),
    );
    expect(dispatches()).toEqual([]);
    expect(useSessionsStore.getState().sessions.get(SID)?.sessionName).toBe("Different session");
  });

  it("commits on blur once, but late completion never takes focus from another control", async () => {
    await mount();
    await begin();
    await fill("Background confirmation");
    const elsewhere = container.querySelector<HTMLButtonElement>(".sidebar__add-workspace")!;
    await act(async () => elsewhere.focus());
    expect(dispatches()).toHaveLength(1);
    expect(useOverlayStore.getState().count).toBe(0);
    await act(async () => publish([outcome()], "Background confirmation"));
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("retires a collapsed row's waiting edit so revealing it does not reopen or submit it", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        sessionGroups: [
          {
            id: "research",
            workspacePath: WS,
            name: "Research",
            sessionFiles: [FILE],
            collapsed: false,
          },
        ],
      },
    });
    await mount();
    await act(async () =>
      patch({
        status: "cold",
        availability: "unavailable",
        authorityProjection: createRendererAuthorityState(),
      }),
    );
    await begin();
    await fill("Hidden draft");
    await press("Enter");
    await act(async () => {
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          sessionGroups: useSettingsStore
            .getState()
            .settings.sessionGroups.map((group) => ({ ...group, collapsed: true })),
        },
      });
    });
    expect(editor()).toBeNull();
    await act(async () => {
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          sessionGroups: useSettingsStore
            .getState()
            .settings.sessionGroups.map((group) => ({ ...group, collapsed: false })),
        },
      });
      publish();
    });
    expect(editor()).toBeNull();
    expect(dispatches()).toEqual([]);
    expect(useOverlayStore.getState().count).toBe(0);
  });

  it("a late group reparent retires the editor without taking focus from another control", async () => {
    const settings = structuredClone(defaultSettings);
    settings.sessionGroups = [
      {
        id: "research",
        workspacePath: WS,
        name: "Research",
        sessionFiles: [FILE],
        collapsed: false,
      },
      { id: "launch", workspacePath: WS, name: "Launch", sessionFiles: [], collapsed: false },
    ];
    useSettingsStore.setState({ settings });
    await mount();
    await begin();
    await fill("Still the same session");
    await press("Enter");
    const elsewhere = container.querySelector<HTMLButtonElement>(".sidebar__add-workspace")!;
    await act(async () => elsewhere.focus());
    // A previously queued membership save/rollback can move the row after a
    // newer rename gesture. Remounting is not a new request to take focus.
    await act(async () => {
      useSettingsStore.setState({
        settings: {
          ...settings,
          sessionGroups: settings.sessionGroups.map((group) => ({
            ...group,
            sessionFiles: group.id === "launch" ? [FILE] : [],
          })),
        },
      });
    });
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(useOverlayStore.getState().count).toBe(0);
    await act(async () => publish([outcome()], "Still the same session"));
    expect(row().querySelector(".sidebar__session-name")?.textContent).toBe(
      "Still the same session",
    );
    expect(document.activeElement).toBe(elsewhere);
    expect(dispatches()).toHaveLength(1);
  });
});
