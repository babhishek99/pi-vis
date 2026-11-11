import { describe, expect, it } from "vitest";
import { EscapeResultSchema } from "./runtime-state.js";
import { EscapeHostRequestSchema, SubagentStopReceiptSchema } from "./subagent-stop.js";

const request = {
  type: "escape",
  requestId: "escape-1",
  expectedHostInstanceId: "host-1",
  expectedSessionEpoch: 2,
  sequence: 1,
};
const receipt = {
  status: "requested",
  agents: 3,
  workflows: 2,
  pendingOperations: true,
  pendingNotifications: false,
};

describe("tab-scoped Escape contracts", () => {
  it("requires an owner and a positive safe-integer host sequence", () => {
    expect(EscapeHostRequestSchema.parse(request)).toEqual(request);
    for (const sequence of [
      undefined,
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(EscapeHostRequestSchema.safeParse({ ...request, sequence }).success).toBe(false);
    }
    expect(
      EscapeHostRequestSchema.safeParse({ ...request, expectedHostInstanceId: "" }).success,
    ).toBe(false);
  });
  it("retains bounded signal-request evidence without inventing settlement", () => {
    const value = {
      requestId: request.requestId,
      hostInstanceId: request.expectedHostInstanceId,
      sessionEpoch: 2,
      disposition: "abort_requested",
      target: "subagents",
      subagents: receipt,
    };
    expect(EscapeResultSchema.parse(value)).toEqual(value);
    expect(SubagentStopReceiptSchema.safeParse({ ...receipt, settled: true }).success).toBe(false);
    expect(SubagentStopReceiptSchema.safeParse({ ...receipt, agents: -1 }).success).toBe(false);
    for (const status of ["unavailable", "unsupported", "failed", "outcome_unknown"]) {
      expect(SubagentStopReceiptSchema.parse({ status })).toEqual({ status });
      expect(SubagentStopReceiptSchema.safeParse({ status, error: "private error" }).success).toBe(
        false,
      );
    }
  });
});
