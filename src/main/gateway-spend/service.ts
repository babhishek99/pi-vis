import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type GatewaySpendIssue,
  type GatewaySpendPeriod,
  GatewaySpendPeriodSchema,
  type GatewaySpendResult,
  type GatewaySpendSnapshot,
  GatewaySpendSnapshotSchema,
  currentUtcMonth,
} from "@shared/gateway-spend.js";
import { z } from "zod";
import { boundedProcessFailureKind } from "../bounded-process.js";
import {
  type LoadedGatewaySpendConfig,
  gatewaySpendDataDirectory,
  loadGatewaySpendConfig,
  readBoundedJson,
} from "./config.js";
import {
  type GatewayAggregateRequest,
  InvalidGatewayAggregateError,
  queryGatewaySpend,
} from "./datadog.js";

const MIN_REFRESH_MS = 60_000;
const MONTH_TTL_MS = 60 * 60_000;
const SESSION_TTL_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_QUEUED_READS = 8;
const TrackingMarkerSchema = z
  .object({
    version: z.literal(1),
    sessionTag: z.string().regex(/^[a-f0-9]{64}$/),
    trackedSince: z.iso.datetime(),
  })
  .strict();
const CacheEntrySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  period: GatewaySpendPeriodSchema,
  snapshot: GatewaySpendSnapshotSchema,
});
type CacheEntry = z.infer<typeof CacheEntrySchema>;
const CacheSchema = z.object({
  version: z.literal(1),
  entries: z.array(CacheEntrySchema).max(MAX_CACHE_ENTRIES),
});

export function sessionSpendTag(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/** Read only the first bounded header, never hydrate or mutate a transcript. */
export async function readSessionSpendTag(file: string): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const firstNewline = bytes.subarray(0, bytesRead).indexOf(10);
    if (firstNewline < 0) return null;
    const header = z
      .object({ type: z.literal("session"), id: z.string().min(1).max(128) })
      .safeParse(JSON.parse(bytes.toString("utf8", 0, firstNewline)));
    return header.success ? sessionSpendTag(header.data.id) : null;
  } finally {
    await handle.close();
  }
}

function emptyResult(
  scope: GatewaySpendResult["scope"],
  period: GatewaySpendPeriod | null,
): GatewaySpendResult {
  return {
    state: "not_configured",
    scope,
    source: "Datadog gateway audit logs",
    period,
    snapshot: null,
    trackedSince: null,
    stale: false,
    issue: null,
    nextRefreshAt: null,
  };
}

interface GatewaySpendServiceOptions {
  directory: string;
  getEnv: () => Promise<NodeJS.ProcessEnv>;
  now?: () => Date;
  query?: (request: GatewayAggregateRequest) => Promise<GatewaySpendSnapshot>;
}

/** Read-only billing service. It owns authentication execution, bounded cache,
 * coalescing and rate limits; it does not participate in live Pi authority. */
export class GatewaySpendService {
  private readonly configuration: Promise<LoadedGatewaySpendConfig>;
  private readonly now: () => Date;
  private readonly query: (request: GatewayAggregateRequest) => Promise<GatewaySpendSnapshot>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly attempts = new Map<string, { at: number; issue: GatewaySpendIssue | null }>();
  private cacheLoaded: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Promise<GatewaySpendResult>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(private readonly options: GatewaySpendServiceOptions) {
    this.configuration = loadGatewaySpendConfig(options.directory);
    this.now = options.now ?? (() => new Date());
    this.query = options.query ?? queryGatewaySpend;
  }

  /** Abort read-only subprocesses and prevent queued work during app teardown. */
  stop(): Promise<void> {
    this.controller.abort();
    return this.tail;
  }

  /** No query, user identity or authentication material is passed to the child. */
  async hostAttributionEnvironment(): Promise<string> {
    const loaded = await this.configuration;
    if (loaded.state !== "configured") return "";
    return JSON.stringify({
      version: 1,
      gateways: loaded.config.gateways,
      trackingDirectory: path.join(
        gatewaySpendDataDirectory(this.options.directory, loaded.fingerprint),
        "tracking",
      ),
    });
  }

  async month(refresh = false): Promise<GatewaySpendResult> {
    const loaded = await this.configuration;
    const period = currentUtcMonth(this.now());
    const base = emptyResult("personal_gateway", period);
    if (loaded.state !== "configured") return this.unconfigured(base, loaded);
    // At the exact UTC boundary no time has elapsed; do not query an inverted
    // inclusive Datadog range or turn the empty interval into a known $0.
    if (period.start === period.endExclusive) return { ...base, state: "pending" };
    const result = await this.read(
      loaded,
      base,
      // Separate semantics from the older completed-month cache namespace.
      `month-to-date:${period.start}`,
      () => currentUtcMonth(this.now()),
      MONTH_TTL_MS,
      refresh,
    );
    // A slow/queued read may cross midnight on the first of the month. Never
    // publish a predecessor amount as the new current month's total.
    if (currentUtcMonth(this.now()).start !== period.start) return this.month();
    return result;
  }

