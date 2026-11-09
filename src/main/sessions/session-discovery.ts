import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionSummary, WorktreeIdentity } from "@shared/ipc-contract.js";
import { SessionHeaderSchema } from "@shared/session-file/entries.js";
import { isSubagentSession } from "@shared/subagent-sessions.js";
import { inspectWorktree } from "../git/git.js";
import { getSettings } from "../settings-store.js";
import { mapLimit } from "../util/concurrency.js";

// Read per call so tests can override PIVIS_SESSIONS_DIR.
function getSessionsDir(): string {
  return process.env["PIVIS_SESSIONS_DIR"] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
}

// Cache: filePath → { mtime, summary }. Summaries never escape by reference.
const cache = new Map<string, { mtime: number; summary: Readonly<SessionSummary> }>();

// Discovery runs on the main process IPC path. Never read arbitrarily large
// session files into memory while listing the sidebar; sample the start (for
// preview) and the end (for recent session_info / user activity) instead.
const SESSION_META_CHUNK_BYTES = 1024 * 1024;

async function readFirstLineAsync(filePath: string): Promise<string | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function readFirstLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Parse a session-file entry timestamp (ISO string or epoch-ms number)
 *  into epoch milliseconds. Returns `undefined` for missing/unparseable
 *  values so callers can skip them when computing a max. */
function toEpochMs(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export interface ExtractedSessionMeta {
  preview: string;
  messageCount: number;
  name: string | null;
  /** False when bounded sampling may have skipped a newer rename. An uncertain
   *  display name must never be used as positive evidence for hiding a session. */
  nameIsAuthoritative?: false;
  /** Epoch-ms of the most recent *user-authored* entry (prompt or `!bash`),
   *  derived from the sampled session file. Unlike `mtime`, this is unaffected
   *  by passive operations (e.g. merely opening a session, which makes pi
   *  append a `session_info` entry and bump the file mtime). Used as the
   *  persistent sidebar sort key so a session you actively worked in stays
   *  above ones you only glanced at. `null` when the sampled file has no user
   *  messages (e.g. brand-new/empty sessions) — callers fall back to `mtime`. */
  lastActiveAt: number | null;
}

function parseSessionMetaLines(
  lines: string[],
  authoritativeNamesStartAt = 0,
): ExtractedSessionMeta {
  let preview = "";
  let messageCount = 0;
  let name: string | null = null;
  let nameIsAuthoritative = authoritativeNamesStartAt === 0;
  let lastActiveAt: number | null = null;

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry["type"] === "message") {
        // Real pi v3 nests message data under a `message` key.
        const msg = entry["message"] as Record<string, unknown> | undefined;
        if (msg && msg["role"] === "user") {
          messageCount++;
          // Track the most recent user-authored activity. Prefer the
          // entry-level timestamp; fall back to the message-level one
          // (pi v3 also stamps the nested message object).
          const ms = toEpochMs(entry["timestamp"]) ?? toEpochMs(msg["timestamp"]);
          if (ms !== undefined && (lastActiveAt === null || ms > lastActiveAt)) {
            lastActiveAt = ms;
          }
          if (!preview) {
            const body = msg["content"];
            if (typeof body === "string") {
              preview = body.slice(0, 100);
            } else if (Array.isArray(body)) {
              const first = body[0] as Record<string, unknown> | undefined;
              if (first && typeof first["text"] === "string") {
                preview = first["text"].slice(0, 100);
              }
            }
          }
        }
      }
      if (entry["type"] === "session_info" && typeof entry["name"] === "string") {
        // Pinned Pi treats an empty/whitespace name as an explicit clear.
        name = entry["name"].trim() ? entry["name"] : "";
        nameIsAuthoritative = index >= authoritativeNamesStartAt;
      }
    } catch {
      /* skip bad lines */
    }
  }

  return {
    preview,
    messageCount,
    name,
    lastActiveAt,
    ...(nameIsAuthoritative ? {} : { nameIsAuthoritative: false as const }),
  };
}

