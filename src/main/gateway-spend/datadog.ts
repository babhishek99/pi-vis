import type { GatewaySpendPeriod, GatewaySpendSnapshot } from "@shared/gateway-spend.js";
import { z } from "zod";
import { captureProcessOutput } from "../bounded-process.js";
import type { GatewaySpendConfig } from "./config.js";

const AggregateSchema = z.object({
  data: z.object({
    buckets: z
      .array(
        z.object({
          by: z.record(z.string(), z.unknown()),
          computes: z.object({
            c0: z.number().int().nonnegative(),
            c1: z.number().finite().nonnegative().nullish(),
          }),
        }),
      )
      .max(1),
  }),
  meta: z.object({
    status: z.literal("done"),
    warnings: z.array(z.unknown()).max(0).optional(),
    page: z.object({ after: z.never().optional() }).optional(),
  }),
});

export function parseGatewayAggregate(
  stdout: string,
  sum: boolean,
): { count: number; amount: number | null } {
  const parsed = AggregateSchema.parse(JSON.parse(stdout));
  const bucket = parsed.data.buckets[0];
  if (!bucket) return { count: 0, amount: null };
  if (Object.keys(bucket.by).length !== 0) throw new Error("Unexpected aggregate groups");
  const { c0: count, c1: amount } = bucket.computes;
  if (sum && count > 0 && amount == null) throw new Error("Missing aggregate cost");
  if (sum && count === 0 && amount != null && amount !== 0)
    throw new Error("Inconsistent aggregate cost");
  return { count, amount: sum && count > 0 ? amount! : null };
}

export interface GatewayAggregateRequest {
  config: GatewaySpendConfig;
  period: GatewaySpendPeriod;
  /** Validated opaque session tag only, never a renderer-supplied query. */
  sessionTag?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** Uses pup's existing OAuth session. No credentials are read by Pi-Vis and no
 * raw response/log/error text is published. Both calls are read-only. */
export async function queryGatewaySpend(
  request: GatewayAggregateRequest,
): Promise<GatewaySpendSnapshot> {
  const { config, period, sessionTag, env, signal } = request;
  if (sessionTag !== undefined && !/^[a-f0-9]{64}$/.test(sessionTag)) {
    throw new Error("Invalid session tag");
  }
  const query = `(${config.auditQuery}) @key_type:personal @user_email:"${config.userEmail}"${sessionTag ? ` @custom_tags.pivis_session:${sessionTag}` : ""}`;
  const start = Date.parse(period.start);
  const end = Date.parse(period.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new InvalidGatewayAggregateError();
  }
  // Datadog's `to` is inclusive; the public period uses an exclusive end.
  const to = new Date(end - 1).toISOString();
  const aggregate = async (priced: boolean) => {
    const { stdout } = await captureProcessOutput(
      config.pupExecutable,
      [
        "--read-only",
        "--no-agent",
        "--output=json",
        "logs",
        "aggregate",
        `--query=${query} ${priced ? "@cost:*" : "-@cost:*"}`,
        `--from=${period.start}`,
        `--to=${to}`,
        `--compute=${priced ? "count,sum(@cost)" : "count"}`,
        "--storage=flex",
      ],
      { timeoutMs: 60_000, maxBufferBytes: 128 * 1024, env, signal },
    );
    try {
      return parseGatewayAggregate(stdout, priced);
    } catch {
      throw new InvalidGatewayAggregateError();
    }
  };
  // A separate presence query distinguishes explicit free requests from
  // missing prices. A failed/incomplete half invalidates the entire refresh.
  const results = await Promise.allSettled([aggregate(true), aggregate(false)]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const [priced, unpriced] = results.map((result) => {
    if (result.status !== "fulfilled") throw new InvalidGatewayAggregateError();
    return result.value;
  });
  return {
    amountUsd: priced!.amount,
    pricedRequests: priced!.count,
    unpricedRequests: unpriced!.count,
    asOf: new Date().toISOString(),
  };
}

export class InvalidGatewayAggregateError extends Error {
  constructor() {
    super("Invalid gateway aggregate");
    this.name = "InvalidGatewayAggregateError";
  }
}
