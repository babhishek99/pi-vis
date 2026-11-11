import { z } from "zod";

/** Host transport identity and replay fence; sequence is assigned by SessionHost. */
export const EscapeHostRequestSchema = z.object({
  type: z.literal("escape"),
  requestId: z.string().min(1).max(128),
  expectedHostInstanceId: z.string().min(1),
  expectedSessionEpoch: z.number().int().nonnegative(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type EscapeHostRequest = z.infer<typeof EscapeHostRequestSchema>;

/** A stop receipt is signal-request evidence, never proof of worker/tool settlement. */
export const SubagentStopReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("requested"),
      agents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      workflows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      pendingOperations: z.boolean(),
      pendingNotifications: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["unavailable", "unsupported", "failed", "outcome_unknown"]),
    })
    .strict(),
]);
export type SubagentStopReceipt = z.infer<typeof SubagentStopReceiptSchema>;