function linesFromBoundedChunks(
  head: string,
  tail?: string,
  tailStartsAtLineBoundary = false,
): { lines: string[]; tailLineStart: number } {
  const lines: string[] = [];
  const headParts = head.split("\n");
  const headComplete = head.endsWith("\n");
  lines.push(...(headComplete ? headParts : headParts.slice(0, -1)));
  const tailLineStart = lines.length;

  if (tail !== undefined) {
    const tailParts = tail.split("\n");
    // The tail chunk usually starts in the middle of a JSONL row; drop that
    // partial first line. If it starts immediately after a newline, keep it —
    // otherwise a complete boundary-aligned entry (often the newest metadata)
    // is lost from the sidebar sample.
    lines.push(...(tailStartsAtLineBoundary ? tailParts : tailParts.slice(1)));
  }

  return { lines, tailLineStart };
}

function extractSessionMetaFromSample(
  head: string,
  tail?: string,
  tailStartsAtLineBoundary = false,
  skippedMiddle = false,
): ExtractedSessionMeta {
  const { lines, tailLineStart } = linesFromBoundedChunks(head, tail, tailStartsAtLineBoundary);
  // A rename may be in the unread middle or the discarded boundary row. Only
  // metadata after that uncertainty can positively classify a generated child.
  return parseSessionMetaLines(
    lines,
    tail !== undefined && (skippedMiddle || !tailStartsAtLineBoundary) ? tailLineStart : 0,
  );
}

interface SessionMetaSample {
  head: string;
  tail?: string;
  tailStartsAtLineBoundary?: boolean;
  skippedMiddle?: boolean;
}

