import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { forceKillProcessTree } from "./force-kill-process-tree.js";

describe("emergency process-tree termination", () => {
  it.skipIf(process.platform === "win32")(
    "kills a host and a separately detached tool that ignores SIGTERM",
    async () => {
      const host = fork(
        "-e",
        [
          'const {spawn}=require("node:child_process"); const tool=spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'],{detached:true,stdio:"ignore"}); process.on("SIGTERM",()=>{});process.send(tool.pid);setInterval(()=>{},1000)',
        ],
        { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      let toolPid: number | undefined;
      try {
        [toolPid] = (await once(host, "message")) as [number];
        const exit = once(host, "exit");
        forceKillProcessTree(host.pid!);
        await expect(exit).resolves.toEqual([null, "SIGKILL"]);
        await expect
          .poll(() => {
            try {
              process.kill(toolPid!, 0);
              // An orphan may briefly remain as a dead zombie until init reaps it.
              const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(toolPid)], {
                encoding: "utf8",
              }).stdout.trim();
              return status === "" || status.startsWith("Z");
            } catch {
              return true;
            }
          })
          .toBe(true);
      } finally {
        if (host.pid) {
          try {
            process.kill(-host.pid, "SIGKILL");
          } catch {}
        }
        if (toolPid) {
          try {
            process.kill(-toolPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );
});
