// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type { InputUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { AppSettingsSchema, defaultSettings } from "@shared/settings.js";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionStore from "../../stores/sessions-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { Sidebar } from "./Sidebar.js";

const WS = "/repo";
let container: HTMLDivElement;
let unmount: (() => void) | undefined;
let failWrites = false;
let persisted = structuredClone(defaultSettings);
const invoke = vi.fn(async (channel: string, payload?: Record<string, unknown>) => {
  if (channel === "workspace.list" || channel === "themes.listUser") return [];
  if (channel === "settings.get") return persisted;
  if (channel === "settings.set") {
    if (failWrites) throw new Error("fixture write failure");
    persisted = AppSettingsSchema.parse({ ...persisted, ...payload });
    return persisted;
  }
  throw new Error(`Unexpected IPC channel ${channel}`);
});

function summary(id: string, options: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    filePath: `/sessions/${id}.jsonl`,
    cwd: WS,
    preview: id,
    name: id,
    mtime: 1,
    messageCount: 1,
    ...options,
  };
}

async function mount(summaries: SessionSummary[]): Promise<void> {
  useSessionsStore.getState().addWorkspace(WS);
  useSessionsStore.getState().setExpandedWorkspaces([WS]);
  useSessionsStore.getState().setWorkspaceSessions(WS, summaries);
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    root.render(<Sidebar onOpenSettings={() => {}} />);
    await Promise.resolve();
  });
}

function button(title: string, scope: ParentNode = container): HTMLButtonElement {
  const target = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.title === title,
  );
  if (!target) throw new Error(`Missing button: ${title}`);
  return target;
}

