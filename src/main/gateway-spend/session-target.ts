import type { SessionRecord } from "../sessions/session-registry.js";

type SpendRecord = Pick<SessionRecord, "sessionFile" | "_closing" | "_dead">;

/** Capture main's known file, not a renderer path. Closure fences apply before
 * registry deletion too; a valid cold record needs no live host to be read. */
export function captureSessionSpendTarget(getSession: () => SpendRecord | undefined): {
  file: string | undefined;
  isCurrent(): boolean;
} {
  const record = getSession();
  const file = record?.sessionFile;
  return {
    file,
    isCurrent: () =>
      Boolean(
        record &&
          !record._closing &&
          !record._dead &&
          getSession() === record &&
          record.sessionFile === file,
      ),
  };
}
