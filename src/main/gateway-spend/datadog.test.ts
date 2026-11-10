import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureProcessOutput } from "../bounded-process.js";
import {
  InvalidGatewayAggregateError,
  parseGatewayAggregate,
  queryGatewaySpend,
} from "./datadog.js";

vi.mock("../bounded-process.js", () => ({ captureProcessOutput: vi.fn() }));
const aggregate = (count: number, amount?: number) =>
  JSON.stringify({
    data: {
      buckets: [
        { by: {}, computes: { c0: count, ...(amount === undefined ? {} : { c1: amount }) } },
      ],
    },
    meta: { status: "done" },
  });
const empty = JSON.stringify({ data: { buckets: [] }, meta: { status: "done" } });
const request = {
  config: {
    version: 1 as const,
    pupExecutable: "/trusted/bin/pup",
    auditQuery: 'service:gateway env:fixture "audit trail message"',
    userEmail: "person@example.test",
    gateways: [{ provider: "fixture", baseUrl: "https://gateway.example.test/v1" }],
  },
  period: {
    start: "2024-02-01T00:00:00.000Z",
    endExclusive: "2024-03-01T00:00:00.000Z",
    timeZone: "UTC" as const,
  },
  env: { PATH: "/trusted/bin", SECRET_FIXTURE: "not-for-renderer" },
  signal: new AbortController().signal,
};
beforeEach(() => vi.resetAllMocks());

describe("Datadog personal gateway audit reader", () => {
  it("makes only bounded read-only personal flex queries with inclusive CLI end and validated tags", async () => {
    vi.mocked(captureProcessOutput).mockImplementation(async (_exe, args) => ({
      stdout: args.some((arg) => arg.endsWith(" -@cost:*"))
        ? aggregate(2)
        : aggregate(12, 7.123456),
      stderr: "private CLI output never returned",
    }));
    const result = await queryGatewaySpend({ ...request, sessionTag: "a".repeat(64) });
    expect(result).toMatchObject({ amountUsd: 7.123456, pricedRequests: 12, unpricedRequests: 2 });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("not-for-renderer");
    expect(captureProcessOutput).toHaveBeenCalledTimes(2);
    for (const [executable, args, options] of vi.mocked(captureProcessOutput).mock.calls) {
      expect(executable).toBe("/trusted/bin/pup");
      expect(args).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--no-agent",
          "--output=json",
          "logs",
          "aggregate",
          "--storage=flex",
          "--to=2024-02-29T23:59:59.999Z",
        ]),
      );
      expect(args.find((arg) => arg.startsWith("--query="))).toContain(
        '@key_type:personal @user_email:"person@example.test" @custom_tags.pivis_session:',
      );
      expect(options).toMatchObject({
        timeoutMs: 60_000,
        maxBufferBytes: 128 * 1024,
        env: request.env,
        signal: request.signal,
      });
    }
    await expect(queryGatewaySpend({ ...request, sessionTag: "* OR *" })).rejects.toThrow(
      "Invalid session tag",
    );
    expect(captureProcessOutput).toHaveBeenCalledTimes(2);
  });

  it("keeps no records distinct from an explicit zero-cost request", async () => {
    vi.mocked(captureProcessOutput).mockResolvedValue({ stdout: empty, stderr: "" });
    expect(await queryGatewaySpend(request)).toMatchObject({
      amountUsd: null,
      pricedRequests: 0,
      unpricedRequests: 0,
    });
    expect(parseGatewayAggregate(aggregate(3, 0), true)).toEqual({ count: 3, amount: 0 });
    expect(parseGatewayAggregate(aggregate(0, 0), true)).toEqual({ count: 0, amount: null });
  });

  it.each([
    "not json",
    JSON.stringify({ data: { buckets: [] }, meta: { status: "timeout" } }),
    JSON.stringify({
      data: { buckets: [] },
      meta: { status: "done", warnings: [{ code: "partial" }] },
    }),
    JSON.stringify({
      data: { buckets: [] },
      meta: { status: "done", page: { after: "incomplete" } },
    }),
    aggregate(5),
    aggregate(-1, 2),
    aggregate(1, -2),
    aggregate(0, 12),
    JSON.stringify({
      data: { buckets: [{ by: { harness: "pi" }, computes: { c0: 1, c1: 2 } }] },
      meta: { status: "done" },
    }),
  ])("rejects missing, malformed and incomplete costs: %s", (value) => {
    expect(() => parseGatewayAggregate(value, true)).toThrow();
  });

  it("waits for both captures on a partial failure instead of accumulating orphan queries", async () => {
    let complete!: (value: { stdout: string; stderr: string }) => void;
    const held = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      complete = resolve;
    });
    vi.mocked(captureProcessOutput)
      .mockRejectedValueOnce(new Error("sensitive stderr"))
      .mockReturnValueOnce(held);
    let settled = false;
    const result = queryGatewaySpend(request).catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    complete({ stdout: empty, stderr: "" });
    await result;
    expect(settled).toBe(true);
  });

  it("turns parser failures into a fixed secret-free error", async () => {
    vi.mocked(captureProcessOutput).mockResolvedValue({
      stdout: "secret-invalid-content",
      stderr: "",
    });
    await expect(queryGatewaySpend(request)).rejects.toEqual(new InvalidGatewayAggregateError());
  });
});