function row(filePath: string): HTMLElement {
  const target = Array.from(container.querySelectorAll<HTMLElement>(".sidebar__session")).find(
    (candidate) => candidate.dataset.sessionFile === filePath,
  );
  if (!target) throw new Error(`Missing row: ${filePath}`);
  return target;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function drag(source: HTMLElement, destination: HTMLElement): Promise<void> {
  const dataTransfer = {
    types: [] as string[],
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string): void {
      this.types.push(type);
    },
  };
  for (const [target, type] of [
    [source, "dragstart"],
    [destination, "dragover"],
    [destination, "drop"],
    [source, "dragend"],
  ] as const) {
    await act(async () => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function enterName(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '.session-group-dialog input[type="text"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    document
      .querySelector(".session-group-dialog")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  failWrites = false;
  persisted = structuredClone(defaultSettings);
  invoke.mockClear();
  Object.assign(window, { pivis: { invoke } });
  useSessionsStore.setState({
    workspaces: new Map(),
    sessions: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
    expandedWorkspaces: [],
  });
  await useSettingsStore.getState().load();
  // Avoid boot activating a host; these are settings/presentation tests only.
  useSettingsStore.setState({ loaded: false });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  useSessionsStore.setState({
    workspaces: new Map(),
    sessions: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
    expandedWorkspaces: [],
  });
  useSettingsStore.setState({ settings: defaultSettings, loaded: false });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("sidebar session organization", () => {
  it.each(["dialog", "panel"] as const)(
    "prioritizes user input over a still-working tool (%s)",
    async (surface) => {
      vi.spyOn(sessionStore, "shouldShowWorkingIndicator").mockReturnValue(true);
      const saved = summary("Waiting for input");
      const id = "input-wait" as SessionId;
      useSessionsStore.getState().createSession(id, WS, saved.filePath, saved.name);
      const session = useSessionsStore.getState().sessions.get(id)!;
      const request: InputUiRequest = {
        type: "extension_ui_request",
        id: "input-1",
        method: "input",
        title: "Your answer?",
      };
      useSessionsStore.setState({
        sessions: new Map([
          [
            id,
            {
              ...session,
              hasTreeHistory: true,
              pendingDialogs: surface === "dialog" ? [request] : [],
              panel:
                surface === "panel"
                  ? {
                      id: 1,
                      overlay: true,
                      hostInstanceId: "input-host",
                      sessionEpoch: 1,
                      buffer: [],
                    }
                  : undefined,
            },
          ],
        ]),
      });
      await mount([saved]);
      expect(
        row(saved.filePath).querySelector(".status-dot--attention")?.getAttribute("title"),
      ).toBe("Needs attention");
      expect(row(saved.filePath).querySelector(".status-dot--streaming")).toBeNull();

      await act(async () => {
        useSessionsStore.setState({
          sessions: new Map([[id, { ...session, hasTreeHistory: true }]]),
        });
      });
      expect(row(saved.filePath).querySelector(".status-dot--attention")).toBeNull();
      expect(row(saved.filePath).querySelector(".status-dot--streaming")).not.toBeNull();
    },
  );

  it("hides discovered children by default but leaves normal forks and an explicitly active child visible", async () => {
    const child = summary("Explore#1234abcd", { isSubagent: true, parentSession: "/parent.jsonl" });
    const active = summary("general-purpose#abcdef12", {
      isSubagent: true,
      parentSession: "/parent.jsonl",
    });
    const fork = summary("My ordinary fork", { parentSession: "/parent.jsonl" });
    const id = "active-child" as SessionId;
    useSessionsStore
      .getState()
      .createSession(id, WS, active.filePath, active.name, undefined, "ready");
    useSessionsStore.setState({ activeSessionId: id, activeWorkspacePath: WS });
    await mount([child, active, fork]);
    const names = () =>
      Array.from(container.querySelectorAll(".sidebar__session-name")).map(
        (element) => element.textContent,
      );
    expect(names()).toEqual([active.name, fork.name]);
    expect(useSessionsStore.getState().sessions.has(id)).toBe(true);

    await act(async () => useSettingsStore.getState().update({ showSubagentSessions: true }));
    expect(names()).toContain(child.name);
    expect(names()).toHaveLength(3);
    expect(useSessionsStore.getState().activeSessionId).toBe(id);
    expect(invoke).not.toHaveBeenCalledWith("session.close", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("session.open", expect.anything());
  });

  it("honors a cleared live name instead of reviving a stale generated discovery name", async () => {
    const child = summary("Worker#1234abcd", { isSubagent: true, parentSession: "/parent.jsonl" });
    const id = "cleared-child" as SessionId;
    useSessionsStore.getState().createSession(id, WS, child.filePath, child.name);
    const session = useSessionsStore.getState().sessions.get(id)!;
    useSessionsStore.setState({ sessions: new Map([[id, { ...session, hasTreeHistory: true }]]) });
    await mount([child]);
    expect(container.querySelectorAll(".sidebar__session")).toHaveLength(0);

    await act(async () => {
      useSessionsStore.setState({
        sessions: new Map([[id, { ...session, hasTreeHistory: true, sessionName: undefined }]]),
      });
    });
    expect(row(child.filePath).textContent).toContain("Untitled session");
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it("keeps an uncertain sampled name visible before live name presentation is known", async () => {
    const saved = summary("Worker#1234abcd", { parentSession: "/parent.jsonl" });
    const id = "uncertain-name" as SessionId;
    useSessionsStore.getState().createSession(id, WS, saved.filePath, saved.name);
    const session = useSessionsStore.getState().sessions.get(id)!;
    useSessionsStore.setState({ sessions: new Map([[id, { ...session, hasTreeHistory: true }]]) });
    await mount([saved]);
    expect(row(saved.filePath)).toBeTruthy();
  });

  it.each([false, true])(
    "reveals an active child beyond the first page (grouped: %s)",
    async (grouped) => {
      const child = summary("Worker#1234abcd", {
        isSubagent: true,
        parentSession: "/parent.jsonl",
        mtime: 0,
      });
      if (grouped) {
        await act(async () =>
          useSettingsStore.getState().update({
            sessionGroups: [
              {
                id: "work",
                workspacePath: WS,
                name: "Work",
                sessionFiles: [
                  child.filePath,
                  ...Array.from({ length: 35 }, (_, index) => `/sessions/Recent ${index}.jsonl`),
                ],
                collapsed: false,
              },
            ],
          }),
        );
      }
      const id = "older-active-child" as SessionId;
      useSessionsStore.getState().createSession(id, WS, child.filePath, child.name);
      useSessionsStore.setState({ activeSessionId: id, activeWorkspacePath: WS });
      await mount([
        ...Array.from({ length: 35 }, (_, index) =>
          summary(`Recent ${index}`, { mtime: 100 - index }),
        ),
        child,
      ]);
      expect(row(child.filePath)).toBeTruthy();
      expect(container.querySelectorAll(".sidebar__session")).toHaveLength(36);
      if (grouped) {
        await click(container.querySelector<HTMLButtonElement>(".sidebar__group-toggle")!);
        expect(container.querySelectorAll(".sidebar__session")).toHaveLength(0);
        expect(persisted.sessionGroups[0]?.collapsed).toBe(true);
      }
    },
  );

  it("creates, assigns, collapses, renames, and removes a group without modifying sessions or pins", async () => {
    const saved = summary("Important work");
    await mount([saved]);
    await click(button("Create session group"));
    await enterName("  Research  ");
    await submit();
    expect(document.querySelector(".session-group-dialog")).toBeNull();
    expect(persisted.sessionGroups).toHaveLength(1);
    const groupId = persisted.sessionGroups[0]!.id;
    expect(persisted.sessionGroups[0]?.name).toBe("Research");

    await click(button("Move session to group", row(saved.filePath)));
    const choice = Array.from(
      document.querySelectorAll<HTMLInputElement>('.session-group-dialog input[type="radio"]'),
    ).find((input) => input.value === groupId)!;
    await click(choice);
    await submit();
    const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Research"]')!;
    expect(group.querySelector(".sidebar__session-name")?.textContent).toBe(saved.name);
    expect(persisted.sessionGroups[0]?.sessionFiles).toEqual([saved.filePath]);
    expect(container.querySelectorAll(".sidebar__session")).toHaveLength(1);

    await click(group.querySelector<HTMLButtonElement>(".sidebar__group-toggle")!);
    expect(group.querySelectorAll(".sidebar__session")).toHaveLength(0);
    expect(persisted.sessionGroups[0]?.collapsed).toBe(true);
    await click(group.querySelector<HTMLButtonElement>(".sidebar__group-toggle")!);
    await click(button("Rename group", group));
    await enterName("Launch");
    await submit();
    expect(persisted.sessionGroups[0]?.name).toBe("Launch");
    await click(button("Remove group (keep sessions)"));
    expect(persisted.sessionGroups).toEqual([]);
    expect(row(saved.filePath).textContent).toContain(saved.name);
    expect(persisted.archivedSessions).toEqual([]);
    expect(persisted.pinnedSessions).toEqual([]);
    expect(
      invoke.mock.calls.every(([channel]) =>
        ["settings.get", "settings.set", "workspace.list", "themes.listUser"].includes(channel),
      ),
    ).toBe(true);
  });

  it("can create a destination directly from a move dialog", async () => {
    const saved = summary("Move me");
    await mount([saved]);
    await click(button("Move session to group", row(saved.filePath)));
    const create = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".session-group-dialog button"),
    ).find((element) => element.textContent === "New group")!;
    await click(create);
    await enterName("Payroll");
    await submit();
    expect(persisted.sessionGroups[0]?.sessionFiles).toEqual([saved.filePath]);
    expect(
      container.querySelector('[role="group"][aria-label="Payroll"] .sidebar__session'),
    ).not.toBeNull();
  });

  it("paginates sections separately so older grouped rows remain reachable", async () => {
    const older = summary("Older grouped session", { mtime: 0 });
    const group = {
      id: "work",
      workspacePath: WS,
      name: "Work",
      sessionFiles: [older.filePath],
      collapsed: false,
    };
    useSettingsStore.setState({ settings: { ...defaultSettings, sessionGroups: [group] } });
    await mount([
      ...Array.from({ length: 35 }, (_, index) =>
        summary(`Recent ${index}`, { mtime: 100 - index }),
      ),
      older,
    ]);
    expect(container.querySelectorAll(".sidebar__session")).toHaveLength(31);
    expect(row(older.filePath)).toBeTruthy();
    expect(container.querySelector(".sidebar__show-more")?.textContent).toContain("5 remaining");
    await click(container.querySelector<HTMLButtonElement>(".sidebar__show-more")!);
    expect(container.querySelectorAll(".sidebar__session")).toHaveLength(36);
  });

  it.each([false, true])(
    "dragging reveals an older moved row beyond the destination's first page (live: %s)",
    async (live) => {
      const saved = summary("Drag me", { mtime: 0 });
      const peers = Array.from({ length: 35 }, (_, index) =>
        summary(`Grouped ${index}`, { mtime: 100 - index }),
      );
      await useSettingsStore.getState().update({
        sessionGroups: [
          {
            id: "work",
            workspacePath: WS,
            name: "Work",
            collapsed: true,
            sessionFiles: peers.map((peer) => peer.filePath),
          },
        ],
      });
      if (live) {
        const id = "drag-live" as SessionId;
        useSessionsStore.getState().createSession(id, WS, saved.filePath, saved.name);
        const session = useSessionsStore.getState().sessions.get(id)!;
        useSessionsStore.setState({
          sessions: new Map([[id, { ...session, hasTreeHistory: true }]]),
        });
      }
      await mount([...peers, saved]);
      invoke.mockClear();
      const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Work"]')!;
      expect(group.querySelectorAll(".sidebar__session")).toHaveLength(0);
      await drag(row(saved.filePath), group.querySelector<HTMLElement>(".sidebar__group-header")!);
      expect(persisted.sessionGroups[0]?.collapsed).toBe(false);
      expect(persisted.sessionGroups[0]?.sessionFiles).toContain(saved.filePath);
      expect(group.querySelectorAll(".sidebar__session")).toHaveLength(36);
      expect(row(saved.filePath).closest('[role="group"]')).toBe(group);
      expect(container.querySelectorAll(".sidebar__session-group--drop-target")).toHaveLength(0);
      expect(useSessionsStore.getState().activeSessionId).toBeNull();
      expect(invoke.mock.calls.every(([channel]) => channel === "settings.set")).toBe(true);
    },
  );

  it("rolls back a failed drop with an error and leaves sessions untouched", async () => {
    const saved = summary("Keep me");
    await useSettingsStore.getState().update({
      sessionGroups: [
        {
          id: "work",
          workspacePath: WS,
          name: "Work",
          sessionFiles: [],
          collapsed: true,
        },
      ],
    });
    await mount([saved]);
    invoke.mockClear();
    failWrites = true;
    await drag(
      row(saved.filePath),
      container.querySelector<HTMLElement>(".sidebar__group-header")!,
    );
    expect(persisted.sessionGroups[0]?.sessionFiles).toEqual([]);
    expect(useSettingsStore.getState().settings.sessionGroups[0]?.collapsed).toBe(true);
    expect(row(saved.filePath).closest('[aria-label="Ungrouped"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t save");
    expect(invoke.mock.calls.every(([channel]) => channel === "settings.set")).toBe(true);
    failWrites = false;
    await drag(
      row(saved.filePath),
      container.querySelector<HTMLElement>(".sidebar__group-header")!,
    );
    expect(persisted.sessionGroups[0]?.sessionFiles).toEqual([saved.filePath]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not make a pathless session draggable", async () => {
    const id = "unsaved" as SessionId;
    useSessionsStore.getState().createSession(id, WS);
    const session = useSessionsStore.getState().sessions.get(id)!;
    useSessionsStore.setState({ sessions: new Map([[id, { ...session, hasTreeHistory: true }]]) });
    await mount([]);
    expect(container.querySelector(".sidebar__session")?.getAttribute("draggable")).toBe("false");
  });

  it("keeps failed edits open with the draft intact and settings rolled back", async () => {
    await mount([summary("Saved")]);
    await click(button("Create session group"));
    await enterName("Don’t lose this name");
    failWrites = true;
    await submit();
    expect(document.querySelector(".session-group-dialog [role=alert]")?.textContent).toContain(
      "Couldn’t save",
    );
    expect(
      document.querySelector<HTMLInputElement>('.session-group-dialog input[type="text"]')?.value,
    ).toBe("Don’t lose this name");
    expect(useSettingsStore.getState().settings.sessionGroups).toEqual([]);
    failWrites = false;
    await submit();
    expect(document.querySelector(".session-group-dialog")).toBeNull();
    expect(persisted.sessionGroups[0]?.name).toBe("Don’t lose this name");
  });
});
