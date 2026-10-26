// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachResponse,
  RuntimeIdentity,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import { type ReactElement, act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_GENERATION } from "../../lib/renderer-generation.js";
import { createRendererAuthorityState } from "../../stores/authority-reducer.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { LIVE_SHELL_REPLAY_LIMIT, createTranscriptState } from "../../stores/transcript.js";

interface MockTerminalLike {
  buffer: {
    active: {
      type: "normal" | "alternate";
      baseY: number;
      cursorY: number;
      viewportY: number;
    };
  };
  textarea?: HTMLTextAreaElement;
  selection: string;
  writes: string[];
  rows: number;
  cols: number;
  resizeCalls: Array<{ cols: number; rows: number }>;
  scrollToBottomCalls: number;
  disposed: boolean;
  emitData: (data: string) => void;
  emitScroll: () => void;
  emitWriteParsed: () => void;
  input: (data: string) => void;
  dispatchKey: (event: KeyboardEvent) => boolean;
}

const xtermMock = vi.hoisted(() => ({
  instances: [] as MockTerminalLike[],
  proposedCols: 120,
}));

vi.mock("@xterm/xterm", () => {
  class Terminal implements MockTerminalLike {
    buffer = {
      active: {
        type: "normal" as const,
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
      },
    };
    options: Record<string, unknown>;
    rows = 1;
    cols = 80;
    textarea?: HTMLTextAreaElement;
    selection = "";
    writes: string[] = [];
    resizeCalls: Array<{ cols: number; rows: number }> = [];
    scrollToBottomCalls = 0;
    disposed = false;
    private dataListeners: Array<(data: string) => void> = [];
    private parsedListeners: Array<() => void> = [];
    private scrollListeners: Array<(position: number) => void> = [];
    private keyHandler: (event: KeyboardEvent) => boolean = () => true;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermMock.instances.push(this);
    }

    loadAddon(): void {}

    open(container: HTMLElement): void {
      this.textarea = document.createElement("textarea");
      container.appendChild(this.textarea);
    }

    focus(): void {
      this.textarea?.focus();
    }

    input(data: string): void {
      this.emitData(data);
    }

    write(data: string, callback?: () => void): void {
      this.writes.push(data);
      callback?.();
    }

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
      this.resizeCalls.push({ cols, rows });
    }

    onData(listener: (data: string) => void): { dispose: () => void } {
      this.dataListeners.push(listener);
      return { dispose: () => this.removeListener(this.dataListeners, listener) };
    }

    onWriteParsed(listener: () => void): { dispose: () => void } {
      this.parsedListeners.push(listener);
      return { dispose: () => this.removeListener(this.parsedListeners, listener) };
    }

    onScroll(listener: (position: number) => void): { dispose: () => void } {
      this.scrollListeners.push(listener);
      return { dispose: () => this.removeListener(this.scrollListeners, listener) };
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler;
    }

    hasSelection(): boolean {
      return this.selection.length > 0;
    }

    getSelection(): string {
      return this.selection;
    }

    scrollToBottom(): void {
      this.scrollToBottomCalls += 1;
      this.buffer.active.viewportY = this.buffer.active.baseY;
      this.emitScroll();
    }

    dispose(): void {
      this.disposed = true;
      this.dataListeners = [];
      this.parsedListeners = [];
      this.scrollListeners = [];
      this.textarea?.remove();
    }

    emitData(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }

    emitWriteParsed(): void {
      for (const listener of this.parsedListeners) listener();
    }

    emitScroll(): void {
      for (const listener of this.scrollListeners) listener(this.buffer.active.viewportY);
    }

    dispatchKey(event: KeyboardEvent): boolean {
      return this.keyHandler(event);
    }

    private removeListener<T>(listeners: T[], listener: T): void {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  }

  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: xtermMock.proposedCols, rows: 24 };
    }
  },
}));

import { ShellTerminalHost } from "./ShellTerminalHost.js";

const SESSION_ID = "shell-terminal-session" as SessionId;
const OWNER: RuntimeIdentity = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  sessionEpoch: 4,
};

type InvokeMock = ReturnType<typeof vi.fn>;

const mounted: Array<() => void> = [];

