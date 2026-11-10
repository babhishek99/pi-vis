import { describe, expect, it } from "vitest";
import {
  GatewaySessionSpendRequestSchema,
  GatewaySpendRequestSchema,
  GatewaySpendSnapshotSchema,
  previousUtcMonth,
} from "./gateway-spend.js";

describe("previousUtcMonth", () => {
  it.each([
    ["2026-11-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["2026-01-20T13:30:00.000Z", "2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["2024-03-31T23:59:59.999Z", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
    ["2026-03-01T00:30:00+09:00", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    ["2026-11-01T00:30:00-04:00", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
  ])("uses completed UTC calendar boundaries for %s", (input, start, endExclusive) => {
    expect(previousUtcMonth(new Date(input))).toEqual({ start, endExclusive, timeZone: "UTC" });
  });
});

it("never accepts a cached numeric zero without priced records", () => {
  expect(
    GatewaySpendSnapshotSchema.safeParse({
      amountUsd: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      asOf: "2026-11-10T10:00:00.000Z",
    }).success,
  ).toBe(false);
  expect(
    GatewaySpendSnapshotSchema.safeParse({
      amountUsd: 0,
      pricedRequests: 1,
      unpricedRequests: 0,
      asOf: "2026-11-10T10:00:00.000Z",
    }).success,
  ).toBe(true);
});

it("allows only bounded session identity and refresh, never arbitrary query/path/time input", () => {
  expect(GatewaySpendRequestSchema.parse({})).toEqual({});
  expect(
    GatewaySessionSpendRequestSchema.parse({ sessionId: "renderer-id", refresh: true }),
  ).toEqual({ sessionId: "renderer-id", refresh: true });
  for (const value of [{ query: "*" }, { from: "now-30d" }, { refresh: "yes" }]) {
    expect(GatewaySpendRequestSchema.safeParse(value).success).toBe(false);
  }
  for (const value of [
    { sessionId: "x", file: "/etc/passwd" },
    { sessionId: "" },
    { sessionId: "x".repeat(129) },
  ]) {
    expect(GatewaySessionSpendRequestSchema.safeParse(value).success).toBe(false);
  }
});
