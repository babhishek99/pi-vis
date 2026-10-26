import type { SessionId } from "@shared/ids.js";
import type { RendererAttachResult } from "@shared/ipc-contract.js";
import type { AuthorityAttachResponse } from "@shared/pi-protocol/runtime-state.js";
import type { RendererAuthorityState } from "../stores/authority-reducer.js";

interface InFlightAttach {
  cancelled: boolean;
  promise: Promise<void>;
}

interface AttachCycle {
  promise: Promise<void>;
  resolve: () => void;
}

export interface AuthorityAttachRetryOptions {
  sessionExists: (sessionId: SessionId) => boolean;
  needsAttach: (sessionId: SessionId) => boolean;
  rendererAttach: (sessionId: SessionId) => Promise<RendererAttachResult>;
  authorityAttach: (sessionId: SessionId) => Promise<AuthorityAttachResponse>;
  onReady: (sessionId: SessionId, response: AuthorityAttachResponse) => void;
  onUnavailable: (sessionId: SessionId) => void;
}

const EXPECTED_PANEL_RECONSTRUCTION = new Set([
  "panel_reset",
  "repaint_required",
  "repaint_ack_pending",
  "panel_keyframe_required",
]);

export function authorityNeedsBaseline(projection: RendererAuthorityState | undefined): boolean {
  return (
    projection?.semantic.state !== "following" ||
    projection?.transcript.state !== "following" ||
    projection?.extensionUi.state !== "following" ||
    [...(projection?.panels.values() ?? [])].some(
      (panel) =>
        panel.sync.state === "unavailable" ||
        (panel.sync.state === "synchronizing" &&
          !EXPECTED_PANEL_RECONSTRUCTION.has(panel.sync.reason)),
    )
  );
}

/** Bounded, single-flight authority attach with cancellation at lifecycle fences. */
export class AuthorityAttachRetry {
  private readonly inFlight = new Map<SessionId, InFlightAttach>();
  private readonly cycles = new Map<SessionId, AttachCycle>();
  private readonly retries = new Map<SessionId, number>();
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private readonly retryForces = new Map<SessionId, boolean>();

  constructor(private readonly options: AuthorityAttachRetryOptions) {}

  request(sessionId: SessionId, force = false): Promise<void> {
    if (!this.options.sessionExists(sessionId)) {
      this.cancel(sessionId);
      return Promise.resolve();
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) {
      if (force) this.retryForces.set(sessionId, true);
      return this.cycle(sessionId).promise;
    }
    const scheduledForce = this.retryForces.get(sessionId) ?? false;
    const timer = this.timers.get(sessionId);
    if (timer) {
      // A lifecycle publication or focus event is better evidence than a
      // backoff timer that the transition may now be attachable. Accelerate
      // that one scheduled attempt without allowing the old timer to race it.
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    const effectiveForce = force || scheduledForce;
    if (!effectiveForce && !this.options.needsAttach(sessionId)) {
      this.clearRetry(sessionId);
      this.completeCycle(sessionId);
      return Promise.resolve();
    }
    if (effectiveForce) this.retryForces.set(sessionId, true);

    const cycle = this.cycle(sessionId);
    const attach: InFlightAttach = { cancelled: false, promise: Promise.resolve() };
    const active = (): boolean =>
      !attach.cancelled &&
      this.inFlight.get(sessionId) === attach &&
      this.options.sessionExists(sessionId);
    const cancelAttempt = (): void => {
      // A lifecycle fence may already have replaced this flight. Its delayed
      // IPC continuation must never cancel the successor's fresh attach.
      const current = this.inFlight.get(sessionId);
      if (current === attach || (!current && this.cycles.get(sessionId) === cycle)) {
        this.cancel(sessionId);
      }
    };
    const completeAttachCycle = (): void => {
      // Resolve callers only after retiring this attempt. A continuation may
      // immediately request a second cycle (for example, fileChanged still
      // observing the predecessor owner); leaving the completed attempt in
      // `inFlight` would make that new cycle join work that can no longer run.
      if (this.inFlight.get(sessionId) === attach) this.inFlight.delete(sessionId);
      if (this.cycles.get(sessionId) === cycle) this.completeCycle(sessionId);
    };
    const scheduleRetry = (): void => {
      if (!active()) {
        cancelAttempt();
        return;
      }
      const attempt = this.retries.get(sessionId) ?? 0;
      // 250ms, 500ms, 1s, 2s, then capped 4s. A bounded retry avoids both
      // focus storms and permanently hiding a genuinely unavailable host.
      if (attempt >= 6) {
        this.retries.delete(sessionId);
        this.retryForces.delete(sessionId);
        if (active()) {
          try {
            this.options.onUnavailable(sessionId);
          } finally {
            completeAttachCycle();
          }
        } else {
          completeAttachCycle();
        }
        return;
      }
      this.retries.set(sessionId, attempt + 1);
      const delay = Math.min(4_000, 250 * 2 ** attempt);
      const prior = this.timers.get(sessionId);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        this.timers.delete(sessionId);
        if (!this.options.sessionExists(sessionId)) {
          cancelAttempt();
          return;
        }
        const retryForce = this.retryForces.get(sessionId) ?? false;
        void this.request(sessionId, retryForce);
      }, delay);
      this.timers.set(sessionId, timer);
    };

