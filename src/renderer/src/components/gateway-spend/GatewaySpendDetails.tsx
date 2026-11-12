import type { GatewaySpendIssue, GatewaySpendResult } from "@shared/gateway-spend.js";
import type React from "react";
import { useId } from "react";
import { Spinner } from "../common/Spinner.js";
import { IconRestart } from "../common/icons.js";
import type { GatewaySpendRead } from "./use-gateway-spend.js";
import "./GatewaySpend.css";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const ISSUE_LABELS: Record<GatewaySpendIssue, string> = {
  invalid_config: "Gateway spend configuration is invalid.",
  cli_missing: "The audit reader is unavailable.",
  query_failed: "The audit-log read failed.",
  timeout: "The audit-log read timed out.",
  invalid_response: "The audit-log response could not be read.",
  tracking_unavailable: "Session tracking is unavailable.",
  session_unavailable: "This session is unavailable for a spend read.",
};

export function spendValue(result: GatewaySpendResult | null): string {
  if (!result) return "Unavailable";
  if (result.state === "not_tracked") return "Not tracked";
  const amount = result.snapshot?.amountUsd;
  if (amount != null) return `${amount > 0 && amount < 0.01 ? "<$0.01" : USD.format(amount)} USD`;
  if (result.state === "pending") return "Awaiting audit logs";
  if (result.snapshot || result.state === "ready") return "No priced records";
  return "Unavailable";
}

export function spendMonth(result: GatewaySpendResult | null): string {
  return result?.period ? MONTH.format(new Date(result.period.start)) : "Current month";
}

function utc(value: string): string {
  return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function Timestamp({ value }: { value: string }): React.ReactElement {
  return <time dateTime={value}>{utc(value)}</time>;
}

function DetailRow({
  label,
  children,
}: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="gateway-spend__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function GatewaySpendDetails({
  read,
  session = false,
}: { read: GatewaySpendRead; session?: boolean }): React.ReactElement {
  const { result, busy, failed, checkedAt, refreshBlocked, refresh } = read;
  const refreshHintId = useId();
  const unpriced = result?.snapshot?.unpricedRequests ?? 0;
  const partial = session || unpriced > 0;
  const stale = result?.stale || (failed && result?.snapshot != null);
  const issue = failed
    ? "Gateway spend could not be read. Try refreshing."
    : result?.issue
      ? ISSUE_LABELS[result.issue]
      : result?.state === "unavailable"
        ? "Gateway spend is unavailable."
        : null;

  return (
    <div className="gateway-spend" aria-busy={busy}>
      <div className="gateway-spend__headline" role="status">
        <span className="gateway-spend__value">
          {!result && busy ? "Reading audit logs…" : spendValue(result)}
        </span>
        {partial && !session && <span className="gateway-spend__partial">Partial</span>}
      </div>
      {session ? (
        <p className="gateway-spend__note">
          Direct session only. No child rollups; untracked request paths are not included.
        </p>
      ) : (
        <p className="gateway-spend__note">
          Current month-to-date · Personal legacy gateway · all harnesses
        </p>
      )}
      {result?.state === "not_tracked" && (
        <p className="gateway-spend__note">No direct gateway tracking record for this session.</p>
      )}
      {result?.state === "pending" && (
        <p className="gateway-spend__note">Pending: audit records may arrive later.</p>
      )}
      {unpriced > 0 && (
        <p className="gateway-spend__notice">
          Partial: {unpriced} unpriced requests excluded from the total.
        </p>
      )}
      {stale && (
        <p className="gateway-spend__notice">Stale · showing the last available audit snapshot.</p>
      )}
      {issue && (
        <p className="gateway-spend__error" role="status">
          {issue}
        </p>
      )}
      <dl className="gateway-spend__rows">
        <DetailRow label="Source">{result?.source ?? "Datadog gateway audit logs"}</DetailRow>
        {session && (
          <DetailRow label="Tracking">
            {result?.trackedSince ? (
              <>
                Tracked since <Timestamp value={result.trackedSince} />
              </>
            ) : result?.state === "not_tracked" ? (
              "Not tracked"
            ) : (
              "Tracking start unavailable"
            )}
          </DetailRow>
        )}
        {result?.period ? (
          <>
            <DetailRow label="From (UTC)">
              <Timestamp value={result.period.start} />
            </DetailRow>
            <DetailRow label="Until (exclusive, UTC)">
              <Timestamp value={result.period.endExclusive} />
            </DetailRow>
          </>
        ) : (
          <DetailRow label="Period">Unavailable</DetailRow>
        )}
        {result?.snapshot && (
          <DetailRow label="Requests">
            {result.snapshot.pricedRequests} priced · {result.snapshot.unpricedRequests} unpriced
          </DetailRow>
        )}
        <DetailRow label="As of">
          {result?.snapshot ? (
            <Timestamp value={result.snapshot.asOf} />
          ) : result?.state === "pending" ? (
            "Awaiting audit logs"
          ) : (
            "No audit snapshot"
          )}
        </DetailRow>
        {checkedAt && (
          <DetailRow label="Checked">
            <Timestamp value={checkedAt} />
          </DetailRow>
        )}
      </dl>
      <p className="gateway-spend__note">Gateway-recorded USD, not an invoice or token estimate.</p>
      <div className="gateway-spend__refresh-row">
        <button
          type="button"
          className="gateway-spend__refresh"
          aria-label={
            session ? "Refresh direct session gateway spend" : "Refresh monthly gateway spend"
          }
          aria-describedby={refreshBlocked ? refreshHintId : undefined}
          disabled={busy || refreshBlocked}
          onClick={refresh}
        >
          {busy ? <Spinner aria-hidden="true" /> : <IconRestart />}
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        {refreshBlocked && result?.nextRefreshAt && (
          <span className="gateway-spend__refresh-hint" id={refreshHintId}>
            Refresh available <Timestamp value={result.nextRefreshAt} />
          </span>
        )}
      </div>
    </div>
  );
}
