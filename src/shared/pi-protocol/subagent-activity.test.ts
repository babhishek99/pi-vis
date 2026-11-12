import { describe, expect, it } from "vitest";
import { readActivitySnapshot } from "../../../resources/pi-session-host/subagent-activity-limits.mjs";
import {
  activityAgent,
  activitySnapshot,
  activityWorkflow,
} from "./__fixtures__/subagent-activity.js";
import { PI_COMMAND_POLICY } from "./commands.js";
import { SessionQueryResultSchema, SessionQuerySchema, queryPolicy } from "./runtime-state.js";
import {
  ACTIVITY_MAX_AGENTS,
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_WORKFLOWS,
  ActivitySnapshotSchema,
  SubagentActivityResultSchema,
} from "./subagent-activity.js";

describe("bounded activity snapshot wire contract", () => {
  it("accepts honest empty, nested, pre-record and unwinding observations in both boundaries", () => {
    const value = activitySnapshot(
      [
        activityAgent("outer", { workflowId: "wf-own" }),
        activityAgent("nested", { parentAgentId: "outer", state: "unwinding", status: "stopped" }),
        activityAgent("wf-own:call-3", {
          recordId: null,
          workflowId: "wf-own",
          state: "queued",
          status: "queued",
        }),
      ],
      [activityWorkflow("wf-own")],
    );
    for (const snapshot of [activitySnapshot(), value]) {
      expect(ActivitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(readActivitySnapshot(snapshot)).toEqual(snapshot);
      expect(readActivitySnapshot(snapshot)).not.toBe(snapshot);
    }
  });

  it("accepts omitted/evicted owners and complete pre-truncation counts without inventing rows", () => {
    const value = activitySnapshot([
      activityAgent("child", { parentAgentId: "omitted-parent", workflowId: "omitted-workflow" }),
    ]);
    value.omitted = { agents: 20, workflows: 2 };
    value.agentCounts.finished = 20;
    value.workflowCounts.finished = 2;
    expect(ActivitySnapshotSchema.parse(value)).toEqual(value);
    expect(readActivitySnapshot(value)).toEqual(value);
  });

  it("bounds maximum Unicode rows and UTF-8 transport bytes", () => {
    const agents = Array.from({ length: ACTIVITY_MAX_AGENTS }, (_, i) =>
      activityAgent(`agent-${i}`, {
        name: "漢".repeat(80),
        agentType: "漢".repeat(80),
        task: "漢".repeat(240),
        phase: "漢".repeat(120),
      }),
    );
    const workflows = Array.from({ length: ACTIVITY_MAX_WORKFLOWS }, (_, i) =>
      activityWorkflow(`wf-${i}`, { name: "漢".repeat(80), task: "漢".repeat(240) }),
    );
    const value = activitySnapshot(agents, workflows);
    expect(ActivitySnapshotSchema.parse(value)).toEqual(value);
    expect(readActivitySnapshot(value)).toEqual(value);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(
      ACTIVITY_MAX_BYTES,
    );
    const oversized = { ...value, agents: [...agents, activityAgent("one-too-many")] };
    expect(ActivitySnapshotSchema.safeParse(oversized).success).toBe(false);
    expect(readActivitySnapshot(oversized)).toBeUndefined();
  });

  it("rejects oversized collections before visiting their elements", () => {
    let visited = 0;
    const agents = new Array(ACTIVITY_MAX_AGENTS + 1);
    Object.defineProperty(agents, "0", {
      get: () => {
        visited++;
        throw new Error("must not visit oversized rows");
      },
    });
    const value = { ...activitySnapshot(), agents };
    expect(ActivitySnapshotSchema.safeParse(value).success).toBe(false);
    expect(readActivitySnapshot(value)).toBeUndefined();
    expect(visited).toBe(0);
  });

  it("rejects private payloads, inconsistent counts, cycles, wrong states and unbounded text", () => {
    const base = activitySnapshot([activityAgent("a")]);
    const cases = [
      { ...base, prompt: "must not cross IPC" },
      { ...base, version: 2 },
      { ...base, observedAt: Number.NaN },
      { ...base, agentCounts: { ...base.agentCounts, running: -1 } },
      { ...base, agentCounts: { ...base.agentCounts, running: 2 } },
      { ...base, agents: [activityAgent("a", { state: "queued" })] },
      { ...base, agents: [activityAgent("a", { parentAgentId: "a" })] },
      { ...base, agents: [activityAgent("a", { recordId: "other" })] },
      { ...base, agents: [activityAgent("a", { recordId: null })] },
      { ...base, agents: [{ ...base.agents[0], result: "private result" }] },
      { ...base, agents: [activityAgent("a", { task: "x".repeat(241) })] },
      { ...base, agents: [activityAgent("a", { name: "unsafe\u001b[0m" })] },
      activitySnapshot([activityAgent("a"), activityAgent("a")]),
      activitySnapshot([
        activityAgent("a", { parentAgentId: "b" }),
        activityAgent("b", { parentAgentId: "a" }),
      ]),
      activitySnapshot([], [activityWorkflow("wf", { state: "finished", status: "running" })]),
    ];
    for (const value of cases) {
      expect(ActivitySnapshotSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
      expect(readActivitySnapshot(value)).toBeUndefined();
    }
  });

  it("does not invoke extension-owned accessors or serialize array toJSON payloads", () => {
    const value = activitySnapshot([activityAgent("a")]);
    const getter = Object.defineProperty({ ...value }, "agents", {
      enumerable: true,
      get: () => {
        throw new Error("private getter");
      },
    });
    expect(readActivitySnapshot(getter)).toBeUndefined();
    const array = Object.assign(value.agents, { toJSON: () => ({ private: "do not serialize" }) });
    expect(readActivitySnapshot({ ...value, agents: array })).toEqual(
      activitySnapshot([activityAgent("a")]),
    );
  });

  it("keeps unsupported and failed reads unknown, never an empty ready snapshot", () => {
    for (const status of ["unavailable", "unsupported", "failed"] as const) {
      expect(SubagentActivityResultSchema.parse({ status })).toEqual({ status });
      expect(
        SubagentActivityResultSchema.safeParse({ status, snapshot: activitySnapshot() }).success,
      ).toBe(false);
    }
    expect(SubagentActivityResultSchema.safeParse({ status: "settled" }).success).toBe(false);
  });

  it("admits only a parameter-free owner-bound read and validates its correlated result", () => {
    const query = { type: "get_subagent_activity" } as const;
    expect(SessionQuerySchema.parse(query)).toEqual(query);
    expect(queryPolicy(query)).toEqual({ retry: "same_owner" });
    expect(PI_COMMAND_POLICY.get_subagent_activity.class).toBe("read_only");
    expect(SessionQuerySchema.safeParse({ ...query, sessionFile: "/untrusted" }).success).toBe(
      false,
    );
    const result = {
      status: "ok",
      queryId: "read-a",
      owner: { hostInstanceId: "host-a", sessionEpoch: 0 },
      queryType: query.type,
      response: {
        type: "response",
        command: query.type,
        success: true,
        data: { status: "ready", snapshot: activitySnapshot() },
      },
    };
    expect(SessionQueryResultSchema.parse(result)).toEqual(result);
    expect(
      SessionQueryResultSchema.safeParse({
        ...result,
        response: {
          ...result.response,
          data: { status: "ready", snapshot: { private: "invalid" } },
        },
      }).success,
    ).toBe(false);
  });
});
