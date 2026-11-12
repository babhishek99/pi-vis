import type { SessionHeader } from "./session-file/entries.js";

/**
 * Persisted sidebar presentation only, never runtime identity or liveness.
 * pi-subagents pairs a parent file with a generated `name#<8 hex>` name; Pi's
 * ordinary forks/clones also have parents, so lineage alone is not evidence.
 * Renaming a child without the generated suffix intentionally removes the hint.
 */
export function isSubagentSession(
  header: Pick<SessionHeader, "parentSession">,
  name: string | null | undefined,
): boolean {
  return (
    typeof header.parentSession === "string" &&
    header.parentSession.trim().length > 0 &&
    typeof name === "string" &&
    // `$` alone also accepts a trailing line break; require an exact single line.
    !/[\r\n\u2028\u2029]/.test(name) &&
    /^.+#[0-9a-f]{8}$/i.test(name)
  );
}
