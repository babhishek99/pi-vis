import { randomUUID } from "node:crypto";
import { ACTIVITY_RPC_TIMEOUT_MS, readActivitySnapshot } from "./subagent-activity-limits.mjs";

/** One runtime's public EventBus; never a global registry or history lookup. */
export function createSubagentActivityClient(events) {
  function request(channel) {
    const requestId = randomUUID();
    let unsubscribe;
    let timer;
    let done = false;
    return new Promise((resolve) => {
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          unsubscribe?.();
        } catch {
          /* cleanup must not expose extension errors */
        }
        resolve(value);
      };
      try {
        unsubscribe = events.on(`${channel}:reply:${requestId}`, (reply) => finish({ reply }));
        timer = setTimeout(() => finish({ timeout: true }), ACTIVITY_RPC_TIMEOUT_MS);
        timer.unref?.();
        events.emit(channel, { requestId });
      } catch {
        finish({ failed: true });
      }
    });
  }

  return {
    async read() {
      try {
        const ping = await request("subagents:rpc:ping");
        if (ping.timeout) return { status: "unavailable" };
        if (ping.failed || ping.reply?.success !== true) return { status: "failed" };
        if (ping.reply.data?.version !== 4 || ping.reply.data?.capabilities?.activitySnapshot !== 1)
          return { status: "unsupported" };
        const result = await request("subagents:rpc:activity-snapshot");
        if (result.reply?.success !== true) return { status: "failed" };
        const snapshot = readActivitySnapshot(result.reply.data);
        return snapshot ? { status: "ready", snapshot } : { status: "failed" };
      } catch {
        return { status: "failed" };
      }
    },
  };
}
