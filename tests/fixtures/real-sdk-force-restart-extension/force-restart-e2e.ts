import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function forceRestartE2E(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    fs.writeFileSync(join(process.cwd(), "restart-host.pid"), String(process.pid));
  });
  pi.registerTool({
    name: "e2e-unkillable-tool",
    label: "E2E hanging tool",
    description: "Starts a detached child and ignores cancellation until the host is killed.",
    parameters: { type: "object", properties: {}, "~kind": "Object" } as never,
    async execute() {
      const child = spawn(
        process.execPath,
        ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        { detached: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      fs.writeFileSync(join(process.cwd(), "restart-tool.pid"), String(child.pid));
      await new Promise<never>(() => {});
      return { content: [], details: {} };
    },
  });
}
