import type { SessionGroup } from "@shared/settings.js";
import { describe, expect, it } from "vitest";
import { moveSessionToGroup, partitionSessionGroups } from "./session-groups.js";

const groups: SessionGroup[] = [
  {
    id: "a",
    workspacePath: "/repo",
    name: "Work",
    sessionFiles: ["one", "gone"],
    collapsed: false,
  },
  { id: "b", workspacePath: "/repo", name: "Research", sessionFiles: ["two"], collapsed: true },
  { id: "other", workspacePath: "/other", name: "Other", sessionFiles: ["one"], collapsed: false },
];

describe("sidebar session groups", () => {
  it("preserves input pin/activity order within each group and keeps stale keys out of rows", () => {
    const entries = ["three", "two", "one"].map((filePath) => ({ filePath }));
    const sections = partitionSessionGroups(entries, groups, "/repo");
    expect(
      sections.map(({ group, entries }) => [group?.id, entries.map((entry) => entry.filePath)]),
    ).toEqual([
      ["a", ["one"]],
      ["b", ["two"]],
      [undefined, ["three"]],
    ]);
    expect(sections[0]?.entries[0]).toBe(entries[2]);
    expect(entries.map((entry) => entry.filePath)).toEqual(["three", "two", "one"]);
  });

  it("keeps empty groups and pathless pending sessions without duplicating hand-edited membership", () => {
    const duplicate = { ...groups[1]!, sessionFiles: ["one"] };
    const sections = partitionSessionGroups(
      [{ filePath: "one" }, { filePath: undefined }],
      [groups[0]!, duplicate],
      "/repo",
    );
    expect(sections.map((section) => section.entries)).toEqual([
      [{ filePath: "one" }],
      [],
      [{ filePath: undefined }],
    ]);
    expect(partitionSessionGroups([], [], "/repo")).toEqual([{ group: null, entries: [] }]);
  });

  it("moves a file once, expands the destination, and never mutates the source or another workspace", () => {
    const before = structuredClone(groups);
    const next = moveSessionToGroup(groups, "/repo", "one", "b");
    expect(next[0]?.sessionFiles).toEqual(["gone"]);
    expect(next[1]).toEqual({ ...groups[1], sessionFiles: ["two", "one"], collapsed: false });
    expect(next[2]).toBe(groups[2]);
    expect(groups).toEqual(before);
    expect(moveSessionToGroup(next, "/repo", "one", "b")[1]?.sessionFiles).toEqual(["two", "one"]);
  });

  it("ungroups a file without deleting it or changing another workspace", () => {
    const next = moveSessionToGroup(groups, "/repo", "one", null);
    expect(next[0]?.sessionFiles).toEqual(["gone"]);
    expect(next[2]?.sessionFiles).toEqual(["one"]);
    const sections = partitionSessionGroups([{ filePath: "one" }], next, "/repo");
    expect(sections.at(-1)).toEqual({ group: null, entries: [{ filePath: "one" }] });
  });

  it("refuses a missing or cross-workspace destination instead of silently ungrouping", () => {
    expect(moveSessionToGroup(groups, "/repo", "one", "missing")).toBe(groups);
    expect(moveSessionToGroup(groups, "/repo", "one", "other")).toBe(groups);
  });
});
