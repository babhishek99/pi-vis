/** Test-only observers and awaitable provider gates; never replaces cancellation. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHILD_LABELS = [
  "STOP-A-CHILD-1",
  "STOP-A-CHILD-2",
  "STOP-A-WORKFLOW-OUTER",
  "STOP-A-GRANDCHILD",
  "STOP-B-CHILD",
  "STOP-B-IDLE",
  "STOP-A-FRESH",
];

function trace(ctx: ExtensionContext, phase: string, fields: Record<string, unknown> = {}): void {
  const directory = join(ctx.cwd, ".tab-stop-fixture");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(
    join(directory, "events.jsonl"),
    `${JSON.stringify({
      phase,
      sdkSessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      ...fields,
    })}\n`,
  );
}

export default function tabStopProbe(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  pi.on("agent_settled", (_event, ctx) => {
    trace(ctx, "settled");
  });

  // Public context signal observed at the actual stop bus boundary, not a fake
  // parent/session or transcript-derived cancellation assumption.
  pi.events.on("subagents:rpc:stop-all", (raw: unknown) => {
    const request = raw as { requestId: string };
    const ctx = context;
    if (!ctx) return;
    trace(ctx, "stop-seen", { parentAborted: ctx.signal?.aborted ?? false });
    const unsubscribe = pi.events.on(
      `subagents:rpc:stop-all:reply:${request.requestId}`,
      (reply: unknown) => {
        unsubscribe();
        trace(ctx, "stop-reply", { reply });
      },
    );
  });

  // A consumed fixture result must not spend an extra synthetic parent turn.
  // Production stop-all and notification machinery remain entirely untouched.
  pi.events.on("subagents:completed", (raw: unknown) => {
    const record = raw as { id?: string; description?: string };
    if (!record.id || !record.description?.startsWith("STOP-")) return;
    pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId: record.id });
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const messages =
      (event.payload as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const text = JSON.stringify(
      messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
    );
    const root = text.includes("BEGIN-A")
      ? "STOP-ROOT-A"
      : text.includes("BEGIN-B")
        ? "STOP-ROOT-B"
        : undefined;
    if (root && pi.getSessionName() !== root) pi.setSessionName(root);
    const label = CHILD_LABELS.find((candidate) => text.includes(candidate)) ?? root;
    if (!label) return;
    const directory = join(ctx.cwd, ".tab-stop-fixture");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      join(directory, `${label}.entered.json`),
      JSON.stringify({
        label,
        sdkSessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      }),
    );
    if (root) return;
    while (!fs.existsSync(join(directory, `${label}.release`))) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    trace(ctx, "preflight-released", { label });
  });

  pi.registerCommand("tab-stop-fixture-idle", {
    description: "Start one gated synthetic background child with the parent idle",
    handler: async (_args, ctx) => {
      pi.events.emit("subagents:rpc:spawn", {
        requestId: randomUUID(),
        type: "general-purpose",
        prompt: "STOP-B-IDLE",
        options: { description: "STOP-B-IDLE", isBackground: true },
      });
      trace(ctx, "idle-spawn-requested");
    },
  });
}
