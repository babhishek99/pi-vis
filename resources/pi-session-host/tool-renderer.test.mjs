import { describe, expect, it, vi } from "vitest";
import { TOOL_RENDER_MAX_BYTES, createToolRenderer } from "./tool-renderer.mjs";

function setup(options = {}) {
  const call = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    namespace: "files",
    arguments: { path: "canonical.txt" },
  };
  const result = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "canonical result" }],
    details: { value: 7 },
    isError: false,
    durationMs: 42,
  };
  const definition = {};
  const session = {
    messages: [{ role: "assistant", content: [call] }, result],
    extensionRunner: { resolveToolRenderers: vi.fn((_name, next) => next()) },
    getToolDefinition: vi.fn(() => definition),
    sessionManager: { getCwd: () => "/project", getBranch: () => [] },
    settingsManager: { getOutputPad: () => 2 },
  };
  const theme = { fg: (_color, text) => text };
  const renderer = createToolRenderer({
    getSession: () => session,
    getTheme: () => theme,
    ...options,
  });
  return {
    renderer,
    session,
    definition,
    call,
    result,
    theme,
    query: { toolCallId: "call-1", cols: 80, expanded: true },
  };
}

describe("public tool renderer composition", () => {
  it("uses public resolution and shared retained context without mutating canonical history", () => {
    const h = setup();
    const callComponent = { render: () => ["custom call"], dispose: vi.fn() };
    const resultComponent = { render: () => ["custom result"], dispose: vi.fn() };
    const contexts = [];
    h.definition.renderCall = (args, _theme, context) => {
      contexts.push(context);
      expect(args.path).toBe("canonical.txt");
      context.state.calls = (context.state.calls ?? 0) + 1;
      args.path = "renderer mutation";
      return context.lastComponent ?? callComponent;
    };
    h.definition.renderResult = (result, options, _theme, context) => {
      expect(context.state.calls).toBeGreaterThan(0);
      expect(options).toEqual({ expanded: true, isPartial: false });
      result.content[0].text = "renderer mutation";
      contexts.push(context);
      return context.lastComponent ?? resultComponent;
    };
    expect(h.renderer.render(h.query)).toEqual({
      rendered: true,
      ansi: "custom call\ncustom result",
    });
    expect(h.renderer.render(h.query).rendered).toBe(true);
    expect(h.session.extensionRunner.resolveToolRenderers).toHaveBeenCalledWith(
      "read",
      expect.any(Function),
    );
    expect(contexts[0]).toMatchObject({
      toolCallId: "call-1",
      cwd: "/project",
      argsComplete: true,
      executionStarted: false,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
      durationMs: 42,
      outputPad: 2,
    });
    expect(contexts[2].lastComponent).toBe(callComponent);
    expect(contexts[3].lastComponent).toBe(resultComponent);
    expect(h.call.arguments.path).toBe("canonical.txt");
    expect(h.result.content[0].text).toBe("canonical result");
    h.renderer.dispose();
    expect(callComponent.dispose).toHaveBeenCalledOnce();
    expect(resultComponent.dispose).toHaveBeenCalledOnce();
  });

  it("lets resolvers wrap built-ins and uses public branch history outside compacted context", () => {
    const h = setup();
    const messages = h.session.messages;
    h.session.messages = [];
    h.session.sessionManager.getBranch = () =>
      messages.map((message) => ({ type: "message", message }));
    h.session.extensionRunner.resolveToolRenderers.mockImplementation((_name, next) => {
      expect(next()).toBe(h.definition);
      return {
        renderResult: (_value, _options, _theme, context) => ({
          render: () => [context.cwd, "resolved builtin"],
        }),
      };
    });
    expect(h.renderer.render(h.query)).toEqual({
      rendered: true,
      ansi: "/project\nresolved builtin",
    });
  });

  it("projects live partial nested executions only while their canonical parent exists", () => {
    const h = setup();
    h.session.messages.pop();
    const contexts = [];
    h.definition.renderResult = (_result, _options, _theme, context) => {
      contexts.push(context);
      return { render: () => [context.isPartial ? "partial" : "done"] };
    };
    h.renderer.observe({
      type: "tool_execution_start",
      toolCallId: "nested",
      parentToolCallId: "call-1",
      toolName: "read",
      args: { path: "nested.txt" },
    });
    h.renderer.observe({
      type: "tool_execution_update",
      toolCallId: "nested",
      parentToolCallId: "call-1",
      toolName: "read",
      partialResult: { content: [{ type: "text", text: "part" }], details: {} },
    });
    expect(h.renderer.render({ ...h.query, toolCallId: "nested" })).toEqual({
      rendered: true,
      ansi: "partial",
    });
    expect(contexts[0]).toMatchObject({
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      durationMs: undefined,
    });
    h.renderer.observe({
      type: "tool_execution_end",
      toolCallId: "nested",
      toolName: "read",
      result: { content: [], details: {} },
      durationMs: 9,
      isError: true,
    });
    expect(h.renderer.render({ ...h.query, toolCallId: "nested" }).ansi).toBe("done");
    expect(contexts[1]).toMatchObject({ isPartial: false, isError: true, durationMs: 9 });
    h.session.messages = [];
    expect(h.renderer.render({ ...h.query, toolCallId: "nested" })).toEqual({ rendered: false });
  });

  it("rejects ambiguous or unknown ids before invoking extensions", () => {
    const h = setup();
    h.definition.renderCall = vi.fn(() => ({ render: () => ["bad"] }));
    h.session.messages[0].content.push({ ...h.call });
    expect(h.renderer.render(h.query)).toEqual({ rendered: false });
    expect(h.renderer.render({ ...h.query, toolCallId: "unknown" })).toEqual({ rendered: false });
    expect(h.definition.renderCall).not.toHaveBeenCalled();
  });

  it("retains bounded historical nested-call metadata without inventing execution start", () => {
    const h = setup();
    h.result.nestedCalls = {
      calls: [
        {
          id: "nested-history",
          name: "read",
          arguments: { path: "nested.txt" },
          status: "error",
          durationMs: 11,
        },
      ],
      complete: true,
    };
    let observed;
    h.definition.renderCall = (_args, _theme, context) => {
      observed = context;
      return { render: () => ["nested history"] };
    };
    expect(h.renderer.render({ ...h.query, toolCallId: "nested-history" })).toEqual({
      rendered: true,
      ansi: "nested history",
    });
    expect(observed).toMatchObject({
      executionStarted: false,
      isPartial: false,
      isError: true,
      durationMs: 11,
      argsComplete: true,
    });
  });

  it("disposes components on runner replacement, LRU eviction, and explicit reload reset", () => {
    const h = setup({ maxEntries: 1 });
    const dispose = vi.fn();
    h.definition.renderCall = () => ({ render: () => ["call"], dispose });
    h.renderer.render(h.query);
    h.session.messages[0].content.push({ ...h.call, id: "call-2" });
    h.renderer.render({ ...h.query, toolCallId: "call-2" });
    expect(dispose).toHaveBeenCalledTimes(1);
    h.session.extensionRunner = { resolveToolRenderers: (_name, next) => next() };
    h.renderer.render(h.query);
    expect(dispose).toHaveBeenCalledTimes(2);
    h.renderer.reset();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("contains extension failures and bounds multibyte ANSI by UTF-8 bytes", () => {
    const h = setup();
    const dispose = vi.fn();
    h.definition.renderCall = () => ({
      render: () => ["é".repeat(TOOL_RENDER_MAX_BYTES / 2 + 1)],
      dispose,
    });
    expect(h.renderer.render(h.query)).toEqual({ rendered: false, error: true });
    expect(dispose).toHaveBeenCalledOnce();
    h.definition.renderCall = () => {
      throw new Error("private extension failure");
    };
    expect(h.renderer.render(h.query)).toEqual({ rendered: false, error: true });
  });
});
