import { describe, expect, it } from "vitest";
import { TOOL_RESULT_TEXT_SEPARATOR, extractToolResult } from "./tool-result.js";

describe("extractToolResult", () => {
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 2,
    totalTokens: 127,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
  };

  it("retains only finite nonnegative recorded execution durations", () => {
    expect(extractToolResult({ content: [], durationMs: 12.5 }).durationMs).toBe(12.5);
    expect(extractToolResult({ content: [], durationMs: 0 }).durationMs).toBe(0);
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12", null]) {
      expect(extractToolResult({ content: [], durationMs }).durationMs).toBeUndefined();
    }
  });

  it("keeps live and persisted content snapshots at the same helper boundary", () => {
    const result = {
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
      details: { exitCode: 0 },
    };

    const liveEndResult = extractToolResult(result);
    const persistedToolResultMessage = extractToolResult({ ...result, role: "toolResult" });

    expect(TOOL_RESULT_TEXT_SEPARATOR).toBe("\n");
    expect(liveEndResult).toEqual({
      text: "first line\nsecond line",
      images: undefined,
      content: result.content,
      hasContent: true,
      details: { exitCode: 0 },
      hasDetails: true,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
    });
    expect(persistedToolResultMessage).toEqual(liveEndResult);
  });

  it("accepts string results and falls back to output without text parts", () => {
    expect(extractToolResult("plain output")).toEqual({
      text: "plain output",
      images: undefined,
      content: "plain output",
      hasContent: true,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
    });
    expect(extractToolResult({ content: [{ type: "image" }], output: "fallback output" })).toEqual({
      text: "fallback output",
      images: undefined,
      content: [{ type: "image" }],
      hasContent: true,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: { output: "fallback output" },
    });
  });

  it("preserves Pi edit details as dedicated display diff and unified patch fields", () => {
    const details = {
      diff: " 1 line changed\n-old\n+new",
      patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      fullOutputPath: "/tmp/result",
    };
    expect(extractToolResult({ content: [], details, diff: "ignored direct diff" })).toEqual({
      text: "",
      images: undefined,
      content: [],
      hasContent: true,
      details,
      hasDetails: true,
      diff: " 1 line changed\n-old\n+new",
      patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      metadata: undefined,
    });
    expect(
      extractToolResult({ output: "done", diff: "direct diff", patch: "direct patch" }),
    ).toEqual({
      text: "done",
      images: undefined,
      content: undefined,
      hasContent: false,
      details: undefined,
      hasDetails: false,
      diff: "direct diff",
      patch: "direct patch",
      metadata: { output: "done" },
    });
  });

  it("preserves every recognized image plus arbitrary details and result metadata", () => {
    const content = [
      { type: "text", text: "caption", textSignature: "signed-caption" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", source: "tool" },
      { type: "text", text: "after image", extensionField: { retained: true } },
      { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
    ];
    expect(
      extractToolResult({
        content,
        output: "distinct legacy output",
        details: null,
        addedToolNames: ["deferred_search"],
        terminate: true,
        futureField: { retained: true },
      }),
    ).toEqual({
      text: "caption\nafter image",
      images: ["data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64,d29ybGQ="],
      content,
      hasContent: true,
      details: null,
      hasDetails: true,
      diff: undefined,
      patch: undefined,
      metadata: {
        output: "distinct legacy output",
        addedToolNames: ["deferred_search"],
        terminate: true,
        futureField: { retained: true },
      },
    });
  });

  it("safely ignores malformed results and content while retaining non-object details", () => {
    expect(extractToolResult(null)).toEqual({
      text: "",
      images: undefined,
      content: undefined,
      hasContent: false,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
    });
    expect(extractToolResult([])).toEqual({
      text: "",
      images: undefined,
      content: undefined,
      hasContent: false,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
    });
    expect(
      extractToolResult({
        content: [null, { type: "text", text: 1 }, { type: "text", text: "valid" }],
        details: ["not details"],
        diff: 1,
      }),
    ).toEqual({
      text: "valid",
      images: undefined,
      content: [null, { type: "text", text: 1 }, { type: "text", text: "valid" }],
      hasContent: true,
      details: ["not details"],
      hasDetails: true,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
    });
  });

  it("keeps Pi 0.81 tool usage out of generic metadata", () => {
    expect(extractToolResult({ content: [{ type: "text", text: "done" }], usage })).toMatchObject({
      text: "done",
      usage,
      metadata: undefined,
    });
  });
});
