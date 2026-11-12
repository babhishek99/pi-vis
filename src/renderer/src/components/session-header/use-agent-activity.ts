import type { SessionId } from "@shared/ids.js";
import {
  type SubagentActivityResult,
  SubagentActivityResultSchema,
} from "@shared/pi-protocol/subagent-activity.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AuthorityObservation, querySession } from "../../lib/session-intent.js";
import { useSessionsStore } from "../../stores/sessions-store.js";

type ReadState = SubagentActivityResult | { status: "checking" | "synchronizing" };

/** Presentation-only polling; never writes a query result into the session store. */
export function useAgentActivity(
  sessionId: SessionId,
  observation: AuthorityObservation | undefined,
): {
  result: ReadState;
  refresh: () => void;
} {
  const active = useSessionsStore((state) => state.activeSessionId === sessionId);
  const hostInstanceId = observation?.owner.hostInstanceId;
  const sessionEpoch = observation?.owner.sessionEpoch;
  // A fresh lease on *every* availability/owner/visit change also fences A→B→A.
  // Do not key only by a string that can become equal after an unavailable gap.
  const [visitRevision, advanceVisit] = useState(0);
  const lease = useMemo(
    () => ({ sessionId, active, hostInstanceId, sessionEpoch, visitRevision }),
    [sessionId, active, hostInstanceId, sessionEpoch, visitRevision],
  );
  const currentLease = useRef<typeof lease | undefined>(lease);
  currentLease.current = lease;
  const [sample, setSample] = useState<{ lease: typeof lease; result: SubagentActivityResult }>();
  const refreshRef = useRef<(() => void) | null>(null);

  // React may coalesce A→B→A or unavailable→available into one render with
  // identical final props. Retire at the actual store boundary, not afterward.
  useLayoutEffect(
    () =>
      useSessionsStore.subscribe((state, previous) => {
        const now = state.sessions.get(sessionId);
        const prior = previous.sessions.get(sessionId);
        const owner = now?.authorityProjection?.authoritativeSnapshot?.owner;
        const priorOwner = prior?.authorityProjection?.authoritativeSnapshot?.owner;
        if (
          (state.activeSessionId === sessionId) === (previous.activeSessionId === sessionId) &&
          now?.availability === prior?.availability &&
          now?.authorityProjection?.semantic.state === prior?.authorityProjection?.semantic.state &&
          owner?.hostInstanceId === priorOwner?.hostInstanceId &&
          owner?.sessionEpoch === priorOwner?.sessionEpoch
        )
          return;
        currentLease.current = undefined;
        advanceVisit((revision) => revision + 1);
      }),
    [sessionId],
  );

  useEffect(() => {
    if (!active || hostInstanceId === undefined || sessionEpoch === undefined) return;
    const owner = { hostInstanceId, sessionEpoch };
    let retired = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = (): boolean => {
      if (retired || currentLease.current !== lease) return false;
      const state = useSessionsStore.getState();
      const session = state.sessions.get(sessionId);
      const projection = session?.authorityProjection;
      const now = projection?.authoritativeSnapshot?.owner;
      return (
        state.activeSessionId === sessionId &&
        session?.availability === "available" &&
        projection?.semantic.state === "following" &&
        now?.hostInstanceId === hostInstanceId &&
        now.sessionEpoch === sessionEpoch
      );
    };
    const read = async (): Promise<void> => {
      if (inFlight || !current()) return;
      inFlight = true;
      clearTimeout(timer);
      let result: SubagentActivityResult = { status: "failed" };
      try {
        const reply = await querySession(sessionId, { type: "get_subagent_activity" }, { owner });
        if (
          reply.status === "ok" &&
          reply.response.success &&
          reply.owner.hostInstanceId === hostInstanceId &&
          reply.owner.sessionEpoch === sessionEpoch
        ) {
          const parsed = SubagentActivityResultSchema.safeParse(reply.response.data);
          if (parsed.success) result = parsed.data;
        }
      } catch {
        /* bounded read failure is unknown activity, never zero */
      }
      inFlight = false;
      if (!current()) return;
      setSample({ lease, result });
      timer = setTimeout(
        () => {
          void read();
        },
        result.status === "ready" ? 2_000 : 5_000,
      );
    };
    const refresh = (): void => {
      void read();
    };
    refreshRef.current = refresh;
    refresh();
    const onVisible = (): void => {
      if (document.visibilityState !== "hidden") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      retired = true;
      clearTimeout(timer);
      if (refreshRef.current === refresh) refreshRef.current = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [lease, sessionId, active, hostInstanceId, sessionEpoch]);

  return {
    result:
      !active || hostInstanceId === undefined || sessionEpoch === undefined
        ? { status: "synchronizing" }
        : sample?.lease === lease
          ? sample.result
          : { status: "checking" },
    refresh: () => refreshRef.current?.(),
  };
}
