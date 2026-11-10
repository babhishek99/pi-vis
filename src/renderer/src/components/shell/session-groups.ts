import type { SessionGroup } from "@shared/settings.js";

export interface SessionGroupSection<T> {
  group: SessionGroup | null;
  entries: T[];
}

/** Partition an already ordered list without changing activity or pin order. */
export function partitionSessionGroups<T extends { filePath: string | undefined }>(
  entries: T[],
  groups: SessionGroup[],
  workspacePath: string,
): SessionGroupSection<T>[] {
  const sections: SessionGroupSection<T>[] = groups
    .filter((group) => group.workspacePath === workspacePath)
    .map((group) => ({ group, entries: [] }));
  const byFile = new Map<string, SessionGroupSection<T>>();
  for (const section of sections) {
    for (const file of section.group!.sessionFiles) {
      // A hand-edited duplicate membership never duplicates a session row.
      if (!byFile.has(file)) byFile.set(file, section);
    }
  }
  const ungrouped: SessionGroupSection<T> = { group: null, entries: [] };
  for (const entry of entries) {
    const section = entry.filePath ? byFile.get(entry.filePath) : undefined;
    (section ?? ungrouped).entries.push(entry);
  }
  // Keep Ungrouped as a drop destination even when all sessions are grouped.
  sections.push(ungrouped);
  return sections;
}

/** A move is settings-only; session JSONL, pins, and runtime ownership are untouched. */
export function moveSessionToGroup(
  groups: SessionGroup[],
  workspacePath: string,
  filePath: string,
  groupId: string | null,
): SessionGroup[] {
  if (
    groupId !== null &&
    !groups.some((group) => group.id === groupId && group.workspacePath === workspacePath)
  ) {
    return groups;
  }
  return groups.map((group) => {
    if (group.workspacePath !== workspacePath) return group;
    const sessionFiles = group.sessionFiles.filter((file) => file !== filePath);
    return group.id === groupId
      ? { ...group, sessionFiles: [...sessionFiles, filePath], collapsed: false }
      : { ...group, sessionFiles };
  });
}
