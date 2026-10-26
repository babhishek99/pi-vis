import { describe, expect, it } from "vitest";
import { PI_COMMAND_POLICY, type PiRpcCommand, PiRpcCommandSchema } from "./commands.js";

const COMMAND_TYPES = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "bash",
  "abort_bash",
  "set_model",
  "cycle_model",
  "get_available_models",
  "get_login_providers",
  "get_scoped_models",
  "set_scoped_models",
  "save_scoped_models",
  "get_logout_providers",
  "logout_provider",
  "set_thinking_level",
  "cycle_thinking_level",
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "set_session_name",
  "get_commands",
  "get_state",
  "get_session_stats",
  "get_messages",
  "get_fork_messages",
  "get_last_assistant_text",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "set_steering_mode",
  "set_follow_up_mode",
  "export_html",
  "get_trust_state",
  "set_trust",
  "get_tree",
  "navigate_tree",
  "set_label",
  "render_entry",
  "render_message",
  "render_tool",
  "transform_markdown",
  "get_cache_miss_notices",
] as const satisfies readonly PiRpcCommand["type"][];

describe("Pi command admission policy", () => {
  it("classifies every schema discriminant exactly once", () => {
    expect(Object.keys(PI_COMMAND_POLICY).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const type of COMMAND_TYPES) {
      expect(["read_only", "idempotent", "effectful", "replacement"]).toContain(
        PI_COMMAND_POLICY[type].class,
      );
    }
  });

  it("keeps text commands submission-only", () => {
    for (const type of ["prompt", "steer", "follow_up"] as const) {
      expect(PI_COMMAND_POLICY[type]).toMatchObject({
        class: "effectful",
        submissionOnly: true,
      });
    }
  });

  it("accepts only bounded tool-render selectors", () => {
    expect(
      PiRpcCommandSchema.safeParse({ type: "render_tool", toolCallId: "call-a", cols: 80 }).success,
    ).toBe(true);
    for (const invalid of [
      { type: "render_tool", toolCallId: "", cols: 80 },
      { type: "render_tool", toolCallId: "call-a", cols: 19 },
      { type: "render_tool", toolCallId: "call-a", cols: 241 },
      { type: "render_tool", toolCallId: "call-a" },
    ]) {
      expect(PiRpcCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates the public-message renderer selectors and dimensions", () => {
    expect(
      PiRpcCommandSchema.safeParse({
        type: "render_message",
        customType: "status-card",
        timestamp: 1_700_000_000_000,
        cols: 96,
        expanded: true,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { type: "render_message", customType: "", timestamp: 1, cols: 80 },
      { type: "render_message", customType: "status-card", cols: 80 },
      {
        type: "render_message",
        customType: "status-card",
        timestamp: Number.POSITIVE_INFINITY,
        cols: 80,
      },
      { type: "render_message", customType: "status-card", timestamp: 1, cols: 19 },
      { type: "render_message", customType: "status-card", timestamp: 1, cols: 241 },
    ]) {
      expect(PiRpcCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates bounded Pi 0.84 Markdown transformation batches", () => {
    expect(
      PiRpcCommandSchema.safeParse({
        type: "transform_markdown",
        items: [
          {
            requestId: "markdown-a",
            markdown: "**before**",
            messageType: "assistant",
            isStreaming: true,
            availableWidth: 96,
          },
        ],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { type: "transform_markdown", items: [] },
      {
        type: "transform_markdown",
        items: [
          {
            requestId: "",
            markdown: "text",
            messageType: "assistant",
            isStreaming: false,
            availableWidth: 80,
          },
        ],
      },
      {
        type: "transform_markdown",
        items: [
          {
            requestId: "markdown-a",
            markdown: "text",
            messageType: "tool",
            isStreaming: false,
            availableWidth: 80,
          },
        ],
      },
    ]) {
      expect(PiRpcCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
