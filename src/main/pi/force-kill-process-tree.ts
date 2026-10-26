import { spawnSync } from "node:child_process";
import path from "node:path";

/** Kill detached tool/PTY groups as well as ordinary host descendants. */
export function forceKillProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot)) {
      spawnSync(
        path.win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: 500,
        },
      );
    }
    return;
  }
  // Capture before killing the leader: afterwards detached PTYs and tools are
  // reparented and can no longer be identified as this host's descendants.
  const table = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 250,
    maxBuffer: 4 * 1024 * 1024,
  });
  const children = new Map<number, number[]>();
  for (const line of (table.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const tree = [pid];
  const seen = new Set(tree);
  for (let index = 0; index < tree.length; index++) {
    for (const child of children.get(tree[index]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      tree.push(child);
    }
  }
  for (const target of tree.reverse()) {
    // A PTY or Pi bash may lead its own group. Signal both forms, since an
    // ordinary descendant need not be a group leader at all.
    for (const signalTarget of [-target, target]) {
      try {
        process.kill(signalTarget, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }
}
