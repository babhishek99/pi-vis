import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { captureProcessOutput, resolveWindowsSystemUtilityPath } from "./bounded-process.js";

// Poll real child readiness/exit without advancing capture cleanup's fake clock.
const realSetTimeout = setTimeout;

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 20));
  }
  return !processExists(pid);
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Creation can be observed before writeFileSync has written the PID/readiness bytes.
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

describe("captureProcessOutput", () => {
  it("captures a successful bounded command and releases cancellation ownership", async () => {
    const controller = new AbortController();
    await expect(
      captureProcessOutput(process.execPath, ["-e", 'process.stdout.write("ready")'], {
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ stdout: "ready", stderr: "" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("settles at its deadline when a descendant inherits the capture pipes", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-bounded-inherited-pipe-"));
    const pidPath = path.join(testRoot, "descendant.pid");
    const readyPath = path.join(testRoot, "descendant.ready");
    let descendantPid: number | undefined;
    try {
      const descendantSource = [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        "setInterval(() => {}, 10_000);",
      ].join("\n");
      const leaderSource = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}],`,
        '  { stdio: ["ignore", 1, 2] });',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        "setInterval(() => {}, 10_000);",
      ].join("\n");
      const startedAt = Date.now();
      const capture = captureProcessOutput(process.execPath, ["-e", leaderSource], {
        timeoutMs: 1_500,
      });

      await expect(waitForPath(readyPath, 1_000)).resolves.toBe(true);
      descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expect(capture).rejects.toThrow("timed out");
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      // Rejection continuations run before later-turn tree cleanup. The live
      // descendant proves settlement did not wait for its inherited pipes.
      expect(processExists(descendantPid)).toBe(true);
      await expect(waitForProcessExit(descendantPid, 3_000)).resolves.toBe(true);
    } finally {
      if (descendantPid !== undefined && processExists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failing regression test.
        }
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "SIGKILLs an inherited-pipe descendant that ignores SIGTERM after its leader exits",
    async () => {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-bounded-process-"));
      const pidPath = path.join(testRoot, "descendant.pid");
      const readyPath = path.join(testRoot, "descendant.ready");
      let descendantPid: number | undefined;
      try {
        const descendantSource = [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
          "setInterval(() => {}, 10_000);",
        ].join("\n");
        const leaderSource = [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}],`,
          '  { stdio: ["ignore", 1, 2] });',
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          "child.unref();",
        ].join("\n");

        const capture = captureProcessOutput(process.execPath, ["-e", leaderSource], {
          timeoutMs: 2_000,
        });
        await expect(waitForPath(readyPath, 1_500)).resolves.toBe(true);
        await expect(capture).rejects.toThrow("timed out");

        descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        await expect(waitForProcessExit(descendantPid, 2_000)).resolves.toBe(true);
      } finally {
        if (descendantPid !== undefined && processExists(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Best-effort cleanup for a failing regression test.
          }
        }
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it("does not spawn an already-aborted capture", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureProcessOutput("/not/an/executable", [], {
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("cancels a running capture and cleans up its process group before the ordinary deadline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-bounded-abort-"));
    const ready = path.join(root, "ready");
    const controller = new AbortController();
    let pid: number | undefined;
    try {
      const source = `require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 10_000);`;
      const capture = captureProcessOutput(process.execPath, ["-e", source], {
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      const rejected = expect(capture).rejects.toMatchObject({ kind: "cancelled" });
      expect(await waitForPath(ready, 2_000)).toBe(true);
      pid = Number(fs.readFileSync(ready, "utf8"));
      const kill = vi.spyOn(process, "kill");
      try {
        controller.abort();
        // App quit can finish in the promise continuation: cancellation must
        // signal the group now, not in a later event-loop cleanup timer.
        if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
      } finally {
        kill.mockRestore();
      }
      await rejected;
      expect(await waitForProcessExit(pid, 3_000)).toBe(true);
    } finally {
      controller.abort();
      if (pid !== undefined && processExists(pid)) process.kill(pid, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it
    .skipIf(process.platform === "win32")
    .each(
      ["timeout", "output-limit"].flatMap((kind) =>
        ["before-term", "after-term", "no-abort"].map((phase) => ({ kind, phase })),
      ),
    )("retains group cleanup ownership after $kind ($phase)", async ({ kind, phase }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-bounded-settled-abort-"));
    const leaderPidPath = path.join(root, "leader.pid");
    const descendantPidPath = path.join(root, "descendant.pid");
    const readyPath = path.join(root, "ready");
    const releasePath = path.join(root, "release-output");
    const controller = new AbortController();
    let leaderPid: number | undefined;
    let descendantPid: number | undefined;
    const kill = vi.spyOn(process, "kill");
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"],
    });
    try {
      const descendantSource = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        'process.stdout.on("error", () => {});',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        ...(kind === "output-limit"
          ? [
              "const gate = setInterval(() => {",
              `  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;`,
              "  clearInterval(gate);",
              '  process.stdout.write("x".repeat(1024));',
              "}, 10);",
            ]
          : []),
        "setInterval(() => {}, 10_000);",
      ].join("\n");
      const leaderSource = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));`,
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}],`,
        '  { stdio: ["ignore", 1, 2] });',
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 10_000);",
      ].join("\n");
      const capture = captureProcessOutput(process.execPath, ["-e", leaderSource], {
        timeoutMs: 60_000,
        maxBufferBytes: 128,
        signal: controller.signal,
      });
      const rejected = capture.catch((error: unknown) => error);
      expect(await waitForPath(readyPath, 2_000)).toBe(true);
      expect(await waitForPath(descendantPidPath, 2_000)).toBe(true);
      leaderPid = Number(fs.readFileSync(leaderPidPath, "utf8"));
      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);

      if (kind === "timeout") vi.advanceTimersToNextTimer();
      else fs.writeFileSync(releasePath, "release");
      const failure = await rejected;
      expect(failure).toMatchObject({ kind });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

      if (phase !== "before-term") {
        vi.advanceTimersToNextTimer(); // Deferred SIGTERM, not the grace deadline.
        expect(kill).toHaveBeenCalledWith(-leaderPid, "SIGTERM");
        expect(await waitForProcessExit(leaderPid, 2_000)).toBe(true);
        // A leader's close must not release ownership of its resistant descendant.
        expect(processExists(descendantPid)).toBe(true);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      }
      if (phase === "no-abort") {
        vi.advanceTimersByTime(249);
        expect(kill).not.toHaveBeenCalledWith(-leaderPid, "SIGKILL");
        expect(processExists(descendantPid)).toBe(true);
        vi.advanceTimersByTime(1);
      } else {
        controller.abort();
        // No await: shutdown must signal the group before abort() returns,
        // even though the original failure has already reached its caller.
      }
      expect(kill).toHaveBeenCalledWith(-leaderPid, "SIGKILL");
      expect(await rejected).toBe(failure);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      const signals = () => kill.mock.calls.filter(([, signal]) => signal !== 0);
      const expectedSignals = [
        ...(phase === "before-term" ? [] : [[-leaderPid, "SIGTERM"]]),
        [-leaderPid, "SIGKILL"],
      ];
      expect(signals()).toEqual(expectedSignals);
      vi.runAllTimers();
      expect(signals()).toEqual(expectedSignals);
      expect(await waitForProcessExit(leaderPid, 2_000)).toBe(true);
      expect(await waitForProcessExit(descendantPid, 2_000)).toBe(true);
    } finally {
      controller.abort();
      vi.runAllTimers();
      vi.useRealTimers();
      kill.mockRestore();
      if (leaderPid === undefined && fs.existsSync(leaderPidPath))
        leaderPid = Number(fs.readFileSync(leaderPidPath, "utf8"));
      if (leaderPid !== undefined && Number.isSafeInteger(leaderPid) && leaderPid > 1) {
        try {
          process.kill(-leaderPid, "SIGKILL");
        } catch {
          // Best-effort cleanup even when a regression assertion fails.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates capture when the aggregate output bound is exceeded", async () => {
    await expect(
      captureProcessOutput(process.execPath, ["-e", 'process.stdout.write("x".repeat(1024))'], {
        timeoutMs: 2_000,
        maxBufferBytes: 128,
      }),
    ).rejects.toThrow("exceeded 128 bytes");
  });
});

describe("resolveWindowsSystemUtilityPath", () => {
  it("uses absolute System32 paths and never falls back to PATH", () => {
    const env = { SystemRoot: "C:\\Windows", PATH: "Z:\\attacker-controlled" };

    expect(resolveWindowsSystemUtilityPath(env, "taskkill.exe")).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsSystemUtilityPath(env, "where.exe")).toBe(
      "C:\\Windows\\System32\\where.exe",
    );
    expect(
      resolveWindowsSystemUtilityPath({ PATH: "Z:\\attacker-controlled" }, "taskkill.exe"),
    ).toBeNull();
    expect(resolveWindowsSystemUtilityPath({ SystemRoot: "Windows" }, "where.exe")).toBeNull();
    expect(resolveWindowsSystemUtilityPath({ SystemRoot: "\\Windows" }, "where.exe")).toBeNull();
    expect(
      resolveWindowsSystemUtilityPath({ SystemRoot: "\\\\server\\Windows" }, "taskkill.exe"),
    ).toBeNull();
  });
});