  async session(
    file: string | undefined,
    isCurrent: () => boolean,
    refresh = false,
  ): Promise<GatewaySpendResult> {
    const base = emptyResult("direct_session_partial", null);
    const loaded = await this.configuration;
    if (loaded.state !== "configured") return this.unconfigured(base, loaded);
    if (!isCurrent()) return { ...base, state: "unavailable", issue: "session_unavailable" };
    if (!file) return { ...base, state: "not_tracked" };
    let tag: string | null;
    try {
      tag = await readSessionSpendTag(file);
    } catch (error) {
      return {
        ...base,
        state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_tracked" : "unavailable",
        issue: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "tracking_unavailable",
      };
    }
    if (!isCurrent()) return { ...base, state: "unavailable", issue: "session_unavailable" };
    if (!tag) return { ...base, state: "unavailable", issue: "tracking_unavailable" };
    let marker: z.infer<typeof TrackingMarkerSchema>;
    try {
      marker = TrackingMarkerSchema.parse(
        await readBoundedJson(
          path.join(
            gatewaySpendDataDirectory(this.options.directory, loaded.fingerprint),
            "tracking",
            `${tag}.json`,
          ),
          4096,
        ),
      );
      if (marker.sessionTag !== tag || Date.parse(marker.trackedSince) > this.now().getTime()) {
        throw new Error("Invalid tracking marker");
      }
    } catch (error) {
      return {
        ...base,
        state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_tracked" : "unavailable",
        issue: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "tracking_unavailable",
      };
    }
    const trackedBase = { ...base, trackedSince: marker.trackedSince };
    if (Date.parse(marker.trackedSince) === this.now().getTime()) {
      return { ...trackedBase, state: "pending" };
    }
    const result = await this.read(
      loaded,
      trackedBase,
      `session:${tag}:${marker.trackedSince}`,
      () => ({
        start: marker.trackedSince,
        endExclusive: this.now().toISOString(),
        timeZone: "UTC",
      }),
      SESSION_TTL_MS,
      refresh,
      tag,
    );
    // Billing attribution follows the durable Pi session, not whichever file a
    // renderer tab or transition happens to represent when an async read ends.
    if (!isCurrent()) return { ...base, state: "unavailable", issue: "session_unavailable" };
    try {
      if ((await readSessionSpendTag(file)) !== tag || !isCurrent()) {
        return { ...base, state: "unavailable", issue: "session_unavailable" };
      }
    } catch {
      return { ...base, state: "unavailable", issue: "session_unavailable" };
    }
    return result;
  }

  private unconfigured(
    base: GatewaySpendResult,
    loaded: LoadedGatewaySpendConfig,
  ): GatewaySpendResult {
    return loaded.state === "invalid"
      ? { ...base, state: "unavailable", issue: "invalid_config" }
      : base;
  }

  private async loadCache(directory: string): Promise<void> {
    try {
      const parsed = CacheSchema.parse(
        await readBoundedJson(path.join(directory, "cache.json"), 256 * 1024),
      );
      for (const entry of parsed.entries) this.cache.set(entry.key, entry);
    } catch {
      // Disposable, identity-scoped cache. Never fabricate a result on failure.
    }
  }

