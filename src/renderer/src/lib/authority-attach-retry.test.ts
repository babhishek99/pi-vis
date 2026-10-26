import type { SessionId } from "@shared/ids.js";
import type { RendererAttachResult } from "@shared/ipc-contract.js";
import type { AuthorityAttachResponse } from "@shared/pi-protocol/runtime-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityAttachRetry } from "./authority-attach-retry.js";

const SID = "session-a" as SessionId;
const transitioning = { status: "transitioning" } as AuthorityAttachResponse;
const ready = { status: "ready" } as AuthorityAttachResponse;
const attached = {
  status: "attached",
  runtime: { availability: "unavailable", receivedAt: 0 },
} satisfies RendererAttachResult;

describe("AuthorityAttachRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("does not retry after a transitioning attach session is removed", async () => {
    vi.useFakeTimers();
    const sessions = new Set<SessionId>([SID]);
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const retry = new AuthorityAttachRetry({
      sessionExists: (sessionId) => sessions.has(sessionId),
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    const attaching = retry.request(SID);
    await vi.advanceTimersByTimeAsync(0);
    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).toHaveBeenCalledTimes(1);

    const removeSession = (): void => {
      sessions.delete(SID);
      retry.cancel(SID); // mirrors App's synchronous removeSession subscription
    };
    removeSession();
    await attaching;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).toHaveBeenCalledTimes(1);
  });

  it("retries typed renderer unavailability without issuing authorityAttach", async () => {
    vi.useFakeTimers();
    const rendererAttach = vi
      .fn<() => Promise<RendererAttachResult>>()
      .mockResolvedValueOnce({ status: "unavailable", reason: "session_closing" })
      .mockResolvedValue(attached);
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    const attaching = retry.request(SID);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorityAttach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(authorityAttach).toHaveBeenCalledTimes(1);
    retry.cancelAll();
    await attaching;
  });

  it("does not issue the second attach IPC when removal races rendererAttach", async () => {
    let resolveRendererAttach: ((result: RendererAttachResult) => void) | undefined;
    const rendererAttach = vi.fn(
      () =>
        new Promise<RendererAttachResult>((resolve) => {
          resolveRendererAttach = resolve;
        }),
    );
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const sessions = new Set<SessionId>([SID]);
    const retry = new AuthorityAttachRetry({
      sessionExists: (sessionId) => sessions.has(sessionId),
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    const attaching = retry.request(SID);
    sessions.delete(SID);
    retry.cancel(SID);
    resolveRendererAttach?.(attached);
    await attaching;

    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).not.toHaveBeenCalled();
  });

  it("forces a healthy session attach and preserves that force through retry", async () => {
    vi.useFakeTimers();
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi
      .fn<() => Promise<AuthorityAttachResponse>>()
      .mockResolvedValueOnce(transitioning)
      .mockResolvedValueOnce(ready);
    const onReady = vi.fn();
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => false,
      rendererAttach,
      authorityAttach,
      onReady,
      onUnavailable: vi.fn(),
    });

    const attaching = retry.request(SID, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    await attaching;
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(authorityAttach).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("accelerates one scheduled retry when lifecycle evidence arrives", async () => {
    vi.useFakeTimers();
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi
      .fn<() => Promise<AuthorityAttachResponse>>()
      .mockResolvedValueOnce(transitioning)
      .mockResolvedValueOnce(ready);
    const onReady = vi.fn();
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady,
      onUnavailable: vi.fn(),
    });

    const initial = retry.request(SID);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorityAttach).toHaveBeenCalledOnce();

    const accelerated = retry.request(SID);
    expect(accelerated).toBe(initial);
    await accelerated;
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(authorityAttach).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(authorityAttach).toHaveBeenCalledTimes(2);
  });

  it("preserves a forced refresh that joins an in-flight retry", async () => {
    vi.useFakeTimers();
    let resolveAuthorityAttach: ((result: AuthorityAttachResponse) => void) | undefined;
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi
      .fn<() => Promise<AuthorityAttachResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise<AuthorityAttachResponse>((resolve) => {
            resolveAuthorityAttach = resolve;
          }),
      )
      .mockResolvedValueOnce(ready);
    const onReady = vi.fn();
    let needsAttach = true;
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => needsAttach,
      rendererAttach,
      authorityAttach,
      onReady,
      onUnavailable: vi.fn(),
    });

    const ordinary = retry.request(SID);
    await Promise.resolve();
    expect(authorityAttach).toHaveBeenCalledOnce();
    needsAttach = false;
    const joined = retry.request(SID, true);
    expect(joined).toBe(ordinary);
    resolveAuthorityAttach?.(transitioning);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(250);
    await ordinary;
    expect(authorityAttach).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("coalesces forced and ordinary callers into one installed baseline", async () => {
    let resolveRendererAttach: ((result: RendererAttachResult) => void) | undefined;
    const rendererAttach = vi.fn(
      () =>
        new Promise<RendererAttachResult>((resolve) => {
          resolveRendererAttach = resolve;
        }),
    );
    const authorityAttach = vi.fn().mockResolvedValue(ready);
    const onReady = vi.fn();
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady,
      onUnavailable: vi.fn(),
    });

    const ordinary = retry.request(SID);
    const forced = retry.request(SID, true);
    expect(forced).toBe(ordinary);
    resolveRendererAttach?.(attached);
    await Promise.all([ordinary, forced]);

    expect(rendererAttach).toHaveBeenCalledOnce();
    expect(authorityAttach).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("starts a new cycle immediately after a ready cycle completes", async () => {
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi.fn().mockResolvedValue(ready);
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      // Mirrors fileChanged retaining a successor payload when the first
      // completed cycle installed a predecessor owner.
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    await retry.request(SID);
    const successor = retry.request(SID);
    await Promise.resolve();
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    await successor;

    expect(authorityAttach).toHaveBeenCalledTimes(2);
  });

  it.each(["renderer", "authority"] as const)(
    "ignores a delayed predecessor %s attach after lifecycle cancellation without cancelling its successor",
    async (phase) => {
      let resolveOld!: (result: RendererAttachResult | AuthorityAttachResponse) => void;
      let resolveFresh!: (result: AuthorityAttachResponse) => void;
      const old = new Promise<RendererAttachResult | AuthorityAttachResponse>((resolve) => {
        resolveOld = resolve;
      });
      const fresh = new Promise<AuthorityAttachResponse>((resolve) => {
        resolveFresh = resolve;
      });
      const rendererAttach = vi.fn().mockResolvedValue(attached);
      const authorityAttach = vi.fn().mockImplementation(() => fresh);
      if (phase === "renderer") rendererAttach.mockImplementationOnce(() => old);
      else authorityAttach.mockImplementationOnce(() => old);
      const onReady = vi.fn();
      const retry = new AuthorityAttachRetry({
        sessionExists: () => true,
        needsAttach: () => true,
        rendererAttach,
        authorityAttach,
        onReady,
        onUnavailable: vi.fn(),
      });

      const predecessor = retry.request(SID);
      await Promise.resolve();
      // Mirrors App's synchronous starting/transitioning transport fence.
      retry.cancel(SID);
      await predecessor;
      let successorCompleted = false;
      const successor = retry.request(SID).then(() => {
        successorCompleted = true;
      });
      await Promise.resolve();
      resolveOld(phase === "renderer" ? attached : ready);
      await Promise.resolve();
      await Promise.resolve();
      expect(onReady).not.toHaveBeenCalled();
      expect(successorCompleted).toBe(false);

      resolveFresh(ready);
      await successor;
      expect(onReady).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledWith(SID, ready);
      expect(authorityAttach).toHaveBeenCalledTimes(phase === "renderer" ? 1 : 2);
    },
  );

  it("resolves the cancelled cycle when a retry timer discovers a removed session", async () => {
    vi.useFakeTimers();
    let exists = true;
    const retry = new AuthorityAttachRetry({
      sessionExists: () => exists,
      needsAttach: () => true,
      rendererAttach: vi.fn().mockResolvedValue(attached),
      authorityAttach: vi.fn().mockResolvedValue(transitioning),
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });
    let completed = false;
    const cycle = retry.request(SID).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    exists = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(completed).toBe(true);
    await cycle;
  });

  it("does not complete a new cycle started synchronously by onReady", async () => {
    let resolveFresh!: (response: AuthorityAttachResponse) => void;
    const fresh = new Promise<AuthorityAttachResponse>((resolve) => {
      resolveFresh = resolve;
    });
    let successor: Promise<void> | undefined;
    let successorCompleted = false;
    const onReady = vi.fn(() => {
      if (onReady.mock.calls.length !== 1) return;
      retry.cancel(SID);
      successor = retry.request(SID).then(() => {
        successorCompleted = true;
      });
    });
    const retry: AuthorityAttachRetry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach: vi.fn().mockResolvedValue(attached),
      authorityAttach: vi.fn().mockResolvedValueOnce(ready).mockReturnValueOnce(fresh),
      onReady,
      onUnavailable: vi.fn(),
    });
    await retry.request(SID);
    await Promise.resolve();
    expect(successorCompleted).toBe(false);
    resolveFresh(ready);
    await successor;
    expect(successorCompleted).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("retries a synchronous renderer transport throw within its owning cycle", async () => {
    vi.useFakeTimers();
    const rendererAttach = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transport closed before IPC");
      })
      .mockResolvedValue(attached);
    const onReady = vi.fn();
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach,
      authorityAttach: vi.fn().mockResolvedValue(ready),
      onReady,
      onUnavailable: vi.fn(),
    });
    const cycle = retry.request(SID);
    expect(rendererAttach).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    await cycle;
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledOnce();
  });
});
