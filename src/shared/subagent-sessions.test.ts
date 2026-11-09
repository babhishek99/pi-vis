import { describe, expect, it } from "vitest";
import { SessionHeaderSchema } from "./session-file/entries.js";
import { isSubagentSession } from "./subagent-sessions.js";

const parentSession = "/sessions/parent.jsonl";

describe("isSubagentSession", () => {
  it.each([
    "Worker#0123abcd",
    "Worker name#ABCDEF12",
    "Worker # with hashes#00ff12ab",
    "Résumé helper#00000000",
  ])("recognizes generated child name %j only with parent metadata", (name) => {
    expect(isSubagentSession({ parentSession }, name)).toBe(true);
    expect(isSubagentSession({}, name)).toBe(false);
  });

  it.each([undefined, "", " \t"])("does not infer a child from parent %j", (parentSession) => {
    expect(isSubagentSession({ parentSession }, "Worker#0123abcd")).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    "Regular fork",
    "Regular clone",
    "Promoted child",
    "#0123abcd",
    "Worker#0123abc",
    "Worker#0123abcde",
    "Worker#0123abcg",
    "Worker#0123abcd extra",
    "Worker#0123abcd ",
    "Worker\nname#0123abcd",
    "Worker\rname#0123abcd",
    "Worker\u2028name#0123abcd",
    "Worker\u2029name#0123abcd",
    "Worker#0123abcd\n",
    "Worker#0123abcd\r\n",
    "Worker#0123abcd\u2028",
    "Worker#0123abcd\u2029",
  ])("does not classify non-generated or multiline name %j", (name) => {
    expect(isSubagentSession({ parentSession }, name)).toBe(false);
  });
});

describe("optional session-header lineage", () => {
  const header = {
    type: "session",
    version: 3,
    id: "saved-session",
    timestamp: "2024-01-01T00:00:00Z",
    cwd: "/workspace",
  };

  it("preserves a valid parent and leaves legacy headers unchanged", () => {
    expect(SessionHeaderSchema.parse({ ...header, parentSession })).toEqual({
      ...header,
      parentSession,
    });
    expect(SessionHeaderSchema.parse(header)).toEqual(header);
  });

  it.each(
    [null, 42, false, [], { path: parentSession }].map((parentSession) => ({ parentSession })),
  )(
    "ignores malformed optional parent $parentSession without rejecting a saved session",
    ({ parentSession }) => {
      const parsed = SessionHeaderSchema.parse({ ...header, parentSession });
      expect(parsed.parentSession).toBeUndefined();
      expect(isSubagentSession(parsed, "Worker#0123abcd")).toBe(false);
    },
  );
});