  private async persistCache(directory: string): Promise<void> {
    const temporary = path.join(directory, `.cache-${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, entries: [...this.cache.values()] }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, path.join(directory, "cache.json"));
    } catch {
      // A verified in-memory read remains usable if the disposable cache fails.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async read(
    loaded: Extract<LoadedGatewaySpendConfig, { state: "configured" }>,
    base: GatewaySpendResult,
    identity: string,
    period: () => GatewaySpendPeriod,
    ttl: number,
    refresh: boolean,
    sessionTag?: string,
  ): Promise<GatewaySpendResult> {
    if (this.controller.signal.aborted)
      return { ...base, state: "unavailable", issue: "query_failed" };
    const directory = gatewaySpendDataDirectory(this.options.directory, loaded.fingerprint);
    this.cacheLoaded ??= this.loadCache(directory);
    await this.cacheLoaded;
    const key = sessionSpendTag(identity);
    const existingFlight = this.inFlight.get(key);
    if (existingFlight) return existingFlight;
    const attempt = this.attempts.get(key);
    const now = this.now().getTime();
    const requestedPeriod = base.period ?? period();
    const candidate = this.cache.get(key);
    // A disposable cache cannot widen a month/session scope or include time
    // that has not elapsed (including a former full-month cache or clock jump).
    const cached =
      candidate &&
      candidate.period.start === requestedPeriod.start &&
      Date.parse(candidate.period.endExclusive) > Date.parse(candidate.period.start) &&
      Date.parse(candidate.period.endExclusive) <= now
        ? candidate
        : undefined;
    const lastAttempt = attempt?.at ?? (cached ? Date.parse(cached.snapshot.asOf) : 0);
    const nextRefreshAt =
      lastAttempt > 0 ? new Date(lastAttempt + MIN_REFRESH_MS).toISOString() : null;
    // Neither queue/query delay nor a restart can grant excluded minutes a
    // new freshness window, for current-month and direct-session reads alike.
    const coveredThrough = cached
      ? Math.min(Date.parse(cached.snapshot.asOf), Date.parse(cached.period.endExclusive))
      : 0;
    const fresh = cached && now >= coveredThrough && now - coveredThrough < ttl;
    const fromCache = (): GatewaySpendResult => ({
      ...base,
      state: attempt?.issue
        ? "unavailable"
        : cached
          ? cached.snapshot.pricedRequests + cached.snapshot.unpricedRequests > 0
            ? "ready"
            : "pending"
          : "unavailable",
      snapshot: cached?.snapshot ?? null,
      period: cached?.period ?? requestedPeriod,
      stale: Boolean(cached && (!fresh || attempt?.issue)),
      issue: attempt?.issue ?? null,
      nextRefreshAt,
    });
    if ((!refresh && fresh) || now < lastAttempt + MIN_REFRESH_MS) return fromCache();
    if (this.inFlight.size >= MAX_QUEUED_READS)
      return {
        ...fromCache(),
        state: "unavailable",
        issue: "query_failed",
        stale: Boolean(cached),
      };

    const flight = this.tail.then(async (): Promise<GatewaySpendResult> => {
      this.attempts.delete(key);
      this.attempts.set(key, { at: this.now().getTime(), issue: null });
      while (this.attempts.size > MAX_CACHE_ENTRIES)
        this.attempts.delete(this.attempts.keys().next().value!);
      try {
        this.controller.signal.throwIfAborted();
        const env = await this.options.getEnv();
        this.controller.signal.throwIfAborted();
        // Resolve month-to-date/session coverage only when this serialized job
        // dispatches, after queue/environment delay. A superseded month must
        // not dispatch or store a successor range under its predecessor key;
        // month() re-enters for the new generation after this job settles.
        const queryPeriod = period();
        if (
          queryPeriod.start !== requestedPeriod.start ||
          Date.parse(queryPeriod.endExclusive) <= Date.parse(queryPeriod.start)
        ) {
          return { ...base, state: "pending" };
        }
        const queried = await this.query({
          config: loaded.config,
          period: queryPeriod,
          env,
          signal: this.controller.signal,
          ...(sessionTag ? { sessionTag } : {}),
        });
        this.controller.signal.throwIfAborted();
        const snapshot = GatewaySpendSnapshotSchema.parse({
          ...queried,
          asOf: queryPeriod.endExclusive,
        });
        if ((snapshot.pricedRequests === 0) !== (snapshot.amountUsd === null))
          throw new InvalidGatewayAggregateError();
        const entry = { key, period: queryPeriod, snapshot };
        this.cache.delete(key);
        this.cache.set(key, entry);
        while (this.cache.size > MAX_CACHE_ENTRIES)
          this.cache.delete(this.cache.keys().next().value!);
        await this.persistCache(directory);
        const age = this.now().getTime() - Date.parse(snapshot.asOf);
        return {
          ...base,
          state: snapshot.pricedRequests + snapshot.unpricedRequests > 0 ? "ready" : "pending",
          period: queryPeriod,
          snapshot,
          stale: age < 0 || age >= ttl,
          nextRefreshAt: new Date(this.attempts.get(key)!.at + MIN_REFRESH_MS).toISOString(),
        };
      } catch (error) {
        const kind = boundedProcessFailureKind(error);
        const issue: GatewaySpendIssue =
          error instanceof InvalidGatewayAggregateError || error instanceof z.ZodError
            ? "invalid_response"
            : kind === "not-found"
              ? "cli_missing"
              : kind === "timeout"
                ? "timeout"
                : "query_failed";
        this.attempts.set(key, { at: this.now().getTime(), issue });
        return {
          ...fromCache(),
          state: "unavailable",
          stale: Boolean(cached),
          issue,
          nextRefreshAt: new Date(this.now().getTime() + MIN_REFRESH_MS).toISOString(),
        };
      }
    });
    this.inFlight.set(key, flight);
    this.tail = flight.then(
      () => {},
      () => {},
    );
    try {
      return await flight;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
