import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscapeResultSchema } from "../../src/shared/pi-protocol/runtime-state.ts";
import { createStateAuthority } from "./state-authority.mjs";
import { createSubagentStopClient, createTabEscapeHandler } from "./subagent-stop.mjs";

const empty = { agents: 0, workflows: 0, pendingOperations: false, pendingNotifications: false };
const request = (sequence = 1, epoch = 0) => ({
  requestId: `escape-${sequence}`,
  sequence,
  expectedHostInstanceId: "host",
  expectedSessionEpoch: epoch,
});
const authorities = [];
afterEach(() => {
  for (const authority of authorities.splice(0)) authority.stop();
  vi.useRealTimers();
});

function session(overrides = {}) {
  return {
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    sessionId: "session",
    sessionFile: "/synthetic.jsonl",
    pendingMessageCount: 0,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => ({}),
    abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    abortRetry: vi.fn(),
    ...overrides,
  };
}
function setup(initial = session(), getStopClient = () => undefined) {
  const authority = createStateAuthority({ hostInstanceId: "host", initialSession: initial });
  authorities.push(authority);
  const handle = createTabEscapeHandler({
    authority,
    getSession: () => authority.currentSession,
    getStopClient,
  });
  return { authority, handle, initial };
}
function responder(bus, stopAll = vi.fn(() => empty)) {
  bus.on("subagents:rpc:ping", ({ requestId }) => {
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version: 3, capabilities: { stopAll: true } },
    });
  });
  bus.on("subagents:rpc:stop-all", ({ requestId }) => {
    const data = stopAll();
    bus.emit(`subagents:rpc:stop-all:reply:${requestId}`, { success: true, data });
  });
  return stopAll;
}

