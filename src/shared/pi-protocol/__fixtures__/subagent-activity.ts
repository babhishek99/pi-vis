import type { ActivityAgent, ActivitySnapshot, ActivityWorkflow } from "../subagent-activity.js";

/** Synthetic display data only; no provider, runtime or persisted-session access. */
export function activityAgent(id: string, fields: Partial<ActivityAgent> = {}): ActivityAgent {
  return {
    id,
    recordId: id,
    parentAgentId: null,
    workflowId: null,
    name: id,
    agentType: "Explore",
    task: "Inspect route definitions",
    phase: null,
    state: "running",
    status: "running",
    detailsTruncated: false,
    ...fields,
  };
}

export function activityWorkflow(
  id: string,
  fields: Partial<ActivityWorkflow> = {},
): ActivityWorkflow {
  return {
    id,
    name: "Route audit",
    task: "Review API routes",
    state: "running",
    status: "running",
    detailsTruncated: false,
    ...fields,
  };
}

export function activitySnapshot(
  agents: ActivityAgent[] = [],
  workflows: ActivityWorkflow[] = [],
): ActivitySnapshot {
  const agentCounts: ActivitySnapshot["agentCounts"] = {
    running: 0,
    starting: 0,
    queued: 0,
    unwinding: 0,
    finished: 0,
  };
  const workflowCounts: ActivitySnapshot["workflowCounts"] = {
    running: 0,
    paused: 0,
    stopping: 0,
    finished: 0,
  };
  for (const row of agents) agentCounts[row.state]++;
  for (const row of workflows) workflowCounts[row.state]++;
  return {
    version: 1,
    observedAt: 1_700_000_000_000,
    agents,
    workflows,
    agentCounts,
    workflowCounts,
    omitted: { agents: 0, workflows: 0 },
    pendingOperations: false,
    unwindingOperations: false,
    pendingNotifications: false,
  };
}