async function readSessionMetaSample(filePath: string): Promise<SessionMetaSample> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= SESSION_META_CHUNK_BYTES) {
    return { head: await fsp.readFile(filePath, "utf8") };
  }

  const handle = await fsp.open(filePath, "r");
  try {
    const headBuffer = Buffer.alloc(SESSION_META_CHUNK_BYTES);
    const { bytesRead: headBytes } = await handle.read(headBuffer, 0, SESSION_META_CHUNK_BYTES, 0);
    const tailSize = Math.min(SESSION_META_CHUNK_BYTES, stat.size - headBytes);
    const tailBuffer = Buffer.alloc(tailSize);
    const tailStart = Math.max(headBytes, stat.size - tailSize);
    const prevByte = Buffer.alloc(1);
    const { bytesRead: prevBytes } = await handle.read(prevByte, 0, 1, tailStart - 1);
    const tailStartsAtLineBoundary = prevBytes === 1 && prevByte[0] === 0x0a;
    const { bytesRead: tailBytes } = await handle.read(tailBuffer, 0, tailSize, tailStart);
    return {
      head: headBuffer.slice(0, headBytes).toString("utf8"),
      tail: tailBuffer.slice(0, tailBytes).toString("utf8"),
      tailStartsAtLineBoundary,
      skippedMiddle: tailStart > headBytes,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function readSessionMetaSampleSync(filePath: string): SessionMetaSample {
  const stat = fs.statSync(filePath);
  if (stat.size <= SESSION_META_CHUNK_BYTES) {
    return { head: fs.readFileSync(filePath, "utf8") };
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const headBuffer = Buffer.alloc(SESSION_META_CHUNK_BYTES);
    const headBytes = fs.readSync(fd, headBuffer, 0, SESSION_META_CHUNK_BYTES, 0);
    const tailSize = Math.min(SESSION_META_CHUNK_BYTES, stat.size - headBytes);
    const tailBuffer = Buffer.alloc(tailSize);
    const tailStart = Math.max(headBytes, stat.size - tailSize);
    const prevByte = Buffer.alloc(1);
    const prevBytes = fs.readSync(fd, prevByte, 0, 1, tailStart - 1);
    const tailStartsAtLineBoundary = prevBytes === 1 && prevByte[0] === 0x0a;
    const tailBytes = fs.readSync(fd, tailBuffer, 0, tailSize, tailStart);
    return {
      head: headBuffer.slice(0, headBytes).toString("utf8"),
      tail: tailBuffer.slice(0, tailBytes).toString("utf8"),
      tailStartsAtLineBoundary,
      skippedMiddle: tailStart > headBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export async function extractSessionMetaAsync(filePath: string): Promise<ExtractedSessionMeta> {
  try {
    const { head, tail, tailStartsAtLineBoundary, skippedMiddle } =
      await readSessionMetaSample(filePath);
    return extractSessionMetaFromSample(head, tail, tailStartsAtLineBoundary, skippedMiddle);
  } catch {
    return { preview: "", messageCount: 0, name: null, lastActiveAt: null };
  }
}

export function extractSessionMeta(filePath: string): ExtractedSessionMeta {
  try {
    const { head, tail, tailStartsAtLineBoundary, skippedMiddle } =
      readSessionMetaSampleSync(filePath);
    return extractSessionMetaFromSample(head, tail, tailStartsAtLineBoundary, skippedMiddle);
  } catch {
    return { preview: "", messageCount: 0, name: null, lastActiveAt: null };
  }
}

/**
 * Resolve a session file to its worktree identity, if it belongs to a
 * known worktree of `workspacePath`. Reads the header `cwd` and looks it
 * up in settings.worktrees (persisted at worktree-creation time). Returns
 * undefined for normal workspace sessions, for sessions whose worktree
 * was deleted from disk (so pi spawns in the workspace instead of a
 * missing cwd), or when the worktree belongs to a different workspace.
 */
export function resolveWorktreeForFile(
  filePath: string,
  workspacePath: string,
): WorktreeIdentity | undefined {
  const first = readFirstLine(filePath);
  if (!first) return undefined;
  let header: { cwd?: unknown } | undefined;
  try {
    header = JSON.parse(first) as { cwd?: unknown };
  } catch {
    return undefined;
  }
  const settings = getSettings();
  // A persisted move is authoritative over Pi's immutable JSONL header.
  // Crucially, a stale override must not fall through to the old header cwd:
  // doing so would resurrect the location the user explicitly switched away
  // from after relaunch.
  const override = settings.sessionWorktrees?.[path.resolve(filePath)];
  const cwd = override ?? (typeof header?.cwd === "string" ? header.cwd : undefined);
  if (!cwd || cwd === workspacePath) return undefined;
  const wt = settings.worktrees?.[cwd];
  if (!wt || wt.workspacePath !== workspacePath) return undefined;
  // Don't claim a worktree whose directory no longer exists — the session
  // would otherwise try to spawn pi in a missing cwd. Fall back to the
  // workspace so the session is still openable.
  if (!fs.existsSync(cwd)) return undefined;
  return { path: cwd, branch: wt.branch, name: wt.name, base: wt.base };
}

export async function resolveValidatedWorktreeForFile(
  filePath: string,
  workspacePath: string,
): Promise<WorktreeIdentity | undefined> {
  const persisted = resolveWorktreeForFile(filePath, workspacePath);
  if (!persisted) return undefined;
  const inspected = await inspectWorktree(workspacePath, persisted.path, workspacePath, true);
  if (inspected.kind === "error" || inspected.path !== persisted.path) return undefined;
  return {
    path: inspected.path,
    branch: inspected.branch,
    name: inspected.name,
    base: persisted.base,
  };
}

export async function listSessionsForWorkspace(workspacePath: string): Promise<SessionSummary[]> {
  const results: SessionSummary[] = [];
  const SESSIONS_DIR = getSessionsDir();

  try {
    const stat = await fsp.stat(SESSIONS_DIR);
    if (!stat.isDirectory()) return results;
  } catch {
    return results;
  }

  // Worktrees belonging to this workspace. A session whose header `cwd` is
  // one of these worktree paths is shown under the parent workspace even
  // though its file lives elsewhere on disk (pi writes the worktree cwd
  // into the header). Without this, worktree sessions vanish on relaunch.
  const settings = getSettings();
  const worktreeCwds = new Set<string>();
  for (const [wtPath, wt] of Object.entries(settings.worktrees ?? {})) {
    if (wt.workspacePath === workspacePath) worktreeCwds.add(wtPath);
  }

  let sessionDirEntries: fs.Dirent[];
  try {
    sessionDirEntries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return results;
  }

  const filePaths: string[] = [];
  for (const subdir of sessionDirEntries) {
    if (!subdir.isDirectory()) continue;
    const subdirPath = path.join(SESSIONS_DIR, subdir.name);
    try {
      const files = await fsp.readdir(subdirPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".jsonl")) {
          filePaths.push(path.join(subdirPath, file.name));
        }
      }
    } catch {}
  }

  const summaries = await mapLimit(
    filePaths,
    16,
    async (filePath): Promise<SessionSummary | null> => {
      let mtime: number;
      try {
        mtime = (await fsp.stat(filePath)).mtimeMs;
      } catch {
        return null;
      }

      // A valid session-file override is authoritative even on cache hits.
      // If its association has gone stale, keep using the immutable header only
      // to recover the parent workspace for sidebar ownership; runtime
      // resolution still returns Workspace and must not resurrect that old cwd.
      const belongsToWorkspace = (headerCwd: string): boolean => {
        const override = settings.sessionWorktrees?.[path.resolve(filePath)];
        if (override !== undefined) {
          const target = settings.worktrees?.[override];
          if (target) return target.workspacePath === workspacePath;
          return (
            headerCwd === workspacePath ||
            settings.worktrees?.[headerCwd]?.workspacePath === workspacePath
          );
        }
        return headerCwd === workspacePath || worktreeCwds.has(headerCwd);
      };

      // Check cache
      const cached = cache.get(filePath);
      if (cached && cached.mtime === mtime) {
        return belongsToWorkspace(cached.summary.cwd) ? { ...cached.summary } : null;
      }

      const headerLine = await readFirstLineAsync(filePath);
      if (!headerLine) return null;

      let header: ReturnType<typeof SessionHeaderSchema.safeParse>;
      try {
        header = SessionHeaderSchema.safeParse(JSON.parse(headerLine));
      } catch {
        return null;
      }

      if (!header.success) return null;

      const { preview, messageCount, name, nameIsAuthoritative, lastActiveAt } =
        await extractSessionMetaAsync(filePath);

      const summary: SessionSummary = {
        filePath,
        id: header.data.id,
        ...(name ? { name } : {}),
        ...(header.data.parentSession?.trim() ? { parentSession: header.data.parentSession } : {}),
        ...(nameIsAuthoritative !== false && isSubagentSession(header.data, name)
          ? { isSubagent: true }
          : {}),
        mtime,
        ...(lastActiveAt !== null ? { lastActiveAt } : {}),
        preview,
        messageCount,
        cwd: header.data.cwd,
      };

      // Cache entries for ALL workspaces, not just the one we are
      // enumerating. Without this, switching workspaces re-parses every
      // file from disk on each call.
      cache.set(filePath, { mtime, summary: { ...summary } });
      return belongsToWorkspace(header.data.cwd) ? summary : null;
    },
  );
  results.push(...summaries.filter((s): s is SessionSummary => s !== null));

  // Sort by most recent *user activity* first (prompts / `!bash`), falling
  // back to file mtime for sessions with no user messages (e.g. brand-new or
  // externally-created sessions). This is the persistent ordering the sidebar
  // relies on: unlike mtime it isn't bumped by merely opening a session.
  results.sort(
    (a, b) =>
      (b.lastActiveAt ?? b.mtime) - (a.lastActiveAt ?? a.mtime) ||
      a.filePath.localeCompare(b.filePath),
  );

  // Filter out archived sessions
  const archived = new Set(getSettings().archivedSessions);
  return results.filter((s) => !archived.has(s.filePath));
}