function snapshot(executionId: string, mode: "compact" | "fullscreen"): SemanticSnapshot {
  return {
    owner: OWNER,
    snapshotSequence: 1,
    capturedAt: Date.now(),
    sdk: {
      isStreaming: false,
      isIdle: false,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: true,
    },
    activity: {
      bash: {
        kind: "bash",
        state: "active",
        intentId: executionId,
        command: `command-${executionId}`,
        startedAt: Date.now(),
        pty: true,
        inputReady: true,
        terminalMode: mode,
      },
    },
    queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
    custody: [],
    editor: { revision: 0, text: "", attachments: [] },
    activeIntents: [],
    recentIntentOutcomes: [],
    recentObservedOperations: [],
    operationJournalLowWatermark: 0,
    operationJournalHighWatermark: 0,
    operationJournalTruncated: false,
    model: null,
    thinkingLevel: "off",
    catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
  };
}

function setExecution(
  executionId: string,
  mode: "compact" | "fullscreen" = "compact",
  inputAcknowledgedThrough = 0,
  liveReplayTruncated = false,
): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID);
    if (!session) return {};
    const cursor = {
      ...OWNER,
      transportSequence: 1,
      snapshotSequence: 1,
    };
    const authorityProjection = {
      ...createRendererAuthorityState(),
      owner: OWNER,
      semantic: { state: "following" as const, cursor },
      transcript: { state: "following" as const, cursor },
      extensionUi: { state: "following" as const, cursor },
      authoritativeSnapshot: snapshot(executionId, mode),
    };
    sessions.set(SESSION_ID, {
      ...session,
      availability: "available",
      authorityProjection,
      transcript: {
        ...createTranscriptState(),
        blocks: [
          {
            id: `bash-${executionId}`,
            type: "bash",
            data: {
              executionId,
              command: `command-${executionId}`,
              outputText: "",
              terminalOutput: "> ",
              terminalReconstructionSequence: 1,
              terminalOutputSequence: 1,
              terminalOutputChunks: [],
              terminalOutputChunkChars: 0,
              liveReplayTruncated,
              terminalMode: mode,
              inputAcknowledgedThrough,
              resizeRevision: 0,
              pty: true,
              isStreaming: true,
              startedAt: Date.now(),
            },
          },
        ],
      },
    });
    return { sessions };
  });
}

function setTerminalMode(mode: "compact" | "fullscreen"): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID);
    const projection = session?.authorityProjection;
    const snapshot = projection?.authoritativeSnapshot;
    if (!session || !projection || !snapshot?.activity.bash) return {};
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...projection,
        authoritativeSnapshot: {
          ...snapshot,
          activity: {
            ...snapshot.activity,
            bash: { ...snapshot.activity.bash, terminalMode: mode },
          },
        },
      },
      transcript: {
        ...session.transcript,
        blocks: session.transcript.blocks.map((block) =>
          block.type === "bash" ? { ...block, data: { ...block.data, terminalMode: mode } } : block,
        ),
      },
    });
    return { sessions };
  });
}

function setTerminalChunks(
  terminalOutputSequence: number,
  terminalOutputChunks: Array<{
    sequence: number;
    data: string;
    truncated?: boolean;
  }> = [],
): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID);
    if (!session) return {};
    sessions.set(SESSION_ID, {
      ...session,
      transcript: {
        ...session.transcript,
        blocks: session.transcript.blocks.map((block) =>
          block.type === "bash"
            ? {
                ...block,
                data: {
                  ...block.data,
                  terminalOutputSequence,
                  terminalOutputChunks,
                  terminalOutputChunkChars: terminalOutputChunks.reduce(
                    (chars, chunk) => chars + chunk.data.length,
                    0,
                  ),
                },
              }
            : block,
        ),
      },
    });
    return { sessions };
  });
}

function fenceTranscriptAuthority(): void {
  useSessionsStore.setState((state) => {
    const sessions = new Map(state.sessions);
    const session = sessions.get(SESSION_ID);
    const projection = session?.authorityProjection;
    if (!session || !projection || projection.transcript.state !== "following") return {};
    sessions.set(SESSION_ID, {
      ...session,
      authorityProjection: {
        ...projection,
        transcript: {
          state: "synchronizing",
          lastCursor: projection.transcript.cursor,
          reason: "test_gap",
        },
      },
    });
    return { sessions };
  });
}

function installExecution(): void {
  useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
  useSessionsStore.getState().createSession(SESSION_ID, "/workspace", "/workspace/session.jsonl");
  setExecution("shell-1");
  useSessionsStore.setState({ activeSessionId: SESSION_ID });
}