    this.inFlight.set(sessionId, attach);
    attach.promise = (async () => {
      try {
        const rendererResult = await this.options.rendererAttach(sessionId);
        // A close can occur while the first IPC is transitioning. Do not send
        // the second IPC or schedule work for the now-dead session. Main also
        // reports a close/attach race as typed unavailability, never an IPC
        // exception that Electron logs as a failed handler.
        if (!active()) {
          cancelAttempt();
          return;
        }
        if (rendererResult.status === "unavailable") {
          scheduleRetry();
          return;
        }
        const response = await this.options.authorityAttach(sessionId);
        if (!active()) {
          cancelAttempt();
          return;
        }
        if (response.status === "ready") {
          this.clearRetry(sessionId);
          this.options.onReady(sessionId, response);
          completeAttachCycle();
          return;
        }
        scheduleRetry();
      } catch {
        // IPC transport loss is also a normal lifecycle boundary. Retry it
        // through the same bounded single-flight path without surfacing raw
        // Electron handler text to the user.
        if (active()) scheduleRetry();
        else cancelAttempt();
      }
    })();
    void attach.promise.finally(() => {
      if (this.inFlight.get(sessionId) === attach) this.inFlight.delete(sessionId);
    });
    return cycle.promise;
  }

  /** Stop every retry path and forget all bookkeeping for this session. */
  cancel(sessionId: SessionId): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.retries.delete(sessionId);
    this.retryForces.delete(sessionId);
    const attach = this.inFlight.get(sessionId);
    if (attach) attach.cancelled = true;
    this.inFlight.delete(sessionId);
    this.completeCycle(sessionId);
  }

  cancelAll(): void {
    for (const sessionId of new Set([
      ...this.timers.keys(),
      ...this.retries.keys(),
      ...this.inFlight.keys(),
      ...this.cycles.keys(),
    ])) {
      this.cancel(sessionId);
    }
  }

  private clearRetry(sessionId: SessionId): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.retries.delete(sessionId);
    this.retryForces.delete(sessionId);
  }

  private cycle(sessionId: SessionId): AttachCycle {
    const existing = this.cycles.get(sessionId);
    if (existing) return existing;
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const cycle = { promise, resolve };
    this.cycles.set(sessionId, cycle);
    return cycle;
  }

  private completeCycle(sessionId: SessionId): void {
    const cycle = this.cycles.get(sessionId);
    if (!cycle) return;
    this.cycles.delete(sessionId);
    cycle.resolve();
  }
}
