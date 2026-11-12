/** activitySnapshot v1 / pi-subagents protocol 4. Display data only. */
export const ACTIVITY_MAX_AGENTS = 128;
export const ACTIVITY_MAX_WORKFLOWS = 32;
export const ACTIVITY_ID_LIMIT = 128;
export const ACTIVITY_NAME_LIMIT = 80;
export const ACTIVITY_TASK_LIMIT = 240;
export const ACTIVITY_PHASE_LIMIT = 120;
export const ACTIVITY_MAX_BYTES = 512 * 1024;
export const ACTIVITY_RPC_TIMEOUT_MS = 250;

const AGENT_STATES = ["running", "starting", "queued", "unwinding", "finished"];
const WORKFLOW_STATES = ["running", "paused", "stopping", "finished"];
const AGENT_STATUSES = ["queued", "running", "completed", "steered", "aborted", "stopped", "error"];
const WORKFLOW_STATUSES = ["running", "paused", "completed", "failed", "killed"];

/** Called only after bounded shape validation, including in the shared Zod schema. */
export function activitySnapshotIsCoherent(value) {
  const { agents, workflows, agentCounts, workflowCounts, omitted } = value;
  const coherentCounts = (rows, counts, states, missing) => {
    const total = states.reduce((sum, state) => sum + counts[state], 0);
    return (
      Number.isSafeInteger(total) &&
      total === rows.length + missing &&
      states.every((state) => rows.filter((row) => row.state === state).length <= counts[state])
    );
  };
  if (
    !coherentCounts(agents, agentCounts, AGENT_STATES, omitted.agents) ||
    !coherentCounts(workflows, workflowCounts, WORKFLOW_STATES, omitted.workflows)
  )
    return false;
  if (
    new Set(agents.map((row) => row.id)).size !== agents.length ||
    new Set(workflows.map((row) => row.id)).size !== workflows.length
  )
    return false;
  const byId = new Map(agents.map((row) => [row.id, row]));
  for (const row of agents) {
    if (row.recordId !== null && row.recordId !== row.id) return false;
    if (row.recordId === null && (row.workflowId === null || row.parentAgentId !== null))
      return false;
    if (row.state === "queued" && row.status !== "queued") return false;
    if (["running", "starting"].includes(row.state) && row.status !== "running") return false;
    if (row.state === "finished" && ["queued", "running"].includes(row.status)) return false;
    // Missing ancestors are valid (evicted or omitted), cycles are not.
    const seen = new Set([row.id]);
    let parent = row.parentAgentId;
    while (parent !== null && byId.has(parent)) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent).parentAgentId;
    }
  }
  return workflows.every((row) =>
    row.state === "finished"
      ? !["running", "paused"].includes(row.status)
      : row.state === "stopping"
        ? ["running", "paused"].includes(row.status)
        : row.state === row.status,
  );
}

function object(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every((key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], "value"))
  );
}

function text(value, limit, nonempty = false) {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    (!nonempty || value.trim().length > 0) &&
    !/[\p{C}\u2028\u2029]/u.test(value)
  );
}

function id(value) {
  return text(value, ACTIVITY_ID_LIMIT, true);
}
function nullableId(value) {
  return value === null || id(value);
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Host-side, fail-closed counterpart of shared/pi-protocol/subagent-activity.ts.
 * Cap collections before visiting rows, reject accessors/unknown fields, then
 * return only a fresh, bounded plain-data copy. Never forward extension errors.
 */
export function readActivitySnapshot(value) {
  try {
    if (
      !object(value, [
        "version",
        "observedAt",
        "agents",
        "workflows",
        "agentCounts",
        "workflowCounts",
        "omitted",
        "pendingOperations",
        "unwindingOperations",
        "pendingNotifications",
      ]) ||
      value.version !== 1 ||
      !count(value.observedAt) ||
      !Array.isArray(value.agents) ||
      value.agents.length > ACTIVITY_MAX_AGENTS ||
      !Array.isArray(value.workflows) ||
      value.workflows.length > ACTIVITY_MAX_WORKFLOWS ||
      !object(value.agentCounts, AGENT_STATES) ||
      !AGENT_STATES.every((state) => count(value.agentCounts[state])) ||
      !object(value.workflowCounts, WORKFLOW_STATES) ||
      !WORKFLOW_STATES.every((state) => count(value.workflowCounts[state])) ||
      !object(value.omitted, ["agents", "workflows"]) ||
      !count(value.omitted.agents) ||
      !count(value.omitted.workflows) ||
      typeof value.pendingOperations !== "boolean" ||
      typeof value.unwindingOperations !== "boolean" ||
      typeof value.pendingNotifications !== "boolean"
    )
      return undefined;
    const agents = [];
    const workflows = [];
    for (let index = 0; index < value.agents.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.agents, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      const row = descriptor.value;
      if (
        !object(row, [
          "id",
          "recordId",
          "parentAgentId",
          "workflowId",
          "name",
          "agentType",
          "task",
          "phase",
          "state",
          "status",
          "detailsTruncated",
        ]) ||
        !id(row.id) ||
        !nullableId(row.recordId) ||
        !nullableId(row.parentAgentId) ||
        !nullableId(row.workflowId) ||
        !text(row.name, ACTIVITY_NAME_LIMIT) ||
        !text(row.agentType, ACTIVITY_NAME_LIMIT) ||
        !text(row.task, ACTIVITY_TASK_LIMIT) ||
        !(row.phase === null || text(row.phase, ACTIVITY_PHASE_LIMIT)) ||
        !AGENT_STATES.includes(row.state) ||
        !AGENT_STATUSES.includes(row.status) ||
        typeof row.detailsTruncated !== "boolean"
      )
        return undefined;
      agents.push({ ...row });
    }
    for (let index = 0; index < value.workflows.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.workflows, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      const row = descriptor.value;
      if (
        !object(row, ["id", "name", "task", "state", "status", "detailsTruncated"]) ||
        !id(row.id) ||
        !text(row.name, ACTIVITY_NAME_LIMIT) ||
        !text(row.task, ACTIVITY_TASK_LIMIT) ||
        !WORKFLOW_STATES.includes(row.state) ||
        !WORKFLOW_STATUSES.includes(row.status) ||
        typeof row.detailsTruncated !== "boolean"
      )
        return undefined;
      workflows.push({ ...row });
    }
    const snapshot = {
      version: 1,
      observedAt: value.observedAt,
      agents,
      workflows,
      agentCounts: { ...value.agentCounts },
      workflowCounts: { ...value.workflowCounts },
      omitted: { ...value.omitted },
      pendingOperations: value.pendingOperations,
      unwindingOperations: value.unwindingOperations,
      pendingNotifications: value.pendingNotifications,
    };
    if (!activitySnapshotIsCoherent(snapshot)) return undefined;
    // Serialize only the bounded copy, never extension arrays with custom toJSON.
    const serialized = JSON.stringify(snapshot);
    if (new TextEncoder().encode(serialized).byteLength > ACTIVITY_MAX_BYTES) return undefined;
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}
