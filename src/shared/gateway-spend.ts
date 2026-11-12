import { z } from "zod";

export const GatewaySpendRequestSchema = z.object({ refresh: z.boolean().optional() }).strict();
export const GatewaySessionSpendRequestSchema = GatewaySpendRequestSchema.extend({
  sessionId: z.string().min(1).max(128),
}).strict();

export const GatewaySpendPeriodSchema = z.object({
  start: z.iso.datetime(),
  endExclusive: z.iso.datetime(),
  timeZone: z.literal("UTC"),
});
export type GatewaySpendPeriod = z.infer<typeof GatewaySpendPeriodSchema>;

export const GatewaySpendSnapshotSchema = z
  .object({
    // Null means no priced audit records, NOT known zero spend. A real priced
    // request with an explicit zero cost may legitimately yield zero.
    amountUsd: z.number().finite().nonnegative().nullable(),
    pricedRequests: z.number().int().nonnegative(),
    unpricedRequests: z.number().int().nonnegative(),
    asOf: z.iso.datetime(),
  })
  .refine((value) => (value.pricedRequests === 0) === (value.amountUsd === null), {
    message: "A numeric cost requires priced audit records",
  });
export type GatewaySpendSnapshot = z.infer<typeof GatewaySpendSnapshotSchema>;

export const GatewaySpendIssueSchema = z.enum([
  "invalid_config",
  "cli_missing",
  "query_failed",
  "timeout",
  "invalid_response",
  "tracking_unavailable",
  "session_unavailable",
]);
export type GatewaySpendIssue = z.infer<typeof GatewaySpendIssueSchema>;

/** A billing read model, independent of AgentSession semantic authority. Never
 * contains queries, credentials, provider URLs, raw logs, or session paths. */
export const GatewaySpendResultSchema = z.object({
  state: z.enum(["not_configured", "not_tracked", "pending", "ready", "unavailable"]),
  scope: z.enum(["personal_gateway", "direct_session_partial"]),
  source: z.literal("Datadog gateway audit logs"),
  period: GatewaySpendPeriodSchema.nullable(),
  snapshot: GatewaySpendSnapshotSchema.nullable(),
  trackedSince: z.iso.datetime().nullable(),
  stale: z.boolean(),
  issue: GatewaySpendIssueSchema.nullable(),
  // Main enforces this bound too; repeated renderer calls cannot bypass it.
  nextRefreshAt: z.iso.datetime().nullable(),
});
export type GatewaySpendResult = z.infer<typeof GatewaySpendResultSchema>;

/** Current UTC calendar month to date, with an exclusive coverage upper bound. */
export function currentUtcMonth(now: Date): GatewaySpendPeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    endExclusive: now.toISOString(),
    timeZone: "UTC",
  };
}
