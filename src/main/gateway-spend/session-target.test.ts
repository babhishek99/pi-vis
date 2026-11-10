import { describe, expect, it } from "vitest";
import { captureSessionSpendTarget } from "./session-target.js";

describe("gateway session read target", () => {
  it("permits a known cold file without a live host", () => {
    const record = { sessionFile: "/fixture/session.jsonl" };
    const target = captureSessionSpendTarget(() => record);
    expect(target.file).toBe(record.sessionFile);
    expect(target.isCurrent()).toBe(true);
  });

  it.each(["_closing", "_dead"] as const)(
    "fences %s immediately, even while the record remains registered",
    (flag) => {
      const record = { sessionFile: "/fixture/session.jsonl", [flag]: false };
      const target = captureSessionSpendTarget(() => record);
      record[flag] = true;
      expect(target.isCurrent()).toBe(false);
      expect(captureSessionSpendTarget(() => record).isCurrent()).toBe(false);
    },
  );

  it("fences file changes, replacement records, and unknown IDs", () => {
    let record: { sessionFile: string } | undefined = { sessionFile: "/fixture/a.jsonl" };
    const target = captureSessionSpendTarget(() => record);
    record.sessionFile = "/fixture/b.jsonl";
    expect(target.isCurrent()).toBe(false);
    record = { sessionFile: "/fixture/a.jsonl" };
    expect(target.isCurrent()).toBe(false);
    record = undefined;
    expect(target.isCurrent()).toBe(false);
    const missing = captureSessionSpendTarget(() => record);
    record = { sessionFile: "/fixture/a.jsonl" };
    expect(missing.file).toBeUndefined();
    expect(missing.isCurrent()).toBe(false);
  });
});
