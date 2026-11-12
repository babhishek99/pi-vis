import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityAgent,
  activitySnapshot,
} from "../../src/shared/pi-protocol/__fixtures__/subagent-activity.ts";
import { SubagentActivityResultSchema } from "../../src/shared/pi-protocol/subagent-activity.ts";
import { createSubagentActivityClient } from "./subagent-activity.mjs";

function responder(bus, data = activitySnapshot(), version = 4, capability = 1) {
  bus.on("subagents:rpc:ping", ({ requestId }) =>
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version, capabilities: { stopAll: true, activitySnapshot: capability } },
    }),
  );
  const read = vi.fn(({ requestId }) =>
    bus.emit(`subagents:rpc:activity-snapshot:reply:${requestId}`, { success: true, data }),
  );
  bus.on("subagents:rpc:activity-snapshot", read);
  return read;
}

afterEach(() => vi.useRealTimers());

describe("runtime-private read-only activity client", () => {
  it("reads only its captured runtime and never emits effects", async () => {
    const a = createEventBus();
    const b = createEventBus();
    const value = activitySnapshot([
      activityAgent("a-child", { state: "unwinding", status: "stopped" }),
    ]);
    const readA = responder(a, value);
    const readB = responder(b, activitySnapshot([activityAgent("b-child")]));
    const emitted = [];
    const valueA = await createSubagentActivityClient({
      ...a,
      emit: (channel, data) => {
        emitted.push(channel);
        a.emit(channel, data);
      },
    }).read();
    expect(valueA).toEqual({ status: "ready", snapshot: value });
    expect(SubagentActivityResultSchema.parse(valueA)).toEqual(valueA);
    expect(readA).toHaveBeenCalledOnce();
    expect(readB).not.toHaveBeenCalled();
    expect(emitted).toEqual(["subagents:rpc:ping", "subagents:rpc:activity-snapshot"]);
    expect(valueA.snapshot).not.toBe(value);
  });

  it.each([
    [2, undefined],
    [3, undefined],
    [4, 2],
    [5, 1],
  ])(
    "refuses unsupported protocol/capability %s/%s without dispatching a read",
    async (version, capability) => {
      const bus = createEventBus();
      const read = responder(bus, activitySnapshot(), version, capability ?? 0);
      await expect(createSubagentActivityClient(bus).read()).resolves.toEqual({
        status: "unsupported",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("bounds absent discovery and missing snapshot replies, ignoring late replies", async () => {
    vi.useFakeTimers();
    const absent = createSubagentActivityClient(createEventBus()).read();
    await vi.advanceTimersByTimeAsync(250);
    await expect(absent).resolves.toEqual({ status: "unavailable" });
    const bus = createEventBus();
    bus.on("subagents:rpc:ping", ({ requestId }) =>
      bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 4, capabilities: { activitySnapshot: 1 } },
      }),
    );
    let captured;
    bus.on("subagents:rpc:activity-snapshot", (request) => {
      captured = request.requestId;
    });
    const pending = createSubagentActivityClient(bus).read();
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ status: "failed" });
    bus.emit(`subagents:rpc:activity-snapshot:reply:${captured}`, {
      success: true,
      data: activitySnapshot(),
    });
    await expect(pending).resolves.toEqual({ status: "failed" });
  });

  it("releases every scoped reply listener after success, timeout or emit failure", async () => {
    vi.useFakeTimers();
    for (const kind of ["success", "timeout", "failure"]) {
      const bus = createEventBus();
      if (kind === "success") responder(bus);
      const removals = [];
      const client = createSubagentActivityClient({
        on(channel, handler) {
          const off = vi.fn(bus.on(channel, handler));
          removals.push(off);
          return off;
        },
        emit(channel, data) {
          if (kind === "failure") throw new Error("private failure");
          bus.emit(channel, data);
        },
      });
      const pending = client.read();
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(removals.length).toBe(kind === "success" ? 2 : 1);
      for (const off of removals) expect(off).toHaveBeenCalledOnce();
    }
  });

  it("sanitizes errors, malformed/oversized data, getters and extra private fields", async () => {
    const badGetter = Object.defineProperty({}, "success", {
      get: () => {
        throw new Error("private getter");
      },
    });
    for (const data of [
      { ...activitySnapshot(), secret: "private" },
      { agents: new Array(10000) },
      undefined,
    ]) {
      const bus = createEventBus();
      responder(bus, data);
      // responder's default parameter intentionally handles undefined; make it explicitly malformed.
      if (data === undefined) {
        const raw = createEventBus();
        raw.on("subagents:rpc:ping", ({ requestId }) =>
          raw.emit(`subagents:rpc:ping:reply:${requestId}`, badGetter),
        );
        await expect(createSubagentActivityClient(raw).read()).resolves.toEqual({
          status: "failed",
        });
      } else {
        await expect(createSubagentActivityClient(bus).read()).resolves.toEqual({
          status: "failed",
        });
      }
    }
    const failing = createEventBus();
    failing.on("subagents:rpc:ping", ({ requestId }) =>
      failing.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: false,
        error: "credential-bearing private detail",
      }),
    );
    await expect(createSubagentActivityClient(failing).read()).resolves.toEqual({
      status: "failed",
    });
  });
});
