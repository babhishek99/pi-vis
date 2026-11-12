import type { SessionId } from "@shared/ids.js";
import type { ActivitySnapshot } from "@shared/pi-protocol/subagent-activity.js";
import type React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import type { AuthorityObservation } from "../../lib/session-intent.js";
import { getTopEscapeClaim } from "../../stores/overlay-store.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import { Spinner } from "../common/Spinner.js";
import { IconAgents, IconClose } from "../common/icons.js";
import { type ActivityNode, agentActivityTree } from "./agent-activity-tree.js";
import { useAgentActivity } from "./use-agent-activity.js";
import "./AgentTray.css";

const UNKNOWN_COPY = {
  checking: "Checking agent activity…",
  synchronizing: "Activity unknown while this tab synchronizes.",
  unavailable: "Agent activity is unavailable in this runtime.",
  unsupported: "This extension does not support activity snapshots.",
  failed: "Could not read agent activity. The count is unknown.",
};

export function AgentTray({
  sessionId,
  observation,
}: {
  sessionId: SessionId;
  observation: AuthorityObservation | undefined;
}): React.ReactElement {
  const { result, refresh } = useAgentActivity(sessionId, observation);
  const snapshot = result.status === "ready" ? result.snapshot : undefined;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  const claim = useEscapeClaim(open);
  const roots = useMemo(() => (snapshot ? agentActivityTree(snapshot) : []), [snapshot]);

  useLayoutEffect(() => {
    if (!open) return;
    const fit = (): void => {
      const anchor = trigger.current?.getBoundingClientRect();
      const element = card.current;
      if (!anchor || !element) return;
      const gutter =
        (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) * 0.75;
      const width = element.getBoundingClientRect().width;
      const left = Math.max(
        gutter,
        Math.min(anchor.right - width, window.innerWidth - width - gutter),
      );
      const top = anchor.bottom + gutter / 2;
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.maxHeight = `${Math.max(0, window.innerHeight - top - gutter)}px`;
    };
    const controls = trigger.current?.parentElement?.parentElement;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    const observe = (): void => {
      observer?.disconnect();
      if (trigger.current) observer?.observe(trigger.current);
      if (card.current) observer?.observe(card.current);
      observer?.observe(document.documentElement);
      if (controls) {
        observer?.observe(controls);
        for (const child of controls.children) observer?.observe(child);
      }
      fit();
    };
    observe();
    const mutations =
      controls && typeof MutationObserver !== "undefined" ? new MutationObserver(observe) : null;
    if (controls) mutations?.observe(controls, { childList: true });
    window.addEventListener("resize", fit);
    if (document.activeElement === trigger.current)
      scroller.current?.focus({ preventScroll: true });
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        getTopEscapeClaim()?.token !== claim.current
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, claim]);

  useEffect(() => {
    if (!open) return;
    const inside = (event: Event): boolean => {
      const path = event.composedPath();
      return !!(
        (trigger.current && path.includes(trigger.current)) ||
        (card.current && path.includes(card.current))
      );
    };
    const dismiss = (event: Event): void => {
      if (!inside(event)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
    };
  }, [open]);

  const agents = snapshot
    ? snapshot.agentCounts.running +
      snapshot.agentCounts.starting +
      snapshot.agentCounts.queued +
      snapshot.agentCounts.unwinding
    : undefined;
  const workflows = snapshot
    ? snapshot.workflowCounts.running +
      snapshot.workflowCounts.paused +
      snapshot.workflowCounts.stopping
    : 0;
  const preparing =
    snapshot && agents === 0 && (snapshot.pendingOperations || snapshot.unwindingOperations);
  const label = snapshot
    ? `${agents} agents pending or active${workflows ? `, ${workflows} workflows` : ""}`
    : "Activity unknown";

  return (
    <div className="agent-tray">
      <button
        ref={trigger}
        type="button"
        className={`session-header__picker-btn agent-tray__trigger${open ? " agent-tray__trigger--open" : ""}`}
        aria-label={`Agents in this tab: ${label}`}
        aria-expanded={open}
        aria-controls={detailsId}
        aria-haspopup="dialog"
        title={`Agents in this tab · ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <IconAgents />
        <span className="agent-tray__count">
          {agents === undefined ? "?" : preparing ? "…" : agents}
        </span>
        {workflows > 0 && (
          <span className="agent-tray__workflow-count">
            {workflows} {workflows === 1 ? "flow" : "flows"}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            id={detailsId}
            className="agent-tray__card"
            role="dialog"
            aria-label="Agents in this tab"
          >
            <div className="agent-tray__header">
              <span>Agents in this tab</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close agent tray"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <IconClose />
              </button>
            </div>
            <ScrollFadeFrame
              frameClassName="agent-tray__frame"
              className="agent-tray__list"
              scrollerRef={scroller}
              tabIndex={0}
              aria-label="Agent activity list"
              fill
            >
              {snapshot ? (
                <>
                  <ActivitySummary snapshot={snapshot} />
                  {roots.length > 0 ? (
                    <ul className="agent-tray__tree" aria-label="Agents and workflows">
                      {roots.map((node) => (
                        <ActivityRow key={node.key} node={node} depth={0} />
                      ))}
                    </ul>
                  ) : (
                    <p className="agent-tray__empty">
                      {snapshot.pendingOperations || snapshot.unwindingOperations
                        ? "No agent records yet."
                        : "No agents or workflows in this runtime."}
                    </p>
                  )}
                  {(snapshot.omitted.agents > 0 || snapshot.omitted.workflows > 0) && (
                    <p className="agent-tray__note">
                      Not shown: {snapshot.omitted.agents} agents, {snapshot.omitted.workflows}{" "}
                      workflows. Counts include these rows.
                    </p>
                  )}
                  {(snapshot.pendingOperations ||
                    snapshot.unwindingOperations ||
                    snapshot.pendingNotifications) && (
                    <p className="agent-tray__note">
                      {[
                        snapshot.pendingOperations ? "Preparations pending" : "",
                        snapshot.unwindingOperations ? "Cleanup pending" : "",
                        snapshot.pendingNotifications ? "Notifications pending" : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </>
              ) : (
                <div className="agent-tray__unknown" role="status">
                  <p>{UNKNOWN_COPY[result.status === "ready" ? "failed" : result.status]}</p>
                  {result.status !== "checking" && result.status !== "synchronizing" && (
                    <button type="button" className="session-header__picker-btn" onClick={refresh}>
                      Retry activity read
                    </button>
                  )}
                </div>
              )}
            </ScrollFadeFrame>
            <div className="agent-tray__footer">
              {snapshot ? (
                <>
                  <span>Retained runtime records · read only</span>
                  <span>Observed {new Date(snapshot.observedAt).toLocaleTimeString()}</span>
                </>
              ) : (
                <span>Unknown does not mean no agents.</span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function ActivitySummary({ snapshot }: { snapshot: ActivitySnapshot }): React.ReactElement {
  const counts = snapshot.agentCounts;
  return (
    <p className="agent-tray__summary">
      {[
        `${counts.running} running`,
        `${counts.starting} starting`,
        `${counts.queued} queued`,
        `${counts.unwinding} unwinding`,
        `${counts.finished} finished`,
      ].join(" · ")}
    </p>
  );
}

function ActivityRow({ node, depth }: { node: ActivityNode; depth: number }): React.ReactElement {
  const { row } = node;
  const name = row.name || (node.kind === "agent" ? node.row.agentType || "Agent" : "Workflow");
  const state =
    row.state === "finished"
      ? ((
          {
            completed: "Completed",
            failed: "Failed",
            killed: "Stopped",
            steered: "Steered",
            aborted: "Aborted",
            stopped: "Stopped",
            error: "Failed",
          } as Record<string, string>
        )[row.status] ?? "Finished")
      : row.state.charAt(0).toUpperCase() + row.state.slice(1);
  const spinning = ["running", "starting", "unwinding", "stopping"].includes(row.state);
  return (
    <li
      className="agent-tray__item"
      data-activity-id={row.id}
      data-activity-kind={node.kind}
      data-activity-state={row.state}
    >
      <div
        className="agent-tray__row fade-scope"
        style={{
          paddingInlineStart: `calc(var(--space-3) + ${Math.min(depth, 4)} * var(--space-4))`,
        }}
      >
        <div className="agent-tray__identity">
          <FadeText className="agent-tray__name">{name}</FadeText>
          <span
            className={`agent-tray__state${state === "Failed" ? " agent-tray__state--failed" : ""}`}
          >
            {spinning && <Spinner aria-hidden="true" />}
            {state}
          </span>
        </div>
        <div className="agent-tray__kind">
          {node.kind === "workflow" ? "Workflow" : node.row.agentType}
          {node.missingOwner && <span> · {node.missingOwner}</span>}
        </div>
        {row.task && <p className="agent-tray__task">{row.task}</p>}
        {node.kind === "agent" && node.row.phase && (
          <p className="agent-tray__phase">Phase: {node.row.phase}</p>
        )}
        {row.detailsTruncated && <p className="agent-tray__note">Name or summary shortened</p>}
      </div>
      {node.children.length > 0 && (
        <ul className="agent-tray__tree" aria-label={`Children of ${name}`}>
          {node.children.map((child) => (
            <ActivityRow key={child.key} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
