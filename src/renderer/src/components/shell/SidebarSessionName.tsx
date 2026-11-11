import type { SessionId } from "@shared/ids.js";
import type { RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import type React from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { dispatchSessionIntent } from "../../lib/session-intent.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";

export interface SidebarSessionRename {
  workspacePath: string;
  filePath: string;
  initialName: string;
  revision: number;
}

interface RenameRequest {
  intentId: string;
  name: string;
  sessionId: SessionId | undefined;
  owner?: RuntimeIdentity;
}

const CONFIRMATION_TIMEOUT_MS = 30_000;
const UNKNOWN_OUTCOME = "Rename wasn't confirmed. Check the current name before trying again.";

function sameOwner(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId && left.sessionEpoch === right.sessionEpoch;
}

interface SidebarSessionNameProps {
  name: string;
  sessionId: SessionId | undefined;
  rename: SidebarSessionRename | undefined;
  onFinish: (revision: number) => void;
  takeFocus: (revision: number) => boolean;
}

/** An entry point to Pi's existing rename intent, never a local label override. */
export function SidebarSessionName(props: SidebarSessionNameProps): React.ReactElement {
  return props.rename ? (
    <SessionNameEditor {...props} key={props.rename.revision} rename={props.rename} />
  ) : (
    <FadeText className="sidebar__session-name">{props.name}</FadeText>
  );
}

function SessionNameEditor({
  name,
  sessionId,
  rename,
  onFinish,
  takeFocus,
}: Omit<SidebarSessionNameProps, "rename"> & { rename: SidebarSessionRename }): React.ReactElement {
  const session = useSessionsStore((state) =>
    sessionId ? state.sessions.get(sessionId) : undefined,
  );
  const refreshWorkspaceSessions = useSessionsStore((state) => state.refreshWorkspaceSessions);
  const [draft, setDraft] = useState(rename.initialName);
  const [phase, setPhase] = useState<"waiting" | "submitted" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<RenameRequest | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(false);
  const finishedRef = useRef(false);
  const requiresExplicitRetryRef = useRef(false);
  const statusId = useId();
  const revision = rename.revision;
  // Unlike a modal, an inline field owns Escape only while it owns focus.
  useEscapeClaim(focused);

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const input = inputRef.current;
    return () => {
      mountedRef.current = false;
      requestRef.current = null;
      clearTimer();
      // Collapse, pagination, filtering or a file transition retires this edit.
      // StrictMode's connected-node effect replay must not close the editor.
      queueMicrotask(() => {
        if (input && !input.isConnected) onFinish(revision);
      });
    };
  }, [clearTimer, onFinish, revision]);

  useLayoutEffect(() => {
    if (!takeFocus(revision)) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [revision, takeFocus]);

  const finish = useCallback(() => {
    if (!mountedRef.current || finishedRef.current) return;
    finishedRef.current = true;
    requestRef.current = null;
    clearTimer();
    // Moving focus first causes blur; finishedRef prevents a second submission.
    // A late completion never takes focus back from another control.
    const input = inputRef.current;
    if (input && document.activeElement === input)
      input.closest<HTMLElement>(".sidebar__session")?.focus();
    onFinish(rename.revision);
  }, [clearTimer, onFinish, rename]);

  const fail = useCallback(
    (message: string) => {
      if (!mountedRef.current || finishedRef.current) return;
      requestRef.current = null;
      requiresExplicitRetryRef.current = true;
      clearTimer();
      setPhase(null);
      setError(message);
    },
    [clearTimer],
  );

  const advance = useCallback(() => {
    const request = requestRef.current;
    if (!request || !mountedRef.current || finishedRef.current) return;
    if (request.sessionId && request.sessionId !== sessionId) {
      fail(request.owner ? UNKNOWN_OUTCOME : "Session changed. Cancel and try again.");
      return;
    }
    // A stored row is selected by the normal click/open flow. Keep its draft
    // while that same file acquires a renderer record and following authority.
    if (!sessionId) return;
    const current = useSessionsStore.getState().sessions.get(sessionId);
    if (
      !current ||
      current.sessionFile !== rename.filePath ||
      current.workspacePath !== rename.workspacePath
    ) {
      fail(request.owner ? UNKNOWN_OUTCOME : "Session changed. Cancel and try again.");
      return;
    }
    request.sessionId = sessionId;
    if (current.status === "failed" || current.status === "exited") {
      fail(request.owner ? UNKNOWN_OUTCOME : "Session is unavailable. Reopen it and try again.");
      return;
    }
    const projection = current.authorityProjection;
    const snapshot = projection?.authoritativeSnapshot;
    const owner =
      snapshot?.owner ??
      (current.hostInstanceId !== undefined && current.sessionEpoch !== undefined
        ? { hostInstanceId: current.hostInstanceId, sessionEpoch: current.sessionEpoch }
        : undefined);
    if (request.owner && owner && !sameOwner(request.owner, owner)) {
      fail(UNKNOWN_OUTCOME);
      return;
    }
    if (
      current.availability !== "available" ||
      projection?.semantic.state !== "following" ||
      !snapshot
    )
      return;
    if (request.owner) {
      const requestOwner = request.owner;
      const outcome = snapshot.recentIntentOutcomes.find(
        (candidate) =>
          candidate.intentId === request.intentId &&
          candidate.kind === "rename" &&
          sameOwner(candidate.owner, requestOwner),
      );
      if (!outcome) return;
      if (outcome.state !== "completed") {
        fail(
          outcome.state === "outcome_unknown"
            ? UNKNOWN_OUTCOME
            : "Couldn't rename this session. Please try again.",
        );
        return;
      }
      finish();
      void refreshWorkspaceSessions(rename.workspacePath);
      return;
    }
    // Capture once and dispatch once. Receipts only admit work; the matching
    // same-owner authority outcome above is the only success acknowledgement.
    const observation = { owner: snapshot.owner, cursor: projection.semantic.cursor };
    request.owner = observation.owner;
    setPhase("submitted");
    const send = async () => {
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          { kind: "rename", name: request.name },
          observation,
          request.intentId,
        );
        if (requestRef.current !== request || !mountedRef.current) return;
        if (receipt.status === "not_admitted") fail("Rename wasn't accepted. Please try again.");
        // Unknown delivery may still acquire a terminal frame. Never replay it.
      } catch {
        // A thrown/rejected response does not prove the mutation failed. Await
        // its frame or the bounded unknown-outcome timeout, without replaying.
      }
    };
    void send();
  }, [fail, finish, refreshWorkspaceSessions, rename, sessionId]);

  useEffect(() => {
    // The selected record changes as a stored row opens and as frames arrive.
    // Read it afresh in advance(); a rendered observation may already be stale.
    if (session || phase) advance();
  }, [advance, phase, session]);

  const commit = (trigger: "enter" | "blur") => {
    // Merely leaving a failed/unknown edit is not permission to replay it,
    // including before React has painted the failure feedback.
    if (
      finishedRef.current ||
      requestRef.current ||
      (trigger === "blur" && requiresExplicitRetryRef.current)
    )
      return;
    const nextName = draft.trim();
    if (!nextName) {
      requiresExplicitRetryRef.current = true;
      setError("Enter a session name.");
      return;
    }
    if (draft === rename.initialName || nextName === name) {
      finish();
      return;
    }
    const request: RenameRequest = { intentId: crypto.randomUUID(), name: nextName, sessionId };
    requestRef.current = request;
    requiresExplicitRetryRef.current = false;
    setError(null);
    setPhase("waiting");
    timerRef.current = setTimeout(() => {
      if (requestRef.current === request)
        fail(
          request.owner ? UNKNOWN_OUTCOME : "Session is still starting. Try again when it's ready.",
        );
    }, CONFIRMATION_TIMEOUT_MS);
    advance();
  };

  const status =
    error ??
    (phase === "waiting" ? "Waiting for session…" : phase === "submitted" ? "Renaming…" : null);
  return (
    <span className="sidebar__session-name sidebar__session-rename">
      <input
        ref={inputRef}
        type="text"
        className="sidebar__session-name-input"
        aria-label="Session name"
        aria-describedby={status ? statusId : undefined}
        aria-invalid={error ? true : undefined}
        aria-busy={phase !== null}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        readOnly={phase !== null}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          if (requestRef.current) return;
          setDraft(event.target.value);
          requiresExplicitRetryRef.current = false;
          setError(null);
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
        onBlur={() => {
          setFocused(false);
          commit("blur");
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.stopPropagation();
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          if (event.key === "Escape") {
            if (!requestRef.current?.owner) finish();
          } else commit("enter");
        }}
      />
      {status && (
        <span
          id={statusId}
          className={`sidebar__session-rename-status${error ? " sidebar__session-rename-status--error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {status}
        </span>
      )}
    </span>
  );
}