function installPivis(
  shellInput: (input: Record<string, unknown>) => Promise<unknown> = async (input) => ({
    accepted: true,
    acknowledgedThrough: input.sequence,
  }),
  authorityAttach?: () => Promise<AuthorityAttachResponse>,
  shellReconstructionAck: (input: Record<string, unknown>) => Promise<unknown> = async () => ({
    accepted: true,
  }),
  shellResize: (input: Record<string, unknown>) => Promise<unknown> = async () => ({
    accepted: true,
  }),
): InvokeMock {
  let attachSnapshotSequence = 1;
  const invoke = vi.fn(async (channel: string, input: Record<string, unknown>) => {
    if (channel === "session.shellInput") return shellInput(input);
    if (channel === "session.authorityAttach") {
      return authorityAttach?.() ?? currentShellAttach(++attachSnapshotSequence);
    }
    if (channel === "session.shellReconstructionAck") return shellReconstructionAck(input);
    if (channel === "session.shellResize") return shellResize(input);
    return undefined;
  });
  Object.defineProperty(window, "pivis", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}) },
  });
  return invoke;
}

function readyShellAttach(
  outputThroughSequence: number,
  ansi: string,
  options: {
    executionId?: string;
    mode?: "compact" | "fullscreen";
    inputAcknowledgedThrough?: number;
    resizeRevision?: number;
    reconstructionFenceToken?: number;
    replayTruncated?: boolean;
    snapshotSequence?: number;
  } = {},
): Extract<AuthorityAttachResponse, { status: "ready" }> {
  const executionId = options.executionId ?? "shell-1";
  const mode = options.mode ?? "compact";
  const semantic = snapshot(executionId, mode);
  semantic.snapshotSequence = options.snapshotSequence ?? 2;
  const cursor = {
    ...OWNER,
    transportSequence: 2,
    snapshotSequence: semantic.snapshotSequence,
  };
  return {
    status: "ready",
    baseline: {
      sessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
      owner: OWNER,
      semantic: { sync: { state: "following", cursor }, snapshot: semantic },
      operationJournal: [],
      restorations: [],
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
        currentShellTurn: {
          id: executionId,
          command: `command-${executionId}`,
          owner: OWNER,
          startedAt: 1_786_000_000_100,
          cols: 80,
          rows: 8,
          mode,
          ansi,
          outputThroughSequence,
          reconstructionFenceToken: options.reconstructionFenceToken ?? semantic.snapshotSequence,
          inputAcknowledgedThrough: options.inputAcknowledgedThrough ?? 0,
          resizeRevision: options.resizeRevision ?? 0,
          ...(options.replayTruncated ? { replayTruncated: true } : {}),
        },
      },
      extensionUi: {
        sync: { state: "following", cursor },
        notifications: [],
        statuses: {},
        widgets: {},
        dialogs: [],
      },
      panels: [],
      publicationHighWatermark: 0,
    },
    replay: [],
  };
}

function currentShellAttach(snapshotSequence: number): AuthorityAttachResponse {
  const session = useSessionsStore.getState().sessions.get(SESSION_ID);
  const block = session?.transcript.blocks.find(
    (candidate) => candidate.type === "bash" && candidate.data.isStreaming,
  );
  if (block?.type !== "bash" || !block.data.executionId) {
    return { status: "unavailable", reason: "no active shell" };
  }
  const reconstructionSequence =
    block.data.terminalReconstructionSequence ?? block.data.terminalOutputSequence ?? 0;
  const outputThroughSequence = block.data.terminalOutputSequence ?? reconstructionSequence;
  const retainedTail = (block.data.terminalOutputChunks ?? [])
    .filter(
      (chunk) => chunk.sequence > reconstructionSequence && chunk.sequence <= outputThroughSequence,
    )
    .map((chunk) => chunk.data)
    .join("");
  return readyShellAttach(
    outputThroughSequence,
    `${block.data.terminalOutput ?? ""}${retainedTail}`,
    {
      executionId: block.data.executionId,
      ...(block.data.terminalMode !== undefined ? { mode: block.data.terminalMode } : {}),
      ...(block.data.inputAcknowledgedThrough !== undefined
        ? { inputAcknowledgedThrough: block.data.inputAcknowledgedThrough }
        : {}),
      ...(block.data.resizeRevision !== undefined
        ? { resizeRevision: block.data.resizeRevision }
        : {}),
      ...(block.data.liveReplayTruncated !== undefined
        ? { replayTruncated: block.data.liveReplayTruncated }
        : {}),
      snapshotSequence,
    },
  );
}