describe("tab-local direct Escape", () => {
  it("signals the parent before any client getter, discovery or extension dispatch", async () => {
    const bus = createEventBus();
    const order = [];
    responder(bus, () => {
      order.push("stop");
      return { ...empty, agents: 2, workflows: 1 };
    });
    bus.on("subagents:rpc:ping", () => order.push("ping"));
    const client = createSubagentStopClient(bus);
    const parent = session({
      isIdle: false,
      isStreaming: true,
      abort: vi.fn(() => {
        order.push("parent");
        return new Promise(() => {});
      }),
    });
    const { handle } = setup(parent, () => {
      order.push("client");
      return client;
    });
    const pending = handle(request());
    expect(order).toEqual(["parent", "client", "stop", "ping"]);
    const value = await pending;
    expect(value).toMatchObject({
      disposition: "abort_requested",
      target: "streaming",
      subagents: { status: "requested", agents: 2, workflows: 1 },
    });
    expect(EscapeResultSchema.parse(value)).toEqual(value);
  });

  it("stops authoritative background-only work while the parent is idle, never another tab", async () => {
    const a = createEventBus();
    const b = createEventBus();
    const stopA = responder(
      a,
      vi.fn(() => ({ ...empty, agents: 3, pendingNotifications: true })),
    );
    const stopB = responder(b);
    const other = setup(session(), () => createSubagentStopClient(b));
    const { handle, initial } = setup(session(), () => createSubagentStopClient(a));
    await expect(handle(request())).resolves.toMatchObject({
      disposition: "abort_requested",
      target: "subagents",
    });
    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).not.toHaveBeenCalled();
    expect(initial.abort).not.toHaveBeenCalled();
    expect(other.initial.abort).not.toHaveBeenCalled();
  });

  it("is a no-op for a truly idle parent and empty extension", async () => {
    const bus = createEventBus();
    responder(bus);
    const { handle, initial } = setup(session(), () => createSubagentStopClient(bus));
    await expect(handle(request())).resolves.toMatchObject({
      disposition: "already_inactive",
      subagents: { status: "requested", ...empty },
    });
    expect(initial.abort).not.toHaveBeenCalled();
  });

  it("still attempts extension stop after parent queue cleanup throws", async () => {
    const bus = createEventBus();
    const stopped = responder(bus);
    let thrown = false;
    const { handle, initial } = setup(
      session({
        isIdle: false,
        isStreaming: true,
        clearQueue: () => {
          thrown = true;
          throw new Error("queue failed");
        },
      }),
      () => {
        expect(initial.abort).toHaveBeenCalledOnce();
        expect(thrown).toBe(true);
        return createSubagentStopClient(bus);
      },
    );
    const value = await handle(request());
    expect(value.disposition).toBe("failed");
    expect(value.subagents.status).toBe("requested");
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("still stops subagents when the parent selector unexpectedly throws", async () => {
    const stop = vi.fn(() => ({ status: "requested", ...empty, agents: 1 }));
    const { authority, handle } = setup(session(), () => ({ stop }));
    vi.spyOn(authority, "requestEscape").mockImplementation(() => {
      throw new Error("private parent failure");
    });
    const value = await handle(request());
    expect(stop).toHaveBeenCalledOnce();
    expect(value).toMatchObject({
      disposition: "outcome_unknown",
      subagents: { status: "requested", agents: 1 },
    });
    expect(JSON.stringify(value)).not.toContain("private parent failure");
  });

  it("does not dispatch an older extension stop after parent abort reenters with a newer Escape", async () => {
    const stop = vi.fn(() => ({ status: "requested", ...empty }));
    let next;
    const parent = session({
      isIdle: false,
      isStreaming: true,
      abort: vi.fn(() => {
        if (!next) {
          next = true;
          next = handle(request(2));
        }
      }),
    });
    const { handle } = setup(parent, () => ({ stop }));
    const first = handle(request());
    expect(parent.abort).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    await expect(first).resolves.toMatchObject({ disposition: "outcome_unknown" });
    await expect(next).resolves.toMatchObject({ disposition: "abort_requested" });
  });

  it("never lets a throwing client lookup delay or suppress parent abort", async () => {
    const { handle, initial } = setup(session({ isIdle: false, isStreaming: true }), () => {
      throw new Error("private extension failure");
    });
    const pending = handle(request());
    expect(initial.abort).toHaveBeenCalledOnce();
    const value = await pending;
    expect(value).toMatchObject({
      disposition: "outcome_unknown",
      subagents: { status: "failed" },
    });
    expect(JSON.stringify(value)).not.toContain("private extension failure");
  });

  it("deduplicates a pending wire sequence and rejects its delayed replay after new work", async () => {
    const receipt = Promise.withResolvers();
    const stop = vi.fn(() => receipt.promise);
    const { handle, initial } = setup(session({ isIdle: false, isStreaming: true }), () => ({
      stop,
    }));
    const first = handle(request());
    expect(handle(request())).toBe(first);
    expect(stop).toHaveBeenCalledOnce();
    receipt.resolve({ status: "requested", ...empty });
    await first;
    await handle(request(2));
    const count = initial.abort.mock.calls.length;
    await expect(handle(request(1))).resolves.toMatchObject({ disposition: "not_applicable" });
    await expect(handle({ ...request(2), requestId: "conflicting-id" })).resolves.toMatchObject({
      disposition: "not_applicable",
    });
    expect(initial.abort).toHaveBeenCalledTimes(count);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch a predecessor request into a successor epoch or transitioning runtime", async () => {
    const stop = vi.fn(() => ({ status: "requested", ...empty }));
    const { authority, handle, initial } = setup(session(), () => ({ stop }));
    authority.adoptSession(session(), 1);
    await expect(handle(request())).resolves.toMatchObject({ disposition: "not_applicable" });
    authority.beginTransition("replacement", 2);
    await expect(handle(request(2, 1))).resolves.toMatchObject({ disposition: "not_applicable" });
    expect(initial.abort).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("rechecks ownership after client lookup and after awaited acknowledgement", async () => {
    const stop = vi.fn(() => ({ status: "requested", ...empty }));
    const a = setup(session(), () => {
      a.authority.adoptSession(session(), 1);
      return { stop };
    });
    await expect(a.handle(request())).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(stop).not.toHaveBeenCalled();
    const gate = Promise.withResolvers();
    const b = setup(session(), () => ({ stop: () => gate.promise }));
    const pending = b.handle(request());
    b.authority.adoptSession(session(), 1);
    gate.resolve({ status: "requested", ...empty, agents: 1 });
    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
  });
});

describe("public event-bus stop receipts", () => {
  it("bounds absent, old and unresponsive responders without delaying the stop emit", async () => {
    vi.useFakeTimers();
    for (const kind of ["absent", "old", "slow"]) {
      const bus = createEventBus();
      const emitted = [];
      bus.on("subagents:rpc:stop-all", (request) => emitted.push(request));
      const client = createSubagentStopClient(bus);
      if (kind !== "absent") bus.emit("subagents:ready", {});
      if (kind === "old")
        bus.on("subagents:rpc:ping", ({ requestId }) => {
          bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
            success: true,
            data: { version: 2 },
          });
        });
      const pending = client.stop();
      expect(emitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toEqual({
        status:
          kind === "absent" ? "unavailable" : kind === "old" ? "unsupported" : "outcome_unknown",
      });
      expect(emitted).toHaveLength(1); // a late discovery never initiates another stop
    }
  });

  it("uses one bounded client identity and monotonic sequences", async () => {
    const bus = createEventBus();
    responder(bus);
    const messages = [];
    bus.on("subagents:rpc:stop-all", (request) => messages.push(request));
    const client = createSubagentStopClient(bus);
    await client.stop();
    await client.stop();
    expect(messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(messages[0].clientId).toBe(messages[1].clientId);
    expect(messages[0].requestId).not.toBe(messages[1].requestId);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined])(
    "does not accept malformed counts (%s)",
    async (agents) => {
      const bus = createEventBus();
      responder(bus, () => ({ ...empty, agents }));
      await expect(createSubagentStopClient(bus).stop()).resolves.toEqual({
        status: "outcome_unknown",
      });
    },
  );

  it("removes reply listeners and never leaks extension errors or extra data", async () => {
    const bus = createEventBus();
    responder(bus, () => ({ ...empty, privateValue: "must stay private" }));
    const off = [];
    const realOn = bus.on;
    const wrapped = {
      ...bus,
      on: (channel, handler) => {
        const unsubscribe = realOn(channel, handler);
        const remove = vi.fn(unsubscribe);
        if (channel.includes(":reply:")) off.push(remove);
        return remove;
      },
    };
    const value = await createSubagentStopClient(wrapped).stop();
    expect(value).toEqual({ status: "requested", ...empty });
    expect(off).toHaveLength(2);
    for (const remove of off) expect(remove).toHaveBeenCalledOnce();
    const failing = createEventBus();
    failing.on("subagents:rpc:stop-all", ({ requestId }) =>
      failing.emit(`subagents:rpc:stop-all:reply:${requestId}`, {
        success: false,
        error: "credential-bearing failure",
      }),
    );
    failing.on("subagents:rpc:ping", ({ requestId }) =>
      failing.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 3, capabilities: { stopAll: true } },
      }),
    );
    await expect(createSubagentStopClient(failing).stop()).resolves.toEqual({ status: "failed" });
  });
});
