import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewaySpendSnapshot } from "@shared/gateway-spend.js";
import { GatewaySpendResultSchema } from "@shared/gateway-spend.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedProcessError } from "../bounded-process.js";
import { InvalidGatewayAggregateError } from "./datadog.js";
import { GatewaySpendService, readSessionSpendTag, sessionSpendTag } from "./service.js";
import { captureSessionSpendTarget } from "./session-target.js";

const roots: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const config = {
  version: 1,
  pupExecutable: process.execPath,
  auditQuery: 'service:fixture "audit trail message"',
  userEmail: "person@example.test",
  gateways: [{ provider: "fixture-gateway", baseUrl: "https://gateway.example.test/v1" }],
};
const priced: GatewaySpendSnapshot = {
  amountUsd: 12.345678,
  pricedRequests: 42,
  unpricedRequests: 0,
  asOf: "2026-11-10T10:00:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(configure = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pivis-spend-service-"));
  roots.push(root);
  if (configure) await writeFile(path.join(root, "gateway-spend.json"), JSON.stringify(config));
  let now = new Date("2026-11-10T10:00:00.000Z");
  const query = vi.fn().mockResolvedValue(priced);
  const getEnv = vi.fn().mockResolvedValue({ SECRET: "never publish this" });
  const service = new GatewaySpendService({ directory: root, query, getEnv, now: () => now });
  stops.push(() => service.stop());
  const writeSession = async (id = "sdk-session-uuid", since = "2026-11-09T09:30:00.000Z") => {
    const file = path.join(root, `${id}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, cwd: "/fixture" })}\n`,
    );
    const { trackingDirectory } = JSON.parse(await service.hostAttributionEnvironment());
    await mkdir(trackingDirectory, { recursive: true });
    const sessionTag = sessionSpendTag(id);
    await writeFile(
      path.join(trackingDirectory, `${sessionTag}.json`),
      JSON.stringify({ version: 1, sessionTag, trackedSince: since }),
    );
    return { file, trackingDirectory, sessionTag };
  };
  return {
    root,
    service,
    query,
    getEnv,
    writeSession,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("gateway spend service", () => {
  it("does not run any CLI or read credentials before private launch configuration exists", async () => {
    const f = await fixture(false);
    expect(await f.service.month()).toMatchObject({ state: "not_configured", snapshot: null });
    expect(await f.service.session("/unread/path", () => true)).toMatchObject({
      state: "not_configured",
    });
    expect(await f.service.hostAttributionEnvironment()).toBe("");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.getEnv).not.toHaveBeenCalled();
    // Launch-scoped: editing config does not silently change an existing host's attribution scope.
    await writeFile(path.join(f.root, "gateway-spend.json"), JSON.stringify(config));
    expect((await f.service.month()).state).toBe("not_configured");
  });

  it("reports invalid configuration without echoing its private bytes", async () => {
    const f = await fixture(false);
    await writeFile(
      path.join(f.root, "gateway-spend.json"),
      JSON.stringify({ private: "sensitive config" }),
    );
    const service = new GatewaySpendService({
      directory: f.root,
      query: f.query,
      getEnv: f.getEnv,
    });
    const result = await service.month();
    expect(result).toMatchObject({ state: "unavailable", issue: "invalid_config", snapshot: null });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(f.query).not.toHaveBeenCalled();
  });

  it("coalesces calls, uses explicit previous month UTC, never accumulates refreshed amounts and bounds refresh", async () => {
    const f = await fixture();
    const held = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(held.promise);
    const first = f.service.month();
    const second = f.service.month(true);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    held.resolve(priced);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(GatewaySpendResultSchema.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({
      state: "ready",
      scope: "personal_gateway",
      stale: false,
      snapshot: priced,
      period: {
        start: "2026-10-01T00:00:00.000Z",
        endExclusive: "2026-11-01T00:00:00.000Z",
        timeZone: "UTC",
      },
    });
    expect(f.query.mock.calls[0]![0]).not.toHaveProperty("sessionTag");
    await f.service.month(true);
    expect(f.query).toHaveBeenCalledTimes(1);
    f.advance(61_000);
    const refreshed = await f.service.month(true);
    expect(refreshed.snapshot?.amountUsd).toBe(priced.amountUsd);
    expect(f.query).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(refreshed);
    for (const value of [
      config.userEmail,
      config.auditQuery,
      config.pupExecutable,
      config.gateways[0]!.baseUrl,
      "never publish this",
      f.root,
    ])
      expect(serialized).not.toContain(value);
  });

  it("persists a private, identity-scoped cache across restarts and never reuses a different account's totals", async () => {
    const f = await fixture();
    await f.service.month();
    const host = JSON.parse(await f.service.hostAttributionEnvironment());
    expect(host).toEqual({
      version: 1,
      gateways: config.gateways,
      trackingDirectory: expect.any(String),
    });
    expect(JSON.stringify(host)).not.toContain(config.userEmail);
    const cacheFile = path.join(path.dirname(host.trackingDirectory), "cache.json");
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
    const cache = await readFile(cacheFile, "utf8");
    expect(cache).not.toContain(config.userEmail);
    const next = new GatewaySpendService({
      directory: f.root,
      query: f.query,
      getEnv: f.getEnv,
      now: () => new Date("2026-11-10T10:01:00.000Z"),
    });
    expect((await next.month()).snapshot?.amountUsd).toBe(priced.amountUsd);
    expect(f.query).toHaveBeenCalledTimes(1);
    await writeFile(
      path.join(f.root, "gateway-spend.json"),
      JSON.stringify({ ...config, userEmail: "different@example.test" }),
    );
    const different = new GatewaySpendService({
      directory: f.root,
      query: f.query,
      getEnv: f.getEnv,
      now: () => new Date("2026-11-10T10:01:00.000Z"),
    });
    await different.month();
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new BoundedProcessError("timeout", "private timeout output"), "timeout"],
    [Object.assign(new Error("private path"), { code: "ENOENT" }), "cli_missing"],
    [new InvalidGatewayAggregateError(), "invalid_response"],
    [new Error("credential-like CLI error"), "query_failed"],
  ])("keeps prior costs visibly stale and sanitizes failures (%s)", async (error, issue) => {
    const f = await fixture();
    await f.service.month();
    f.advance(61_000);
    f.query.mockRejectedValueOnce(error);
    const result = await f.service.month(true);
    expect(result).toMatchObject({ state: "unavailable", stale: true, issue, snapshot: priced });
    expect(JSON.stringify(result)).not.toContain(error.message);
    await f.service.month(true);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("distinguishes no audit records, unpriced records and explicitly free records", async () => {
    const f = await fixture();
    f.query.mockResolvedValueOnce({ ...priced, amountUsd: null, pricedRequests: 0 });
    expect(await f.service.month()).toMatchObject({
      state: "pending",
      snapshot: { amountUsd: null },
    });
    f.advance(61_000);
    f.query.mockResolvedValueOnce({
      ...priced,
      amountUsd: null,
      pricedRequests: 0,
      unpricedRequests: 4,
    });
    expect(await f.service.month(true)).toMatchObject({
      state: "ready",
      snapshot: { amountUsd: null, unpricedRequests: 4 },
    });
    f.advance(61_000);
    f.query.mockResolvedValueOnce({ ...priced, amountUsd: 0, pricedRequests: 1 });
    expect(await f.service.month(true)).toMatchObject({
      state: "ready",
      snapshot: { amountUsd: 0, pricedRequests: 1 },
    });
  });

  it("rolls month cache keys at the UTC boundary instead of showing the old month as the new total", async () => {
    const f = await fixture();
    await f.service.month();
    f.advance(22 * 24 * 60 * 60_000);
    f.query.mockRejectedValueOnce(new Error("offline"));
    const result = await f.service.month();
    expect(result).toMatchObject({
      state: "unavailable",
      snapshot: null,
      period: { start: "2026-11-01T00:00:00.000Z", endExclusive: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("rechecks the reporting month when an in-flight aggregate crosses a UTC month boundary", async () => {
    const f = await fixture();
    const held = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(held.promise);
    const pending = f.service.month();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    f.advance(22 * 24 * 60 * 60_000);
    held.resolve(priced);
    const result = await pending;
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(result.period?.start).toBe("2026-11-01T00:00:00.000Z");
  });

  it("does not infer historical session totals, and queries direct opaque IDs only after a marker exists", async () => {
    const f = await fixture();
    const file = path.join(f.root, "historical.jsonl");
    const bytes = `${JSON.stringify({ type: "session", id: "old-sdk-id" })}\n`;
    await writeFile(file, bytes);
    expect(await f.service.session(file, () => true)).toMatchObject({
      state: "not_tracked",
      snapshot: null,
    });
    expect(await f.service.session(undefined, () => true)).toMatchObject({
      state: "not_tracked",
      snapshot: null,
    });
    expect(f.query).not.toHaveBeenCalled();
    const tracked = await f.writeSession();
    expect(await readSessionSpendTag(tracked.file)).toBe(tracked.sessionTag);
    const result = await f.service.session(tracked.file, () => true);
    expect(result).toMatchObject({
      state: "ready",
      scope: "direct_session_partial",
      trackedSince: "2026-11-09T09:30:00.000Z",
      period: { start: "2026-11-09T09:30:00.000Z" },
    });
    expect(f.query.mock.calls[0]![0].sessionTag).toBe(tracked.sessionTag);
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("fences a delayed session read after file transition or header identity replacement", async () => {
    const f = await fixture();
    const tracked = await f.writeSession();
    const held = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(held.promise);
    let current = true;
    const pending = f.service.session(tracked.file, () => current);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    current = false;
    held.resolve(priced);
    expect(await pending).toMatchObject({
      state: "unavailable",
      snapshot: null,
      issue: "session_unavailable",
    });
    current = true;
    const next = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(next.promise);
    f.advance(61_000);
    const replacement = f.service.session(tracked.file, () => current, true);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    await writeFile(tracked.file, `${JSON.stringify({ type: "session", id: "replacement" })}\n`);
    next.resolve(priced);
    expect(await replacement).toMatchObject({
      state: "unavailable",
      snapshot: null,
      issue: "session_unavailable",
    });
  });

  it("does not overwrite corrupt tracking metadata or infer tracking from existing costs", async () => {
    const f = await fixture();
    const tracked = await f.writeSession();
    const marker = path.join(tracked.trackingDirectory, `${tracked.sessionTag}.json`);
    await writeFile(marker, "invalid-marker");
    expect(await f.service.session(tracked.file, () => true)).toMatchObject({
      state: "unavailable",
      issue: "tracking_unavailable",
      snapshot: null,
    });
    expect(await readFile(marker, "utf8")).toBe("invalid-marker");
    expect(f.query).not.toHaveBeenCalled();
  });

  it("bounds distinct queued reads and serializes jobs even when many sessions ask at once", async () => {
    const f = await fixture();
    const held = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(held.promise);
    const month = f.service.month();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    const tracked = await Promise.all(
      Array.from({ length: 10 }, (_, index) => f.writeSession(`session-${index}`)),
    );
    let rejected = 0;
    const pending = tracked.map(async ({ file }) => {
      const result = await f.service.session(file, () => true);
      if (result.state === "unavailable") rejected++;
      return result;
    });
    // Excess jobs settle without starting subprocesses; their completion is
    // the evidence barrier proving the filesystem work reached queue admission.
    await vi.waitFor(() => {
      expect(rejected).toBe(3);
      expect(f.query).toHaveBeenCalledTimes(1);
    });
    held.resolve(priced);
    const results = await Promise.all(pending);
    await month;
    expect(results.filter((value) => value.state === "ready")).toHaveLength(7);
    expect(results.filter((value) => value.state === "unavailable")).toHaveLength(3);
    expect(f.query).toHaveBeenCalledTimes(8);
  });

  it("takes a queued session's upper bound at dispatch and ages its cache from that bound", async () => {
    const f = await fixture();
    const tracked = await Promise.all(
      Array.from({ length: 3 }, (_, index) => f.writeSession(`queued-${index}`)),
    );
    const held = deferred<GatewaySpendSnapshot>();
    f.query.mockReturnValueOnce(held.promise);
    const month = f.service.month();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    const sessions = tracked.map(({ file }) => f.service.session(file, () => true));
    // Admission, rather than a sleep, proves all three reads reached the queue
    // before the clock advances. Only the month job can dispatch at this point.
    await vi.waitFor(() => expect(Reflect.get(f.service, "inFlight").size).toBe(4));
    f.query.mockImplementation(() => {
      f.advance(59_000);
      return Promise.resolve(priced);
    });
    f.advance(59_000);
    held.resolve(priced);
    await month;
    const results = await Promise.all(sessions);
    const sessionCalls = f.query.mock.calls.slice(1).map(([request]) => request);
    expect(sessionCalls.map((request) => request.period.endExclusive)).toEqual([
      "2026-11-10T10:00:59.000Z",
      "2026-11-10T10:01:58.000Z",
      "2026-11-10T10:02:57.000Z",
    ]);
    for (const result of results) expect(result.snapshot?.asOf).toBe(result.period?.endExclusive);
    const lastTag = sessionCalls.at(-1)!.sessionTag;
    const lastFile = tracked.find(({ sessionTag }) => sessionTag === lastTag)!.file;
    expect(await f.service.session(lastFile, () => true)).toMatchObject({ stale: false });
    expect(f.query).toHaveBeenCalledTimes(4);
    f.advance(61_000); // The last query's coverage is now two minutes old.
    await f.service.session(lastFile, () => true);
    expect(f.query).toHaveBeenCalledTimes(5);
  });

  it("does not call a slow session result fresh just because it completed now", async () => {
    const f = await fixture();
    const tracked = await f.writeSession();
    f.query.mockImplementationOnce(() => {
      f.advance(121_000);
      return Promise.resolve(priced);
    });
    const result = await f.service.session(tracked.file, () => true);
    expect(result).toMatchObject({
      state: "ready",
      stale: true,
      snapshot: { asOf: "2026-11-10T10:00:00.000Z" },
      period: { endExclusive: "2026-11-10T10:00:00.000Z" },
    });
    await f.service.session(tracked.file, () => true);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("does not extend older session cache coverage from its completion timestamp", async () => {
    const f = await fixture();
    const tracked = await f.writeSession();
    await f.service.session(tracked.file, () => true);
    const cacheFile = path.join(path.dirname(tracked.trackingDirectory), "cache.json");
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    cache.entries[0].period.endExclusive = "2026-11-10T09:50:00.000Z";
    cache.entries[0].snapshot.asOf = "2026-11-10T09:59:00.000Z";
    await writeFile(cacheFile, JSON.stringify(cache));
    const next = new GatewaySpendService({
      directory: f.root,
      query: f.query,
      getEnv: f.getEnv,
      now: () => new Date("2026-11-10T10:00:00.000Z"),
    });
    stops.push(() => next.stop());
    expect(await next.session(tracked.file, () => true)).toMatchObject({
      stale: false,
      period: { endExclusive: "2026-11-10T10:00:00.000Z" },
    });
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it.each(["_closing", "_dead"] as const)(
    "fences a query when its still-registered record becomes %s",
    async (flag) => {
      const f = await fixture();
      const tracked = await f.writeSession();
      const record = { sessionFile: tracked.file, [flag]: false };
      const target = captureSessionSpendTarget(() => record);
      const held = deferred<GatewaySpendSnapshot>();
      f.query.mockReturnValueOnce(held.promise);
      const pending = f.service.session(target.file, target.isCurrent);
      await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
      record[flag] = true; // Host/lock retirement has not deleted the record yet.
      held.resolve(priced);
      expect(await pending).toMatchObject({
        state: "unavailable",
        snapshot: null,
        issue: "session_unavailable",
      });
    },
  );

  it("aborts outstanding captures and prevents queued/new queries on shutdown", async () => {
    const f = await fixture();
    const tracked = await f.writeSession();
    f.query.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        }),
    );
    const month = f.service.month();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    const session = f.service.session(tracked.file, () => true);
    await f.service.stop();
    expect((await month).state).toBe("unavailable");
    expect((await session).state).toBe("unavailable");
    expect((await f.service.month()).state).toBe("unavailable");
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
