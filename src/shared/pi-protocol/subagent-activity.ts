import { z } from "zod";
import {
  ACTIVITY_ID_LIMIT,
  ACTIVITY_MAX_AGENTS,
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_WORKFLOWS,
  ACTIVITY_NAME_LIMIT,
  ACTIVITY_PHASE_LIMIT,
  ACTIVITY_TASK_LIMIT,
  activitySnapshotIsCoherent,
} from "../../../resources/pi-session-host/subagent-activity-limits.mjs";

export {
  ACTIVITY_MAX_AGENTS,
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_WORKFLOWS,
} from "../../../resources/pi-session-host/subagent-activity-limits.mjs";

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const displayText = (limit: number) =>
  z
    .string()
    .max(limit)
    .regex(/^[^\p{C}\u2028\u2029]*$/u);
const Id = displayText(ACTIVITY_ID_LIMIT).refine((value) => value.trim().length > 0);

export const ActivityAgentStateSchema = z.enum([
  "running",
  "starting",
  "queued",
  "unwinding",
  "finished",
]);
export type ActivityAgentState = z.infer<typeof ActivityAgentStateSchema>;
export const ActivityWorkflowStateSchema = z.enum(["running", "paused", "stopping", "finished"]);

export const ActivityAgentSchema = z
  .object({
    id: Id,
    recordId: Id.nullable(),
    parentAgentId: Id.nullable(),
    workflowId: Id.nullable(),
    name: displayText(ACTIVITY_NAME_LIMIT),
    agentType: displayText(ACTIVITY_NAME_LIMIT),
    task: displayText(ACTIVITY_TASK_LIMIT),
    phase: displayText(ACTIVITY_PHASE_LIMIT).nullable(),
    state: ActivityAgentStateSchema,
    status: z.enum(["queued", "running", "completed", "steered", "aborted", "stopped", "error"]),
    detailsTruncated: z.boolean(),
  })
  .strict();
export type ActivityAgent = z.infer<typeof ActivityAgentSchema>;

export const ActivityWorkflowSchema = z
  .object({
    id: Id,
    name: displayText(ACTIVITY_NAME_LIMIT),
    task: displayText(ACTIVITY_TASK_LIMIT),
    state: ActivityWorkflowStateSchema,
    status: z.enum(["running", "paused", "completed", "failed", "killed"]),
    detailsTruncated: z.boolean(),
  })
  .strict();
export type ActivityWorkflow = z.infer<typeof ActivityWorkflowSchema>;

/** Display-only observation of one captured runtime, never semantic authority. */
export const ActivitySnapshotSchema = z
  .object({
    version: z.literal(1),
    observedAt: Count,
    agents: z.array(ActivityAgentSchema).max(ACTIVITY_MAX_AGENTS),
    workflows: z.array(ActivityWorkflowSchema).max(ACTIVITY_MAX_WORKFLOWS),
    agentCounts: z
      .object({ running: Count, starting: Count, queued: Count, unwinding: Count, finished: Count })
      .strict(),
    workflowCounts: z
      .object({ running: Count, paused: Count, stopping: Count, finished: Count })
      .strict(),
    omitted: z.object({ agents: Count, workflows: Count }).strict(),
    pendingOperations: z.boolean(),
    unwindingOperations: z.boolean(),
    pendingNotifications: z.boolean(),
  })
  .strict()
  .refine(activitySnapshotIsCoherent, "Inconsistent activity counts or relationships")
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= ACTIVITY_MAX_BYTES,
    "Activity snapshot exceeds byte limit",
  );
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;

export const SubagentActivityResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), snapshot: ActivitySnapshotSchema }).strict(),
  z.object({ status: z.enum(["unavailable", "unsupported", "failed"]) }).strict(),
]);
export type SubagentActivityResult = z.infer<typeof SubagentActivityResultSchema>;
