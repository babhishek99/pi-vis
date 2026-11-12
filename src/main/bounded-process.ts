import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const FORCE_KILL_GRACE_MS = 250;

export type BoundedProcessFailureKind =
  | "timeout"
  | "output-limit"
  | "nonzero-exit"
  | "not-found"
  | "spawn-failed"
  | "cancelled";

export class BoundedProcessError extends Error {
  constructor(
    readonly kind: Exclude<BoundedProcessFailureKind, "not-found" | "spawn-failed">,
    message: string,
  ) {
    super(message);
    this.name = "BoundedProcessError";
  }
}

/** Classify a capture failure without copying command output or environment values. */
export function boundedProcessFailureKind(error: unknown): BoundedProcessFailureKind {
  if (error instanceof BoundedProcessError) return error.kind;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return "not-found";
  }
  return "spawn-failed";
}

export interface BoundedCaptureOptions {
  timeoutMs: number;
  maxBufferBytes?: number | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
}

export interface BoundedCaptureResult {
  stdout: string;
  stderr: string;
}

/** Resolve a trusted Windows system utility without consulting PATH. */
export function resolveWindowsSystemUtilityPath(
  env: NodeJS.ProcessEnv,
  executableName: "taskkill.exe" | "where.exe",
): string | null {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  // A normal Windows SystemRoot is drive-qualified. Reject UNC and
  // root-relative values so cleanup/lookup cannot turn into a remote or
  // current-drive filesystem access before the child-side timeout applies.
  if (!systemRoot || !/^[A-Za-z]:[\\/]/u.test(systemRoot)) return null;
  return path.win32.join(systemRoot, "System32", executableName);
}

function signalProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    const taskkillPath = resolveWindowsSystemUtilityPath(process.env, "taskkill.exe");
    if (taskkillPath) {
      try {
        // Node cannot signal a Windows process group. `taskkill /t` covers any
        // shell-startup descendants. Resolve it only from System32; PATH must
        // never select cleanup code. The direct kill below remains a fallback.
        const killer = spawn(taskkillPath, ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        let fellBack = false;
        const fallbackToDirectChild = (): void => {
          if (fellBack) return;
          fellBack = true;
          try {
            child.kill(signal);
          } catch {
            // Cleanup remains best effort after caller settlement.
          }
        };
        killer.once("error", fallbackToDirectChild);
        killer.once("close", (code) => {
          if (code !== 0) fallbackToDirectChild();
        });
        killer.unref();
        // Let taskkill enumerate the tree before the leader can disappear.
        // Killing the leader here would race that enumeration and orphan its
        // descendants. The direct-child fallback runs only if taskkill fails.
        return;
      } catch {
        // Fall through to the direct-child signal.
      }
    }
  } else if (pid) {
    try {
      // Bounded captures are spawned as process-group leaders. Kill the group
      // so a descendant that inherited stdout/stderr cannot outlive the bound.
      process.kill(-pid, signal);
      return;
    } catch {
      // The group may have exited between the deadline and this signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cleanup is best effort after the caller-facing deadline has fired.
  }
}

/**
 * Capture a small subprocess result with a hard caller-facing deadline once
 * the child has been created. Synchronous OS work inside `spawn()` itself is
 * outside JavaScript timer control.
 *
 * `execFile` waits for inherited stdout/stderr handles to close even after its
 * direct child times out. Interactive shell startup files can launch a
 * descendant that retains those handles and strand startup indefinitely. This
 * helper owns a process group, destroys its local pipe readers, settles at the
 * deadline, and starts best-effort tree cleanup on the next event-loop turn.
 */
export function captureProcessOutput(
  file: string,
  args: readonly string[],
  options: BoundedCaptureOptions,
): Promise<BoundedCaptureResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new TypeError("timeoutMs must be a positive safe integer"));
  }
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    return Promise.reject(new TypeError("maxBufferBytes must be a positive safe integer"));
  }

  if (options.signal?.aborted) {
    return Promise.reject(new BoundedProcessError("cancelled", "Process capture cancelled"));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let cleanupPending = false;
    let cleanupImmediate: ReturnType<typeof setImmediate> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(
      () =>
        terminate(
          new BoundedProcessError("timeout", `Process timed out after ${options.timeoutMs}ms`),
        ),
      options.timeoutMs,
    );

    const releaseCleanup = (): void => {
      cleanupPending = false;
      if (cleanupImmediate !== undefined) clearImmediate(cleanupImmediate);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      cleanupImmediate = undefined;
      forceKillTimer = undefined;
      options.signal?.removeEventListener("abort", onAbort);
    };

    const forceKill = (): void => {
      if (!cleanupPending) return;
      releaseCleanup();
      signalProcessTree(child, "SIGKILL");
    };

    const finish = (result: BoundedCaptureResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      // A rejected capture can still own a live group, even after its leader
      // closes. Keep cancellation until its pending forced cleanup is issued.
      if (!cleanupPending) releaseCleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const terminate = (error: Error, immediateKill = false): void => {
      if (settled) {
        if (immediateKill) forceKill();
        return;
      }
      cleanupPending = true;
      // Caller settlement is the hard boundary. Close our pipe readers and
      // reject before tree cleanup, because even starting an OS cleanup helper
      // can block. Signaling begins on a later event-loop turn.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(error);
      if (immediateKill) {
        // Explicit cancellation is also used during app quit. Signal before
        // its promise continuation can terminate the main event loop; a
        // deferred cleanup timer would otherwise strand the read-only child.
        forceKill();
        return;
      }
      cleanupImmediate = setImmediate(() => {
        cleanupImmediate = undefined;
        signalProcessTree(child, "SIGTERM");
        if (cleanupPending) {
          forceKillTimer = setTimeout(forceKill, FORCE_KILL_GRACE_MS);
          forceKillTimer.unref?.();
        }
      });
    };

    const onAbort = (): void => {
      terminate(new BoundedProcessError("cancelled", "Process capture cancelled"), true);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // A synchronous spawn wrapper may have aborted between the initial check
    // and listener registration. It still owns the same cleanup path.
    if (options.signal?.aborted) onAbort();

    const capture = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += value.length;
      if (capturedBytes > maxBufferBytes) {
        terminate(
          new BoundedProcessError(
            "output-limit",
            `Process output exceeded ${maxBufferBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(value);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => capture(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture(stderrChunks, chunk));
    child.once("error", (error) => terminate(error));
    child.once("close", (code, signal) => {
      // A terminated leader can close after we destroy its local pipe readers
      // while a descendant that inherited those descriptors is still alive.
      // Keep the scheduled SIGKILL escalation in that case.
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        finish({ stdout, stderr });
        return;
      }
      const suffix = signal ? ` (${signal})` : "";
      finish(
        new BoundedProcessError(
          "nonzero-exit",
          `Process exited with code ${code ?? "null"}${suffix}`,
        ),
      );
    });
  });
}