function mount(node: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  mounted.push(() => {
    act(() => flushSync(() => root.unmount()));
    container.remove();
  });
  return container;
}

async function requestShellAttach(sessionId: SessionId): Promise<void> {
  const response = await window.pivis.invoke("session.authorityAttach", {
    sessionId,
    rendererGeneration: RENDERER_GENERATION,
  });
  if (response.status === "ready") {
    useSessionsStore.getState().applyAuthorityAttach(sessionId, response);
  }
}

function shellTerminalHost(
  requestAttach: (sessionId: SessionId, force?: boolean) => Promise<void> = requestShellAttach,
): ReactElement {
  return <ShellTerminalHost sessionId={SESSION_ID} requestAttach={requestAttach} />;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function shellInputCalls(invoke: InvokeMock): Array<Record<string, unknown>> {
  return invoke.mock.calls
    .filter(([channel]) => channel === "session.shellInput")
    .map(([, input]) => input as Record<string, unknown>);
}

function terminalAt(index = 0): MockTerminalLike {
  const terminal = xtermMock.instances[index];
  if (!terminal) throw new Error(`Expected xterm instance ${index}`);
  return terminal;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  xtermMock.instances.length = 0;
  xtermMock.proposedCols = 120;
  installExecution();
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ShellTerminalHost", () => {
  it("consumes a newly installed cold-restore keyframe without a redundant attach", async () => {
    const invoke = installPivis();
    act(() => {
      useSessionsStore.getState().applyAuthorityAttach(
        SESSION_ID,
        readyShellAttach(1, "\u001b[2J\u001b[Hrestored> ", {
          reconstructionFenceToken: 17,
        }),
      );
    });

    mount(shellTerminalHost());
    await settle();

    expect(xtermMock.instances).toHaveLength(1);
    expect(terminalAt().writes).toEqual(["\u001b[2J\u001b[Hrestored> "]);
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.authorityAttach"),
    ).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith(
      "session.shellReconstructionAck",
      expect.objectContaining({
        executionId: "shell-1",
        reconstructionFenceToken: 17,
        outputThroughSequence: 1,
      }),
    );
  });

  it("forces a fresh attach after an accepted reconstruction ACK races unmount", async () => {
    let resolveAck: ((result: { accepted: boolean }) => void) | undefined;
    const ack = new Promise<{ accepted: boolean }>((resolve) => {
      resolveAck = resolve;
    });
    const invoke = installPivis(undefined, undefined, async () => ack);
    act(() => {
      useSessionsStore.getState().applyAuthorityAttach(
        SESSION_ID,
        readyShellAttach(1, "\u001b[2J\u001b[Hrestored> ", {
          reconstructionFenceToken: 21,
        }),
      );
    });

    mount(shellTerminalHost());
    await settle();
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.shellReconstructionAck"),
    ).toHaveLength(1);

    const unmount = mounted.pop();
    unmount?.();
    await act(async () => {
      resolveAck?.({ accepted: true });
      await ack;
    });
    await settle();
    expect(
      useSessionsStore.getState().sessions.get(SESSION_ID)?.shellReconstructionAckKey,
    ).toBeTruthy();

    mount(shellTerminalHost());
    await settle();
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.authorityAttach"),
    ).toHaveLength(1);
  });

  it("uses one fixed viewport across normal and alternate modes and exposes unpin recovery", async () => {
    const invoke = installPivis();
    const container = mount(shellTerminalHost());
    await settle();
    const terminal = terminalAt();
    const surface = container.querySelector<HTMLElement>(".shell-terminal");
    const initialGrid = { cols: terminal.cols, rows: terminal.rows };
    const initialResizeCalls = invoke.mock.calls.filter(
      ([channel]) => channel === "session.shellResize",
    );

    expect(terminal).toBeDefined();
    expect(initialGrid).toEqual({
      cols: xtermMock.proposedCols,
      rows: Math.floor((window.innerHeight * 0.5) / (14 * 1.2)),
    });
    expect(initialGrid.rows).toBeGreaterThan(8);
    expect(initialResizeCalls).toHaveLength(1);
    expect(document.activeElement).toBe(terminal.textarea);
    expect(surface?.querySelector("header")).toBeNull();
    expect(surface?.querySelector("footer")).toBeNull();
    expect(surface?.textContent).toBe("");
    expect(surface?.querySelector(".shell-terminal__controls")).toBeNull();
    expect(surface?.querySelector('[aria-label="Interrupt shell command"]')).toBeNull();
    expect(surface?.querySelector('[aria-label="Force stop shell command"]')).toBeNull();

    act(() => {
      terminal.buffer.active.baseY = 30;
      terminal.buffer.active.cursorY = 7;
      terminal.emitWriteParsed();
    });
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(initialGrid);

    act(() => {
      terminal.buffer.active.viewportY = 12;
      terminal.emitScroll();
    });
    const returnButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Return shell terminal to live output",
    );
    expect(returnButton).toBeDefined();
    act(() => returnButton?.click());
    expect(terminal.scrollToBottomCalls).toBe(1);
    expect(
      container.querySelector('[aria-label="Return shell terminal to live output"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(terminal.textarea);

    act(() => setTerminalMode("fullscreen"));
    expect(surface?.className).toBe("shell-terminal");
    expect(xtermMock.instances).toHaveLength(1);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(initialGrid);
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.shellResize")).toHaveLength(
      1,
    );
  });

  it("owns platform copy shortcuts while Ctrl+C remains raw PTY input", async () => {
    const invoke = installPivis();
    mount(shellTerminalHost());
    await settle();
    const terminal = terminalAt();
    terminal.selection = "selected output";

    expect(
      terminal.dispatchKey(
        new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true }),
      ),
    ).toBe(false);
    expect(
      terminal.dispatchKey(
        new KeyboardEvent("keydown", {
          key: "C",
          ctrlKey: true,
          shiftKey: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(
      terminal.dispatchKey(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true }),
      ),
    ).toBe(true);
    act(() => terminal.emitData("\x03"));
    await settle();

    expect(invoke).toHaveBeenCalledWith("clipboard.writeText", {
      text: "selected output",
    });
    expect(invoke.mock.calls.filter(([channel]) => channel === "clipboard.writeText")).toHaveLength(
      2,
    );
    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ executionId: "shell-1", sequence: 1, data: "\x03" }),
    ]);
  });

  it("refreshes a stale remount before installing or acknowledging its reconstruction", async () => {
    act(() =>
      setTerminalChunks(3, [
        { sequence: 2, data: "stale-a" },
        { sequence: 3, data: "stale-b" },
      ]),
    );
    let resolveAttach: ((response: AuthorityAttachResponse) => void) | undefined;
    const attach = new Promise<AuthorityAttachResponse>((resolve) => {
      resolveAttach = resolve;
    });
    const invoke = installPivis(undefined, async () => attach);
    mount(shellTerminalHost());
    await settle();

    expect(xtermMock.instances).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith("session.authorityAttach", {
      sessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
    });
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.shellReconstructionAck"),
    ).toHaveLength(0);

    await act(async () => {
      resolveAttach?.(readyShellAttach(5, "\u001b[2J\u001b[Hfresh> "));
      await attach;
    });
    await settle();

    const terminal = terminalAt();
    expect(terminal.writes).toEqual(["\u001b[2J\u001b[Hfresh> "]);
    expect(invoke).toHaveBeenCalledWith(
      "session.shellReconstructionAck",
      expect.objectContaining({
        executionId: "shell-1",
        outputThroughSequence: 5,
      }),
    );
    expect(
      invoke.mock.calls.some(
        ([channel, input]) =>
          channel === "session.shellReconstructionAck" &&
          (input as Record<string, unknown>).outputThroughSequence === 1,
      ),
    ).toBe(false);
  });

  it("keeps a transcript-fenced live shell mounted and inert until an equal-sequence reconstruction is acknowledged", async () => {
    let attachCount = 0;
    let resolveRecovery: ((response: AuthorityAttachResponse) => void) | undefined;
    const recovery = new Promise<AuthorityAttachResponse>((resolve) => {
      resolveRecovery = resolve;
    });
    const invoke = installPivis(undefined, async () => {
      attachCount += 1;
      return attachCount === 1 ? readyShellAttach(1, "> ", { snapshotSequence: 2 }) : recovery;
    });
    const container = mount(shellTerminalHost());
    await settle();
    const firstTerminal = terminalAt();
    expect(document.activeElement).toBe(firstTerminal.textarea);

    act(() => fenceTranscriptAuthority());
    await settle();

    expect(container.querySelector(".shell-terminal")).not.toBeNull();
    expect(container.querySelector('[aria-label="Restoring shell terminal"]')).not.toBeNull();
    expect(firstTerminal.disposed).toBe(false);
    expect(container.querySelector('[aria-label="Interrupt shell command"]')).toBeNull();
    act(() => {
      firstTerminal.emitData("held input");
      firstTerminal.input("\x1b");
    });
    await settle();
    expect(shellInputCalls(invoke)).toEqual([]);

    const newerFocus = document.createElement("input");
    document.body.appendChild(newerFocus);
    act(() => newerFocus.focus());
    await act(async () => {
      resolveRecovery?.(readyShellAttach(1, "> ", { snapshotSequence: 3 }));
      await recovery;
    });
    await settle();
    await settle();

    expect(xtermMock.instances).toHaveLength(2);
    expect(firstTerminal.disposed).toBe(true);
    expect(container.querySelector('[aria-label="Restoring shell terminal"]')).toBeNull();
    expect(document.activeElement).toBe(newerFocus);
    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ sequence: 1, data: "held input" }),
      expect.objectContaining({ sequence: 2, data: "\x1b" }),
    ]);
  });

  it("holds input and the latest fixed grid until reconstruction acknowledgement", async () => {
    let resolveAck: ((result: { accepted: boolean }) => void) | undefined;
    const ack = new Promise<{ accepted: boolean }>((resolve) => {
      resolveAck = resolve;
    });
    const invoke = installPivis(undefined, undefined, async () => ack);
    const container = mount(shellTerminalHost());
    await settle();

    const terminal = terminalAt();
    const targetFraction = 0.75;
    const expectedRows = Math.floor((window.innerHeight * targetFraction) / (14 * 1.2));
    expect(container.querySelector('[aria-label="Interrupt shell command"]')).toBeNull();
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.shellResize")).toHaveLength(
      0,
    );
    const viewport = container.querySelector<HTMLElement>(".shell-terminal__viewport");
    if (!viewport) throw new Error("Expected shell viewport");
    // jsdom does not load the component stylesheet, so provide the zero chrome
    // values the real CSS supplies before asking the shared sizer to write its
    // row-rounded inline height.
    viewport.style.paddingTop = "0px";
    viewport.style.paddingBottom = "0px";
    viewport.style.borderTopWidth = "0px";
    viewport.style.borderBottomWidth = "0px";

    act(() => {
      terminal.emitData("held until ACK");
      window.dispatchEvent(
        new CustomEvent("pivis:custom-panel-resize", {
          detail: { fraction: targetFraction },
        }),
      );
    });
    await settle();
    expect(shellInputCalls(invoke)).toEqual([]);
    expect(terminal.rows).toBe(expectedRows);
    const preAckViewportHeight = viewport.style.height;
    expect(preAckViewportHeight).toMatch(/px$/u);
    expect(
      container
        .querySelector<HTMLElement>(".shell-terminal")
        ?.style.getPropertyValue("--shell-terminal-fallback-height"),
    ).toBe("75%");
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.shellResize")).toHaveLength(
      0,
    );

    await act(async () => {
      resolveAck?.({ accepted: true });
      await ack;
    });
    await settle();

    expect(viewport.style.height).toBe(preAckViewportHeight);
    expect(container.querySelector('[aria-label="Restoring shell terminal"]')).toBeNull();
    const resizeCalls = invoke.mock.calls.filter(([channel]) => channel === "session.shellResize");
    expect(resizeCalls).toHaveLength(1);
    expect(resizeCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        executionId: "shell-1",
        revision: 1,
        cols: xtermMock.proposedCols,
        rows: expectedRows,
      }),
    );
    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ sequence: 1, data: "held until ACK" }),
    ]);
  });

  it("serializes PTY resizes and retries the newest grid after one rejected revision", async () => {
    let resolveFirstResize: ((result: { accepted: boolean }) => void) | undefined;
    const firstResize = new Promise<{ accepted: boolean }>((resolve) => {
      resolveFirstResize = resolve;
    });
    let attempt = 0;
    const resize = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? firstResize : { accepted: true };
    });
    const invoke = installPivis(undefined, undefined, undefined, resize);
    mount(shellTerminalHost());
    await settle();

    expect(resize).toHaveBeenCalledTimes(1);
    const targetFraction = 0.75;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pivis:custom-panel-resize", {
          detail: { fraction: 0.7 },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("pivis:custom-panel-resize", {
          detail: { fraction: targetFraction },
        }),
      );
    });
    await settle();

    // Resize IPC is single-flight; the two pointer updates coalesce behind
    // the initial measured grid rather than racing it.
    expect(resize).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstResize?.({ accepted: false });
      await firstResize;
    });
    await settle();

    const resizeCalls = invoke.mock.calls
      .filter(([channel]) => channel === "session.shellResize")
      .map(([, input]) => input as Record<string, unknown>);
    expect(resizeCalls).toHaveLength(2);
    expect(resizeCalls.map((input) => input.revision)).toEqual([1, 2]);
    expect(resizeCalls[1]).toEqual(
      expect.objectContaining({
        cols: xtermMock.proposedCols,
        rows: Math.floor((window.innerHeight * targetFraction) / (14 * 1.2)),
      }),
    );
  });

  it("repairs authority once without spinning after two rejected PTY resizes", async () => {
    let resolveFirstResize: ((result: { accepted: boolean }) => void) | undefined;
    let resolveSecondResize: ((result: { accepted: boolean }) => void) | undefined;
    const firstResize = new Promise<{ accepted: boolean }>((resolve) => {
      resolveFirstResize = resolve;
    });
    const secondResize = new Promise<{ accepted: boolean }>((resolve) => {
      resolveSecondResize = resolve;
    });
    const resize = vi
      .fn<() => Promise<{ accepted: boolean }>>()
      .mockImplementationOnce(async () => firstResize)
      .mockImplementationOnce(async () => secondResize);
    const invoke = installPivis(undefined, undefined, undefined, resize);
    act(() => {
      useSessionsStore
        .getState()
        .applyAuthorityAttach(
          SESSION_ID,
          readyShellAttach(1, "> ", { reconstructionFenceToken: 31 }),
        );
    });
    const requestAttach = vi.fn(async (_sessionId: SessionId, _force?: boolean) => {});
    mount(shellTerminalHost(requestAttach));
    await settle();

    expect(resize).toHaveBeenCalledTimes(1);
    const newestFraction = 0.75;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pivis:custom-panel-resize", {
          detail: { fraction: 0.7 },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("pivis:custom-panel-resize", {
          detail: { fraction: newestFraction },
        }),
      );
    });
    await settle();
    expect(resize).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstResize?.({ accepted: false });
      await firstResize;
    });
    await settle();
    expect(resize).toHaveBeenCalledTimes(2);

    const resizeCalls = invoke.mock.calls
      .filter(([channel]) => channel === "session.shellResize")
      .map(([, input]) => input as Record<string, unknown>);
    expect(resizeCalls.map((input) => input.revision)).toEqual([1, 2]);
    expect(resizeCalls[1]).toEqual(
      expect.objectContaining({
        cols: xtermMock.proposedCols,
        rows: Math.floor((window.innerHeight * newestFraction) / (14 * 1.2)),
      }),
    );

    await act(async () => {
      resolveSecondResize?.({ accepted: false });
      await secondResize;
    });
    await settle();
    await settle();

    expect(requestAttach).toHaveBeenCalledTimes(1);
    expect(requestAttach).toHaveBeenCalledWith(SESSION_ID, true);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("appends repeated capped replay deltas without clearing or rewriting the live emulator", async () => {
    installPivis();
    mount(shellTerminalHost());
    await settle();
    const terminal = terminalAt();
    const capped = "x".repeat(LIVE_SHELL_REPLAY_LIMIT);

    act(() => setTerminalChunks(2, [{ sequence: 2, data: capped }]));
    terminal.writes.length = 0;
    act(() => setTerminalChunks(3, [{ sequence: 3, data: "A" }]));
    act(() =>
      setTerminalChunks(4, [
        { sequence: 3, data: "A" },
        { sequence: 4, data: "B" },
      ]),
    );

    expect(terminal.writes).toEqual(["A", "B"]);
    expect(terminal.writes.every((write) => !write.startsWith("\u001b[2J"))).toBe(true);
  });

  it("drains every sequenced ANSI chunk from one batched renderer update", async () => {
    installPivis();
    mount(shellTerminalHost());
    await settle();
    const terminal = terminalAt();
    terminal.writes.length = 0;
    const chunks = [
      { sequence: 2, data: "\u001b[31mrepeat-repeat" },
      { sequence: 3, data: "\rrepeat\u001b[0m" },
    ];

    act(() => setTerminalChunks(3, chunks));

    expect(terminal.writes).toEqual(chunks.map((chunk) => chunk.data));
  });

  it("warns when the retained output queue has a sequence gap", async () => {
    installPivis();
    mount(shellTerminalHost());
    await settle();

    act(() => setTerminalChunks(4, [{ sequence: 4, data: "recovered tail" }]));

    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts.at(-1)?.message).toBe(
      "Live shell output lost synchronization; earlier output may be omitted.",
    );
  });

  it("makes bounded reattach loss visible", async () => {
    setExecution("shell-1", "compact", 0, true);
    installPivis();
    const container = mount(shellTerminalHost());
    await settle();

    expect(
      container.querySelector('[aria-label="Earlier live shell output omitted"]'),
    ).not.toBeNull();
  });

  it.each([
    [
      { accepted: false, acknowledgedThrough: 0 },
      "Shell input was not sent; synchronization is pending.",
    ],
    [
      {
        accepted: false,
        acknowledgedThrough: 0,
        gap: { expected: 1, received: 2 },
      },
      "Shell input was not sent; synchronization is pending (expected 1, received 2).",
    ],
  ])("warns about rejected unacknowledged input without replaying it", async (result, message) => {
    const invoke = installPivis(async () => result);
    mount(shellTerminalHost());
    await settle();

    act(() => terminalAt().emitData("secret input"));
    await settle();

    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ executionId: "shell-1", sequence: 1, data: "secret input" }),
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_ID)?.toasts.at(-1)?.message).toBe(
      message,
    );
  });

  it("reuses a rejected unacknowledged sequence for the next new input without replay", async () => {
    let calls = 0;
    const invoke = installPivis(async (input) => {
      calls += 1;
      return calls === 1
        ? { accepted: false, acknowledgedThrough: 0 }
        : { accepted: true, acknowledgedThrough: input.sequence };
    });
    mount(shellTerminalHost());
    await settle();

    act(() => {
      terminalAt().emitData("x".repeat(64 * 1024 + 1));
      terminalAt().emitData("valid input");
    });
    await settle();
    await settle();

    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ sequence: 1, data: "x".repeat(64 * 1024 + 1) }),
      expect.objectContaining({ sequence: 1, data: "valid input" }),
    ]);
  });

  it("advances past a rejected duplicate without warning or replay", async () => {
    let calls = 0;
    const invoke = installPivis(async (input) => {
      calls += 1;
      return calls === 1
        ? { accepted: false, acknowledgedThrough: 1 }
        : { accepted: true, acknowledgedThrough: input.sequence };
    });
    mount(shellTerminalHost());
    await settle();

    act(() => {
      terminalAt().emitData("already accepted");
      terminalAt().emitData("next input");
    });
    await settle();
    await settle();

    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ sequence: 1, data: "already accepted" }),
      expect.objectContaining({ sequence: 2, data: "next input" }),
    ]);
    expect(
      useSessionsStore
        .getState()
        .sessions.get(SESSION_ID)
        ?.toasts.some((toast) => toast.message.includes("was not sent")),
    ).toBe(false);
  });

  it("ignores a late old-shell acknowledgement when allocating the new shell sequence", async () => {
    let resolveOldInput: ((value: unknown) => void) | undefined;
    const oldInput = new Promise((resolve) => {
      resolveOldInput = resolve;
    });
    const invoke = installPivis(async (input) => {
      if (input.executionId === "shell-1") return oldInput;
      return { accepted: true, acknowledgedThrough: input.sequence };
    });
    mount(shellTerminalHost());
    await settle();

    act(() => terminalAt().emitData("old secret"));
    await settle();
    expect(shellInputCalls(invoke)).toHaveLength(1);

    act(() => setExecution("shell-2"));
    await settle();
    expect(xtermMock.instances).toHaveLength(2);

    await act(async () => {
      resolveOldInput?.({ accepted: true, acknowledgedThrough: 99 });
      await oldInput;
    });
    act(() => terminalAt(1).emitData("new input"));
    await settle();

    expect(shellInputCalls(invoke)).toEqual([
      expect.objectContaining({ executionId: "shell-1", sequence: 1, data: "old secret" }),
      expect.objectContaining({ executionId: "shell-2", sequence: 1, data: "new input" }),
    ]);
  });
});
