import type { RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionViewState } from "../stores/sessions-store.js";
import { waitForRuntimeOwner } from "./wait-for-runtime-owner.js";

const predecessor = { hostInstanceId: "host-a", sessionEpoch: 0 };
const successor = { ...predecessor, sessionEpoch: 1 };

function runtime(owner = predecessor, availability = "available"): SessionViewState {
  return {
    status: "ready",
    availability,
    authorityProjection: {
      owner,
      semantic: { state: "following", cursor: { ...owner } },
      authoritativeSnapshot: { owner },
    },
  } as SessionViewState;
}

function harness() {
  let session: SessionViewState | undefined = runtime(predecessor, "transitioning");
  const listeners = new Set<() => void>();
  const requestAttach = vi.fn().mockResolvedValue(undefined);
  const controller = new AbortController();
  const options = {
    owner: successor,
    getSession: () => session,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestAttach,
    signal: controller.signal,
  };
  return {
    options,
    controller,
    listeners,
    requestAttach,
    publish(next: SessionViewState | undefined) {
      session = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("waitForRuntimeOwner", () => {
  afterEach(() => vi.useRealTimers());

  it("retains a changed-file payload after cancelled attach cycles until the exact owner is available", async () => {
    const h = harness();
    const adopt = vi.fn();
    h.requestAttach.mockImplementation(async () => {
      // Both predecessor cycles can complete without installing a successor.
      await Promise.resolve();
      await Promise.resolve();
    });
    const waiting = waitForRuntimeOwner(h.options).then((matched) => matched && adopt());
    await Promise.resolve();
    await Promise.resolve();
    expect(adopt).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(1);
    h.publish(runtime(successor, "transitioning"));
    await Promise.resolve();
    expect(adopt).not.toHaveBeenCalled();
    h.publish(runtime(successor));
    await waiting;
    expect(adopt).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
  });

  it("subscribes before attach can synchronously install the successor", async () => {
    const h = harness();
    h.requestAttach.mockImplementation(async () => h.publish(runtime(successor)));
    await expect(waitForRuntimeOwner(h.options)).resolves.toBe(true);
    expect(h.listeners.size).toBe(0);
  });

  it("does not start a queued attach after its event is cancelled", async () => {
    const h = harness();
    const waiting = waitForRuntimeOwner(h.options);
    h.controller.abort();
    await expect(waiting).resolves.toBe(false);
    await Promise.resolve();
    expect(h.requestAttach).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });

  it("a newer event cancels the old payload and only its matching owner may adopt", async () => {
    const h = harness();
    const adoptions: RuntimeIdentity[] = [];
    const first = waitForRuntimeOwner(h.options).then((matched) => {
      if (matched) adoptions.push(successor);
    });
    h.controller.abort();
    const latest = { ...successor, sessionEpoch: 2 };
    const nextController = new AbortController();
    const second = waitForRuntimeOwner({
      ...h.options,
      owner: latest,
      signal: nextController.signal,
    }).then((matched) => {
      if (matched) adoptions.push(latest);
    });
    h.publish(runtime(successor));
    await first;
    expect(adoptions).toEqual([]);
    h.publish(runtime(latest));
    await second;
    expect(adoptions).toEqual([latest]);
    expect(h.listeners.size).toBe(0);
  });

  it.each(["removed", "restarted", "newer_epoch", "newer_host"] as const)(
    "cancels obsolete file adoption when the owner is %s",
    async (change) => {
      const h = harness();
      const waiting = waitForRuntimeOwner(h.options);
      if (change === "removed") h.publish(undefined);
      else if (change === "restarted") h.publish({ ...runtime(), status: "starting" });
      else if (change === "newer_epoch") h.publish(runtime({ ...successor, sessionEpoch: 2 }));
      else h.publish(runtime({ hostInstanceId: "host-b", sessionEpoch: 0 }));
      await expect(waiting).resolves.toBe(false);
      expect(h.listeners.size).toBe(0);
    },
  );

  it("bounds the wait and releases its subscription and timer", async () => {
    vi.useFakeTimers();
    const h = harness();
    const waiting = waitForRuntimeOwner({ ...h.options, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
