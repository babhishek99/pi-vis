import { type GatewaySpendResult, previousUtcMonth } from "@shared/gateway-spend.js";
import type { SessionId } from "@shared/ids.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";

const HOUR_MS = 60 * 60 * 1000;

interface ReadScope {
  kind: GatewaySpendResult["scope"];
  isCurrent(): boolean;
  invoke(refresh: boolean): Promise<GatewaySpendResult>;
}

interface ReadState {
  scope: ReadScope | null;
  result: GatewaySpendResult | null;
  busy: boolean;
  failed: boolean;
  checkedAt: string | null;
}

export interface GatewaySpendRead extends Omit<ReadState, "scope"> {
  refreshBlocked: boolean;
  refresh(): void;
}

const EMPTY_READ: ReadState = {
  scope: null,
  result: null,
  busy: true,
  failed: false,
  checkedAt: null,
};

/** One deadline wakeup, not a billing poll. Main independently enforces this bound. */
function useRefreshBlocked(nextRefreshAt: string | null): boolean {
  const [, wake] = useState(0);
  useEffect(() => {
    if (!nextRefreshAt) return;
    let timer: number | undefined;
    const schedule = (): void => {
      const remaining = Date.parse(nextRefreshAt) - Date.now();
      if (remaining <= 0) {
        wake((revision) => revision + 1);
        return;
      }
      timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    if (Date.parse(nextRefreshAt) > Date.now()) schedule();
    return () => window.clearTimeout(timer);
  }, [nextRefreshAt]);
  return nextRefreshAt !== null && Date.parse(nextRefreshAt) > Date.now();
}

function useSpendRead(scope: ReadScope, hourly = false): GatewaySpendRead {
  const [state, setState] = useState<ReadState>(EMPTY_READ);
  // StrictMode replays mount effects. Share that still-running read, not its
  // presentation lifetime; each effect must independently pass its own fence.
  const flightRef = useRef<{ scope: ReadScope; promise: Promise<GatewaySpendResult> } | null>(null);
  const requestRef = useRef<{ scope: ReadScope; run(refresh: boolean): Promise<void> } | null>(
    null,
  );

  useEffect(() => {
    let retired = false;
    let inFlight = false;
    let latest: GatewaySpendResult | null = null;
    const current = (): boolean => !retired && scope.isCurrent();
    const run = async (refresh: boolean): Promise<void> => {
      if (!current() || inFlight) return;
      if (refresh && latest?.nextRefreshAt && Date.parse(latest.nextRefreshAt) > Date.now()) {
        return;
      }
      inFlight = true;
      setState((previous) => ({
        ...(previous.scope === scope ? previous : EMPTY_READ),
        scope,
        busy: true,
      }));
      let flight: typeof flightRef.current = null;
      try {
        flight = flightRef.current;
        if (!flight || flight.scope !== scope) {
          flight = { scope, promise: scope.invoke(refresh) };
          flightRef.current = flight;
        }
        const result = await flight.promise;
        if (!current()) return;
        if (result.scope !== scope.kind) throw new Error("Unexpected spend scope");
        latest = result;
        setState({
          scope,
          result,
          busy: false,
          failed: false,
          checkedAt: new Date().toISOString(),
        });
      } catch {
        // Never surface rejection messages: they may contain transport/source details.
        if (current()) {
          setState((previous) => ({ ...previous, scope, busy: false, failed: true }));
        }
      } finally {
        if (flightRef.current === flight) flightRef.current = null;
        inFlight = false;
      }
    };
    const request = { scope, run };
    requestRef.current = request;
    void run(false);
    const timer = hourly ? window.setInterval(() => void run(true), HOUR_MS) : undefined;
    return () => {
      retired = true;
      window.clearInterval(timer);
      if (requestRef.current === request) requestRef.current = null;
    };
  }, [scope, hourly]);

  // Hide a predecessor synchronously in render, not only after effect cleanup.
  const visible = state.scope === scope && scope.isCurrent() ? state : EMPTY_READ;
  const refreshBlocked = useRefreshBlocked(visible.result?.nextRefreshAt ?? null);
  return {
    result: visible.result,
    busy: visible.busy,
    failed: visible.failed,
    checkedAt: visible.checkedAt,
    refreshBlocked,
    refresh: () => {
      if (visible.busy || refreshBlocked || requestRef.current?.scope !== scope) return;
      void requestRef.current.run(true);
    },
  };
}

export function useGatewayMonthSpend(): GatewaySpendRead {
  const [periodKey, setPeriodKey] = useState(() => previousUtcMonth(new Date()).start);
  useEffect(() => {
    let timer: number | undefined;
    const schedule = (): void => {
      const now = new Date();
      const currentKey = previousUtcMonth(now).start;
      if (currentKey !== periodKey) {
        setPeriodKey(currentKey);
        return;
      }
      const deadline = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      // A calendar month can exceed the platform's maximum timeout. Re-arm
      // the same deadline when capped, without polling or issuing a spend read.
      timer = window.setTimeout(schedule, Math.min(deadline - now.getTime(), 2_147_483_647));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [periodKey]);

  const scope = useMemo<ReadScope>(
    () => ({
      kind: "personal_gateway",
      // Check the clock too: an old read may settle before the deadline's
      // state update commits (or before its callback runs after system sleep).
      isCurrent: () => previousUtcMonth(new Date()).start === periodKey,
      invoke: (refresh) =>
        window.pivis.invoke("gatewaySpend.month", refresh ? { refresh: true } : {}),
    }),
    [periodKey],
  );
  return useSpendRead(scope, true);
}

/**
 * Only file identity is observed, never stats, authority, tokens, or streaming.
 * The subscription remembers every file change, including A → B → A in one React
 * batch. Comparing just the final path would let an outstanding A read survive.
 * Neither the file key nor this renderer-local generation crosses IPC.
 */
function sessionFileSource(sessionId: SessionId) {
  let snapshot: { file: string | undefined; present: boolean } | undefined;
  const getSnapshot = () => {
    const session = useSessionsStore.getState().sessions.get(sessionId);
    const file = session?.sessionFile;
    const present = session !== undefined;
    if (!snapshot || snapshot.file !== file || snapshot.present !== present) {
      snapshot = { file, present };
    }
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe: (notify: () => void) =>
      useSessionsStore.subscribe(() => {
        const previous = snapshot;
        if (getSnapshot() !== previous) notify();
      }),
  };
}

export function useGatewaySessionSpend(sessionId: SessionId): GatewaySpendRead {
  const source = useMemo(() => sessionFileSource(sessionId), [sessionId]);
  const generation = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const scope = useMemo<ReadScope>(
    () => ({
      kind: "direct_session_partial",
      isCurrent: () => source.getSnapshot() === generation,
      invoke: (refresh) =>
        window.pivis.invoke("gatewaySpend.session", {
          sessionId,
          ...(refresh ? { refresh: true } : {}),
        }),
    }),
    [sessionId, source, generation],
  );
  return useSpendRead(scope);
}
