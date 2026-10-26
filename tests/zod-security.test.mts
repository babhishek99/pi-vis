import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MARKDOWN_TRANSFORM_MAX_ITEMS,
  MarkdownTransformBatchSchema,
} from "../src/shared/pi-protocol/markdown-transform.js";

// Exercise the application's real v4 schema, rather than trusting package
// metadata or a v3 compatibility export that retains the vulnerable parser.
describe("patched Zod collection validation", () => {
  it("rejects an oversized batch before reading any malformed element", () => {
    let inspected = 0;
    const hostile = {
      get requestId() {
        inspected += 1;
        throw new Error("element must not be read");
      },
    };
    const result = MarkdownTransformBatchSchema.safeParse(
      Array(MARKDOWN_TRANSFORM_MAX_ITEMS + 100000).fill(hostile),
    );
    expect(result.success).toBe(false);
    expect(inspected).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  it("uses the real v4 parser and preserves unknown-field omission only when optional", () => {
    expect(z.object({ value: z.unknown() }).safeParse({}).success).toBe(false);
    expect(z.object({ value: z.unknown().optional() }).parse({})).toEqual({});
  });
});
