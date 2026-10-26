import { type PiUsage, PiUsageSchema } from "./usage.js";

/**
 * Separator used when adjacent `content: [{ type: "text" }]` parts form one
 * tool result. This matches the live transcript reducer's display behavior.
 */
export const TOOL_RESULT_TEXT_SEPARATOR = "\n";

export interface ExtractedTextAndImages {
  text: string;
  images: string[] | undefined;
  /** Distinguishes an empty text part from an absent text part. */
  hasTextParts: boolean;
}

export interface ToolResultData {
  text: string;
  images: string[] | undefined;
  /**
   * Pi's complete ordered public content value. This stays separate from the
   * convenience text/image projections so interleaving and extension-owned
   * part fields (for example `textSignature`) remain inspectable.
   */
  content: unknown;
  /** Distinguishes an explicit null/undefined content value from no content field. */
  hasContent: boolean;
  /** Pi explicitly permits arbitrary, including scalar and null, details. */
  details: unknown;
  /** Distinguishes an explicit `details: null` from no details field. */
  hasDetails: boolean;
  /** EditToolDetails.diff: Pi's display-oriented human diff. */
  diff: string | undefined;
  /** EditToolDetails.patch: the standard unified patch. */
  patch: string | undefined;
  /** Non-payload result fields, including addedToolNames/terminate and future fields. */
  metadata: Record<string, unknown> | undefined;
  /** Usage attributed to the tool execution itself, when reported by Pi 0.81+. */
  usage: PiUsage | undefined;
  /** Pi-recorded monotonic execution time; absent for tools that never ran. */
  durationMs: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract Pi's public text/image content without imposing display limits.
 * Image payloads become data URLs, matching user-message attachment storage.
 * Part order is retained within each media kind; text boundaries use the
 * caller-provided separator.
 */
export function extractTextAndImages(
  value: unknown,
  separator = TOOL_RESULT_TEXT_SEPARATOR,
): ExtractedTextAndImages {
  if (typeof value === "string") {
    return { text: value, images: undefined, hasTextParts: true };
  }
  if (!Array.isArray(value)) {
    return { text: "", images: undefined, hasTextParts: false };
  }

  const textParts: string[] = [];
  const images: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      images.push(`data:${part.mimeType};base64,${part.data}`);
    }
  }

  return {
    text: textParts.join(separator),
    images: images.length > 0 ? images : undefined,
    hasTextParts: textParts.length > 0,
  };
}

function extractResultMetadata(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    // These fields have dedicated lossless projections. Keep `output` in
    // metadata even when it supplies the text fallback: some legacy results
    // carry both content text and a distinct direct output value.
    if (
      key === "content" ||
      key === "details" ||
      key === "diff" ||
      key === "patch" ||
      key === "role" ||
      key === "toolCallId" ||
      key === "toolName" ||
      key === "isError" ||
      key === "usage"
    ) {
      continue;
    }
    metadata[key] = field;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Extract the renderer-facing fields from a live tool result or its persisted
 * message snapshot. Text parts retain their order and are separated by a
 * newline; `output` is used only when no usable text part exists.
 *
 * `details` is intentionally unknown: Pi's public contract permits arbitrary
 * extension-owned data. All remaining top-level fields are retained as
 * metadata so newer public fields do not disappear in Pi-Vis.
 */
export function extractToolResult(value: unknown): ToolResultData {
  if (typeof value === "string") {
    return {
      text: value,
      images: undefined,
      content: value,
      hasContent: true,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
      usage: undefined,
      durationMs: undefined,
    };
  }
  if (!isRecord(value)) {
    return {
      text: "",
      images: undefined,
      content: undefined,
      hasContent: false,
      details: undefined,
      hasDetails: false,
      diff: undefined,
      patch: undefined,
      metadata: undefined,
      usage: undefined,
      durationMs: undefined,
    };
  }

  const hasContent = Object.hasOwn(value, "content");
  const rawContent = hasContent ? value.content : undefined;
  const hasDetails = Object.hasOwn(value, "details");
  const details = hasDetails ? value.details : undefined;
  const diff =
    isRecord(details) && typeof details.diff === "string"
      ? details.diff
      : typeof value.diff === "string"
        ? value.diff
        : undefined;
  const patch =
    isRecord(details) && typeof details.patch === "string"
      ? details.patch
      : typeof value.patch === "string"
        ? value.patch
        : undefined;
  const content = extractTextAndImages(rawContent);
  const parsedUsage = PiUsageSchema.safeParse(value.usage);

  return {
    text: content.hasTextParts
      ? content.text
      : typeof value.output === "string"
        ? value.output
        : "",
    images: content.images,
    content: rawContent,
    hasContent,
    details,
    hasDetails,
    diff,
    patch,
    metadata: extractResultMetadata(value),
    usage: parsedUsage.success ? parsedUsage.data : undefined,
    durationMs:
      typeof value.durationMs === "number" &&
      Number.isFinite(value.durationMs) &&
      value.durationMs >= 0
        ? value.durationMs
        : undefined,
  };
}
