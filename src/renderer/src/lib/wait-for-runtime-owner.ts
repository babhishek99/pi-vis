import type { RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import { type SessionViewState, sessionMatchesRuntime } from "../stores/sessions-store.js";

interface RuntimeOwnerWaitOptions {
  owner: RuntimeIdentity;
  getSession: () => SessionViewState | undefined;
  subscribe: (listener: () => void) => () => void;
  requestAttach: () => Promise<void>;
  signal: AbortSignal;
  timeoutMs?: number;
}

/** Retain a one-shot presentation payload through cancellable attach cycles. */
export function waitForRuntimeOwner({
  owner,
  getSession,
  subscribe,
  requestAttach,
  signal,
  timeoutMs = 30_000,
}: RuntimeOwnerWaitOptions): Promise<boolean> {
  const predecessor = getSession()?.authorityProjection?.owner;
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (matched: boolean): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(matched);
    };
    const cancel = (): void => finish(false);
    const check = (): void => {
      const session = getSession();
      if (
        signal.aborted ||
        !session ||
        session.status === "starting" ||
        session.status === "failed" ||
        session.status === "exited"
      ) {
        finish(false);
        return;
      }
      const current = session.authorityProjection?.owner;
      if (sessionMatchesRuntime(session, owner)) {
        finish(true);
        return;
      }
      if (
        current &&
        ((current.hostInstanceId === owner.hostInstanceId &&
          current.sessionEpoch > owner.sessionEpoch) ||
          (predecessor &&
            current.hostInstanceId !== owner.hostInstanceId &&
            current.hostInstanceId !== predecessor.hostInstanceId))
      ) {
        finish(false);
      }
    };
    // A lifecycle update may arrive before the attach IPC returns. Subscribe
    // first; only the exact following/available owner settles this wait.
    unsubscribe = subscribe(check);
    if (settled) {
      unsubscribe();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    check();
    if (!settled) {
      // The shared coordinator owns retries. Its promise may resolve merely
      // because a predecessor flight was cancelled; keep the payload waiting.
      void Promise.resolve()
        .then(() => {
          if (!settled) return requestAttach();
        })
        .catch(() => undefined);
    }
  });
}
