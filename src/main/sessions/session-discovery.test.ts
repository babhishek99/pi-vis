import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "../settings-store.js";
import {
  extractSessionMeta,
  extractSessionMetaAsync,
  listSessionsForWorkspace,
  resolveValidatedWorktreeForFile,
  resolveWorktreeForFile,
} from "./session-discovery.js";

let root: string;
let sessionsEnvBackup: string | undefined;
let settingsEnvBackup: string | undefined;

beforeEach(() => {
  sessionsEnvBackup = process.env["PIVIS_SESSIONS_DIR"];
  settingsEnvBackup = process.env["PIVIS_SETTINGS_DIR"];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-discovery-"));
  process.env["PIVIS_SESSIONS_DIR"] = root;
  fs.mkdirSync(path.join(root, "workspace-A"), { recursive: true });
  // Isolate settings to a temp dir so worktree associations don't leak
  // between tests or touch the user's real settings.json.
  process.env["PIVIS_SETTINGS_DIR"] = root;
  loadSettings();
});

afterEach(() => {
  if (sessionsEnvBackup === undefined) {
    delete process.env["PIVIS_SESSIONS_DIR"];
  } else {
    process.env["PIVIS_SESSIONS_DIR"] = sessionsEnvBackup;
  }
  if (settingsEnvBackup === undefined) {
    delete process.env["PIVIS_SETTINGS_DIR"];
  } else {
    process.env["PIVIS_SETTINGS_DIR"] = settingsEnvBackup;
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Pi Vis Tests", "-c", "user.email=pi-vis@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function initRepo(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "tracked\n");
  git(directory, ["add", "tracked.txt"]);
  git(directory, ["commit", "-m", "initial"]);
}

function writeSession(workspace: string, fileName: string, lines: object[]): string {
  const dir = path.join(root, workspace);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

// Helpers that build entries in the REAL pi v3 nested shape.
function userEntry(id: string, parentId: string, text: string) {
  return {
    id,
    parentId,
    timestamp: "2024-01-01T00:00:00Z",
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 },
  };
}
function sessionInfo(id: string, parentId: string, name: string) {
  return { id, parentId, timestamp: "2024-01-01T00:00:00Z", type: "session_info", name };
}

describe("listSessionsForWorkspace", () => {
  it("returns the last session_info name in file order", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hello"),
      sessionInfo("e2", "e1", "First"),
      sessionInfo("e3", "e2", "Second"),
    ]);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("Second");
    expect(summaries[0]?.preview).toBe("hello");
    expect(summaries[0]?.messageCount).toBe(1);
    expect(summaries[0]?.filePath).toBe(filePath);
  });

  it("returns no name when the file has no session_info entries", async () => {
    const cwd = path.join(root, "workspace-A");
    writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
    ]);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBeUndefined();
    expect(summaries[0]?.messageCount).toBe(1);
  });

  it("samples large session files without losing head preview or tail name", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "large.jsonl", [
      { type: "session", version: 3, id: "large", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "large", "head-preview"),
    ]);
    const filler = JSON.stringify({ type: "tool_result", data: "x".repeat(1024) });
    fs.appendFileSync(filePath, `${Array.from({ length: 1200 }, () => filler).join("\n")}\n`);
    fs.appendFileSync(filePath, `${JSON.stringify(sessionInfo("tail", "e1", "Tail Name"))}\n`);

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.preview).toBe("head-preview");
    expect(summaries[0]?.name).toBe("Tail Name");
  });

  it("keeps the first tail line when the large-file tail starts on a JSONL boundary", async () => {
    const cwd = path.join(root, "workspace-A");
    const dir = path.join(root, "workspace-A");
    const filePath = path.join(dir, "tail-boundary.jsonl");
    const header = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "boundary",
      timestamp: "2024-01-01T00:00:00Z",
      cwd,
    })}\n`;
    const chunkBytes = 1024 * 1024;
    const fillerBytes = chunkBytes - Buffer.byteLength(header);
    expect(fillerBytes).toBeGreaterThan(0);
    fs.writeFileSync(filePath, header);
    fs.appendFileSync(filePath, `${"x".repeat(fillerBytes - 1)}\n`);
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(sessionInfo("tail", "boundary", "Boundary Name"))}\n`,
    );

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("Boundary Name");
  });

  it("invalidates the cache when the file is rewritten with a new name", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
      sessionInfo("e2", "e1", "Initial"),
    ]);

    const first = await listSessionsForWorkspace(cwd);
    expect(first[0]?.name).toBe("Initial");

    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        id: "e3",
        parentId: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session_info",
        name: "Third",
      })}\n`,
    );
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    const second = await listSessionsForWorkspace(cwd);
    expect(second[0]?.name).toBe("Third");
  });

  it("does not return sessions whose header cwd differs from the queried workspace", async () => {
    const otherCwd = path.join(root, "workspace-B");
    fs.mkdirSync(path.join(root, "workspace-B"), { recursive: true });
    writeSession("workspace-B", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd: otherCwd },
      userEntry("e1", "abc", "nope"),
      sessionInfo("e2", "e1", "Other"),
    ]);

    const summaries = await listSessionsForWorkspace(path.join(root, "workspace-A"));
    expect(summaries).toHaveLength(0);
  });

  it("extractSessionMeta honors an empty-string session_info name as a clear", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
      sessionInfo("e2", "e1", "First"),
      {
        id: "e3",
        parentId: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session_info",
        name: "",
      },
    ]);

    const meta = extractSessionMeta(filePath);
    expect(meta.name).toBe("");
    expect(meta.preview).toBe("hi");
    expect(meta.messageCount).toBe(1);
  });

  it("extractSessionMeta reads user message from the real nested shape (not top-level role)", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "real-shape-here"),
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.preview).toBe("real-shape-here");
    expect(meta.messageCount).toBe(1);
  });

  it("old flat shape (top-level role) yields messageCount === 0", () => {
    // Pins the read path: real pi never writes the flat shape, so this is
    // a regression guard. If a future change accidentally read top-level
    // role again, this test fails.
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "message",
        role: "user",
        content: [{ type: "text", text: "FLAT" }],
      },
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.messageCount).toBe(0);
    expect(meta.preview).toBe("");
  });

  it("extractSessionMeta reports lastActiveAt as the newest user-message timestamp", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      // older user message
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "first" }],
          timestamp: 1_700_000_000_000,
        },
      },
      // a later session_info entry — must NOT count as activity (passive open)
      {
        id: "e2",
        parentId: "e1",
        timestamp: "2024-06-01T00:00:00Z",
        type: "session_info",
        name: "Glanced",
      },
      // newest user message — this is the activity we want
      {
        id: "e3",
        parentId: "e2",
        timestamp: "2024-02-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "second" }],
          timestamp: 1_700_000_001_000,
        },
      },
    ]);
    const meta = extractSessionMeta(filePath);
    // Newest user message is e3 at 2024-02-01 (1706745600000). The later
    // session_info entry (e2, 2024-06-01) must NOT count as activity.
    expect(meta.lastActiveAt).toBe(Date.parse("2024-02-01T00:00:00Z"));
  });

  it("extractSessionMeta returns null lastActiveAt when there are no user messages", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_info",
        name: "Empty",
      },
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.lastActiveAt).toBeNull();
  });

  it("orders equal-activity sessions deterministically by file path", async () => {
    const cwd = path.join(root, "workspace-A");
    const firstPath = writeSession("workspace-A", "a.jsonl", [
      { type: "session", version: 3, id: "A", timestamp: "2024-01-01T00:00:00Z", cwd },
    ]);
    const secondPath = writeSession("workspace-A", "b.jsonl", [
      { type: "session", version: 3, id: "B", timestamp: "2024-01-01T00:00:00Z", cwd },
    ]);
    const sameTime = new Date("2024-01-01T00:00:00Z");
    fs.utimesSync(firstPath, sameTime, sameTime);
    fs.utimesSync(secondPath, sameTime, sameTime);

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries.map((s) => s.filePath)).toEqual([firstPath, secondPath]);
  });

  it("short-circuits header and metadata reads on mtime cache hits", async () => {
    const cwd = path.join(root, "workspace-A");
    writeSession("workspace-A", "cached.jsonl", [
      { type: "session", version: 3, id: "cached", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "cached", "hello"),
    ]);

    await listSessionsForWorkspace(cwd);
    const openSpy = vi.spyOn(fsp, "open");
    const second = await listSessionsForWorkspace(cwd);

    expect(second.map((s) => s.id)).toEqual(["cached"]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("orders sessions by last user activity, not file mtime (passive open must not promote)", async () => {
    const cwd = path.join(root, "workspace-A");
    // Session A: actively worked in recently (user message at 2024-02-01),
    // but its file mtime is old.
    const filePathA = writeSession("workspace-A", "active.jsonl", [
      { type: "session", version: 3, id: "A", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "a1",
        parentId: "A",
        timestamp: "2024-02-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "real work" }],
          timestamp: 1_700_000_001_000,
        },
      },
    ]);
    // Session B: only glanced at (a passive open appended a fresh
    // session_info), so its file mtime is the newest of the two even though
    // the last real user activity is older.
    const filePathB = writeSession("workspace-A", "glanced.jsonl", [
      { type: "session", version: 3, id: "B", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "b1",
        parentId: "B",
        timestamp: "2024-01-15T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "old work" }],
          timestamp: 1_700_000_000_000,
        },
      },
      {
        id: "b2",
        parentId: "b1",
        timestamp: "2024-12-01T00:00:00Z",
        type: "session_info",
        name: "Glanced",
      },
    ]);
    // Force B's file mtime to be newer than A's (simulating a passive open
    // touch), even though A's last user activity is newer.
    const oldMtime = new Date("2024-01-01T00:00:00Z");
    const newMtime = new Date("2024-12-01T00:00:00Z");
    fs.utimesSync(filePathA, oldMtime, oldMtime);
    fs.utimesSync(filePathB, newMtime, newMtime);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(2);
    // A (newer user activity) must rank above B (newer mtime only).
    expect(summaries[0]?.id).toBe("A");
    expect(summaries[1]?.id).toBe("B");
  });
});

describe("persisted subagent sidebar metadata", () => {
  function writeNamedSession(fileName: string, names: string[], parentSession?: unknown): string {
    const cwd = path.join(root, "workspace-A");
    const id = path.basename(fileName, ".jsonl");
    return writeSession("workspace-A", fileName, [
      {
        type: "session",
        version: 3,
        id,
        timestamp: "2024-01-01T00:00:00Z",
        cwd,
        ...(parentSession !== undefined ? { parentSession } : {}),
      },
      userEntry("e1", id, "hello"),
      ...names.map((name, index) =>
        sessionInfo(`info-${index}`, index === 0 ? "e1" : `info-${index - 1}`, name),
      ),
    ]);
  }

  it("retains a generated child and classifies its latest saved name", async () => {
    const cwd = path.join(root, "workspace-A");
    const parentSession = path.join(root, "workspace-A", "parent.jsonl");
    const filePath = writeNamedSession(
      "child.jsonl",
      ["Initial", "Research helper#ABCDEF12"],
      parentSession,
    );

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      filePath,
      parentSession,
      name: "Research helper#ABCDEF12",
      isSubagent: true,
      preview: "hello",
      messageCount: 1,
    });
  });

  it.each(["", " \t "])("does not resurrect a generated name after a clear (%j)", async (clear) => {
    const cwd = path.join(root, "workspace-A");
    const parentSession = path.join(root, "workspace-A", "parent.jsonl");
    const filePath = writeNamedSession("cleared.jsonl", ["Worker#0123abcd", clear], parentSession);

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.parentSession).toBe(parentSession);
    expect(summaries[0]?.name).toBeUndefined();
    expect(summaries[0]).not.toHaveProperty("isSubagent");
    expect(extractSessionMeta(filePath).name).toBe("");
    expect(await extractSessionMetaAsync(filePath)).toEqual(extractSessionMeta(filePath));
  });

  it.each(["Promoted investigation", ""])(
    "does not hide a session when the latest name (%j) is in the unread middle",
    async (latestName) => {
      const cwd = path.join(root, "workspace-A");
      const filePath = writeNamedSession("large-child.jsonl", ["Worker#0123abcd"], "/parent.jsonl");
      const filler = `${JSON.stringify({ type: "custom", data: "x".repeat(1024 * 1024 + 1024) })}\n`;
      fs.appendFileSync(filePath, filler);
      fs.appendFileSync(filePath, `${JSON.stringify(sessionInfo("rename", "e1", latestName))}\n`);
      fs.appendFileSync(filePath, filler);

      const readSpy = vi.spyOn(fsp, "readFile");
      const summaries = await listSessionsForWorkspace(cwd);
      expect(summaries[0]?.name).toBe("Worker#0123abcd");
      expect(summaries[0]).not.toHaveProperty("isSubagent");
      expect(extractSessionMeta(filePath).nameIsAuthoritative).toBe(false);
      expect(await extractSessionMetaAsync(filePath)).toEqual(extractSessionMeta(filePath));
      expect(readSpy).not.toHaveBeenCalled();

      // Positive evidence after the skipped region can safely hide a child.
      fs.appendFileSync(
        filePath,
        `${JSON.stringify(sessionInfo("latest", "rename", "Worker#abcdef12"))}\n`,
      );
      const future = new Date(summaries[0]!.mtime + 5000);
      fs.utimesSync(filePath, future, future);
      expect((await listSessionsForWorkspace(cwd))[0]).toMatchObject({
        name: "Worker#abcdef12",
        isSubagent: true,
      });
    },
  );

  it("does not hide from metadata before a discarded boundary-spanning rename", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeNamedSession(
      "boundary-child.jsonl",
      ["Worker#0123abcd"],
      "/parent.jsonl",
    );
    const paddingBytes = 1024 * 1024 - fs.statSync(filePath).size - 16;
    const fillerOverhead = Buffer.byteLength(`${JSON.stringify({ type: "custom", data: "" })}\n`);
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({ type: "custom", data: "x".repeat(paddingBytes - fillerOverhead) })}\n`,
    );
    fs.appendFileSync(filePath, `${JSON.stringify(sessionInfo("rename", "e1", "Promoted"))}\n`);
    fs.appendFileSync(filePath, `${JSON.stringify({ type: "custom", data: "tail" })}\n`);

    expect((await listSessionsForWorkspace(cwd))[0]).not.toHaveProperty("isSubagent");
    expect(extractSessionMeta(filePath).nameIsAuthoritative).toBe(false);
    expect(await extractSessionMetaAsync(filePath)).toEqual(extractSessionMeta(filePath));
  });

  it.each(["fork", "clone"])(
    "does not classify an ordinary %s by its parent alone",
    async (kind) => {
      const cwd = path.join(root, "workspace-A");
      const parentSession = path.join(root, "workspace-A", "parent.jsonl");
      const name = `My work (${kind})`;
      writeNamedSession(`${kind}.jsonl`, [name], parentSession);

      const summaries = await listSessionsForWorkspace(cwd);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ name, parentSession });
      expect(summaries[0]).not.toHaveProperty("isSubagent");
      expect(await listSessionsForWorkspace(cwd)).toEqual(summaries);
    },
  );

  it("leaves a user-chosen generated-looking name without parent metadata visible", async () => {
    const cwd = path.join(root, "workspace-A");
    writeNamedSession("ordinary.jsonl", ["My notes#0123abcd"]);

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("My notes#0123abcd");
    expect(summaries[0]).not.toHaveProperty("parentSession");
    expect(summaries[0]).not.toHaveProperty("isSubagent");
  });

  it.each(
    [null, 42, false, [], { path: "/sessions/parent.jsonl" }, "", " \t"].map((parentSession) => ({
      parentSession,
    })),
  )(
    "keeps a session with malformed or empty optional parent $parentSession visible",
    async ({ parentSession }) => {
      const cwd = path.join(root, "workspace-A");
      writeNamedSession("malformed-parent.jsonl", ["Worker#0123abcd"], parentSession);

      const summaries = await listSessionsForWorkspace(cwd);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.name).toBe("Worker#0123abcd");
      expect(summaries[0]).not.toHaveProperty("parentSession");
      expect(summaries[0]).not.toHaveProperty("isSubagent");
      expect(await listSessionsForWorkspace(cwd)).toEqual(summaries);
    },
  );

  it("removes the hint after a child is renamed without mutating earlier summaries", async () => {
    const cwd = path.join(root, "workspace-A");
    const parentSession = path.join(root, "workspace-A", "parent.jsonl");
    const filePath = writeNamedSession("renamed.jsonl", ["Worker#0123abcd"], parentSession);
    const first = await listSessionsForWorkspace(cwd);
    const cached = await listSessionsForWorkspace(cwd);
    expect(cached).toEqual(first);
    expect(first[0]?.isSubagent).toBe(true);

    fs.appendFileSync(
      filePath,
      `${JSON.stringify(sessionInfo("info-1", "info-0", "Promoted investigation"))}\n`,
    );
    const future = new Date(first[0]!.mtime + 5000);
    fs.utimesSync(filePath, future, future);

    const renamed = await listSessionsForWorkspace(cwd);

    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ name: "Promoted investigation", parentSession });
    expect(renamed[0]).not.toHaveProperty("isSubagent");
    expect(await listSessionsForWorkspace(cwd)).toEqual(renamed);
    expect(first[0]).toMatchObject({ name: "Worker#0123abcd", parentSession, isSubagent: true });
    expect(cached).toEqual(first);
  });

  it("keeps fresh and cached summaries isolated from caller mutation without rereading", async () => {
    const cwd = path.join(root, "workspace-A");
    const parentSession = path.join(root, "workspace-A", "parent.jsonl");
    writeNamedSession("cached-child.jsonl", ["Worker#0123abcd"], parentSession);
    const first = await listSessionsForWorkspace(cwd);
    const expected = { ...first[0]! };
    first[0]!.name = "Caller-local rename";
    delete first[0]!.parentSession;
    first[0]!.isSubagent = false;

    const openSpy = vi.spyOn(fsp, "open");
    const readSpy = vi.spyOn(fsp, "readFile");
    const cached = await listSessionsForWorkspace(cwd);
    expect(cached).toEqual([expected]);
    expect(cached[0]).not.toBe(first[0]);

    cached[0]!.name = "Another caller-local rename";
    delete cached[0]!.isSubagent;
    expect(await listSessionsForWorkspace(cwd)).toEqual([expected]);
    expect(openSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("still applies archive settings on cached child summaries", async () => {
    const cwd = path.join(root, "workspace-A");
    const parentSession = path.join(root, "workspace-A", "parent.jsonl");
    const childFile = writeNamedSession("child.jsonl", ["Worker#0123abcd"], parentSession);
    const forkFile = writeNamedSession("fork.jsonl", ["Normal fork"], parentSession);
    expect(await listSessionsForWorkspace(cwd)).toHaveLength(2);

    saveSettings({ archivedSessions: [childFile] });
    const archived = await listSessionsForWorkspace(cwd);
    expect(archived.map((summary) => summary.filePath)).toEqual([forkFile]);

    saveSettings({ archivedSessions: [] });
    const restored = await listSessionsForWorkspace(cwd);
    expect(restored).toHaveLength(2);
    expect(restored.find((summary) => summary.filePath === childFile)).toMatchObject({
      parentSession,
      isSubagent: true,
    });
  });
});

describe("worktree session discovery", () => {
  function writeHeader(cwd: string, id: string): string {
    // Session files live in a subdirectory of SESSIONS_DIR (the discovery
    // scanner only descends into subdirs, not loose files at the root).
    const dir = path.join(root, "wt-files");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2024-01-01T00:00:00Z",
      cwd,
    });
    fs.writeFileSync(filePath, `${header}\n`, "utf8");
    return filePath;
  }

  it("lists worktree-cwd sessions under their parent workspace", async () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "ws-A-worktrees", "swift-otter");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-swift-otter",
          name: "swift-otter",
          base: "main",
        },
      },
    });

    writeHeader(worktreePath, "wt-session");

    const summaries = await listSessionsForWorkspace(workspace);
    expect(summaries.some((s) => s.filePath.endsWith("wt-session.jsonl"))).toBe(true);
  });

  it("does NOT list a worktree session under an unrelated workspace", async () => {
    const workspaceA = path.join(root, "workspace-A");
    const workspaceB = path.join(root, "workspace-B");
    fs.mkdirSync(workspaceB, { recursive: true });
    const worktreePath = path.join(root, "wt");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: { workspacePath: workspaceA, branch: "pi-vis-x", name: "x", base: "main" },
      },
    });

    writeHeader(worktreePath, "wt-only");

    const summariesB = await listSessionsForWorkspace(workspaceB);
    expect(summariesB.some((s) => s.filePath.endsWith("wt-only.jsonl"))).toBe(false);
  });

  it("keeps listing a worktree session across repeated calls (cache-hit path)", async () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-cached");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: { workspacePath: workspace, branch: "pi-vis-c", name: "c", base: "main" },
      },
    });

    writeHeader(worktreePath, "wt-cached-session");

    const first = await listSessionsForWorkspace(workspace);
    const second = await listSessionsForWorkspace(workspace);
    expect(first.some((s) => s.filePath.endsWith("wt-cached-session.jsonl"))).toBe(true);
    expect(second.some((s) => s.filePath.endsWith("wt-cached-session.jsonl"))).toBe(true);
  });

  it("resolveWorktreeForFile returns identity for a known worktree session", () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-real");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-swift-otter",
          name: "swift-otter",
          base: "main",
        },
      },
    });

    const filePath = writeHeader(worktreePath, "wt-resolve");
    const identity = resolveWorktreeForFile(filePath, workspace);
    expect(identity).toEqual({
      path: worktreePath,
      branch: "pi-vis-swift-otter",
      name: "swift-otter",
      base: "main",
    });
  });

  it("resolveWorktreeForFile returns undefined when the worktree dir is gone", () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-gone"); // never mkdir'd → missing
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-gone",
          name: "gone",
          base: "main",
        },
      },
    });

    const filePath = writeHeader(worktreePath, "wt-missing");
    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
  });

  it("prefers a persisted session override over the immutable header cwd", () => {
    const workspace = path.join(root, "workspace-A");
    const oldWorktree = path.join(root, "wt-old");
    const newWorktree = path.join(root, "wt-new");
    fs.mkdirSync(oldWorktree, { recursive: true });
    fs.mkdirSync(newWorktree, { recursive: true });
    const filePath = writeHeader(oldWorktree, "moved-session");
    saveSettings({
      worktrees: {
        [oldWorktree]: {
          workspacePath: workspace,
          branch: "old-branch",
          name: "old",
          base: "main",
        },
        [newWorktree]: {
          workspacePath: workspace,
          branch: "new-branch",
          name: "new",
          base: "develop",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: newWorktree },
    });

    expect(resolveWorktreeForFile(filePath, workspace)).toEqual({
      path: newWorktree,
      branch: "new-branch",
      name: "new",
      base: "develop",
    });
  });

  it("keeps an originally worktree-based session in Workspace after relaunch", async () => {
    const workspace = path.join(root, "workspace-A");
    const originalWorktree = path.join(root, "wt-original");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(originalWorktree, { recursive: true });
    const filePath = writeHeader(originalWorktree, "returned-to-workspace");
    saveSettings({
      worktrees: {
        [originalWorktree]: {
          workspacePath: workspace,
          branch: "original-branch",
          name: "original",
          base: "main",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: path.resolve(workspace) },
    });

    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
    expect((await listSessionsForWorkspace(workspace)).map((item) => item.filePath)).toContain(
      filePath,
    );
  });

  it("does not resurrect the old header cwd when an explicit override is stale", async () => {
    const workspace = path.join(root, "workspace-A");
    const oldWorktree = path.join(root, "wt-still-valid");
    const missingOverride = path.join(root, "wt-missing-override");
    fs.mkdirSync(oldWorktree, { recursive: true });
    const filePath = writeHeader(oldWorktree, "stale-move");
    saveSettings({
      worktrees: {
        [oldWorktree]: {
          workspacePath: workspace,
          branch: "old-branch",
          name: "old",
          base: "main",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: missingOverride },
    });

    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
    // Runtime falls back to Workspace, but the stale record still belongs in
    // its parent workspace's sidebar on both parse and cache-hit paths.
    expect((await listSessionsForWorkspace(workspace)).map((item) => item.filePath)).toContain(
      filePath,
    );
    expect((await listSessionsForWorkspace(workspace)).map((item) => item.filePath)).toContain(
      filePath,
    );
  });

  it("uses the override cwd for fresh and cached workspace ownership checks", async () => {
    const workspace = path.join(root, "workspace-A");
    const oldWorkspace = path.join(root, "workspace-before-move");
    const worktreePath = path.join(root, "wt-after-move");
    fs.mkdirSync(oldWorkspace, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    const filePath = writeHeader(oldWorkspace, "ownership-move");
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "moved-branch",
          name: "moved",
          base: "main",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: worktreePath },
    });

    const fresh = await listSessionsForWorkspace(workspace);
    const cached = await listSessionsForWorkspace(workspace);
    expect(fresh.map((summary) => summary.filePath)).toContain(filePath);
    expect(cached.map((summary) => summary.filePath)).toContain(filePath);

    // The same immutable header must no longer make the session belong to its
    // pre-switch workspace once the explicit override exists.
    expect(await listSessionsForWorkspace(oldWorkspace)).toHaveLength(0);
  });

  it("rejects a persisted override replaced by a plain directory", async () => {
    const workspace = path.join(root, "workspace-A");
    initRepo(workspace);
    const reusedPath = path.join(root, "reused-plain");
    fs.mkdirSync(reusedPath);
    const filePath = writeHeader(workspace, "reused-plain-session");
    saveSettings({
      worktrees: {
        [reusedPath]: {
          workspacePath: workspace,
          branch: "stale-branch",
          name: "stale",
          base: "main",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: reusedPath },
    });

    expect(await resolveValidatedWorktreeForFile(filePath, workspace)).toBeUndefined();
  });

  it("rejects a persisted override replaced by an unrelated repository", async () => {
    const workspace = path.join(root, "workspace-A");
    initRepo(workspace);
    const unrelated = path.join(root, "unrelated");
    initRepo(unrelated);
    const filePath = writeHeader(workspace, "reused-repo-session");
    saveSettings({
      worktrees: {
        [unrelated]: {
          workspacePath: workspace,
          branch: "stale-branch",
          name: "stale",
          base: "main",
        },
      },
      sessionWorktrees: { [path.resolve(filePath)]: unrelated },
    });

    expect(await resolveValidatedWorktreeForFile(filePath, workspace)).toBeUndefined();
  });

  it("resolveWorktreeForFile returns undefined for a plain workspace session", () => {
    const workspace = path.join(root, "workspace-A");
    const filePath = writeHeader(workspace, "plain-session");
    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
  });
});
