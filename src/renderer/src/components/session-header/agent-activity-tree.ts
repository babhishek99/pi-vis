import type {
  ActivityAgent,
  ActivitySnapshot,
  ActivityWorkflow,
} from "@shared/pi-protocol/subagent-activity.js";

export type ActivityNode = (
  | { kind: "agent"; row: ActivityAgent }
  | { kind: "workflow"; row: ActivityWorkflow }
) & {
  key: string;
  children: ActivityNode[];
  missingOwner: string | null;
};

/** Display only the supplied relationships; omitted/evicted ancestors stay explicit. */
export function agentActivityTree(snapshot: ActivitySnapshot): ActivityNode[] {
  const agents = new Map<string, ActivityNode>(
    snapshot.agents.map((row) => [
      row.id,
      { kind: "agent", row, key: `agent:${row.id}`, children: [], missingOwner: null },
    ]),
  );
  const workflows = new Map<string, ActivityNode>(
    snapshot.workflows.map((row) => [
      row.id,
      { kind: "workflow", row, key: `workflow:${row.id}`, children: [], missingOwner: null },
    ]),
  );
  const roots: ActivityNode[] = [...workflows.values()];
  for (const row of snapshot.agents) {
    const node = agents.get(row.id)!;
    const parent = row.parentAgentId ? agents.get(row.parentAgentId) : undefined;
    const workflow = row.workflowId ? workflows.get(row.workflowId) : undefined;
    node.missingOwner =
      [
        row.parentAgentId && !parent ? "Parent not in snapshot" : "",
        row.workflowId && !workflow ? "Workflow not in snapshot" : "",
      ]
        .filter(Boolean)
        .join(" · ") || null;
    if (parent) parent.children.push(node);
    else if (workflow) workflow.children.push(node);
    else roots.push(node);
  }
  const order = (nodes: ActivityNode[]): void => {
    nodes.sort((a, b) => Number(a.row.state === "finished") - Number(b.row.state === "finished"));
    for (const node of nodes) order(node.children);
  };
  order(roots);
  return roots;
}
