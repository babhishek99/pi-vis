export const TOOL_RENDER_MAX_BYTES = 256 * 1024;
const MAX_LIVE_RESULT_BYTES = 1024 * 1024;

function disposeComponents(slot) {
  slot.active = false;
  for (const component of new Set([slot.callComponent, slot.resultComponent])) {
    try {
      component?.dispose?.();
    } catch {
      // Extension teardown cannot prevent owner retirement.
    }
  }
}

function lookupMessages(messages, toolCallId) {
  let call;
  let result;
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || part.id !== toolCallId) continue;
        if (call) return { ambiguous: true };
        call = part;
      }
    }
    if (message?.role !== "toolResult") continue;
    if (message.toolCallId === toolCallId) {
      if (result) return { ambiguous: true };
      result = message;
    }
    for (const nested of message.nestedCalls?.calls ?? []) {
      if (nested?.id !== toolCallId) continue;
      if (call) return { ambiguous: true };
      call = { ...nested, type: "toolCall" };
    }
  }
  return { call, result };
}

/** Public Pi tool renderer composition, retained by exact session/runner owner. */
export function createToolRenderer({ getSession, getTheme, maxEntries = 64 }) {
  let session;
  let runner;
  const slots = new Map();
  const live = new Map();

  function reset() {
    for (const slot of slots.values()) disposeComponents(slot);
    slots.clear();
    live.clear();
    session = undefined;
    runner = undefined;
  }

  function owner() {
    const current = getSession();
    if (current !== session || current?.extensionRunner !== runner) {
      reset();
      session = current;
      runner = current?.extensionRunner;
    }
    return current;
  }

  function trim(map, dispose) {
    while (map.size > maxEntries) {
      const key = map.keys().next().value;
      const value = map.get(key);
      map.delete(key);
      dispose?.(value);
    }
  }

  function observe(event) {
    owner();
    if (
      !["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(
        event?.type,
      ) ||
      typeof event.toolCallId !== "string"
    ) {
      return;
    }
    const previous = live.get(event.toolCallId) ?? {};
    const next = {
      ...previous,
      name: event.toolName ?? previous.name,
      ...(event.args !== undefined ? { args: structuredClone(event.args) } : {}),
      ...(typeof event.parentToolCallId === "string"
        ? { parentToolCallId: event.parentToolCallId }
        : {}),
      executionStarted: previous.executionStarted || event.type === "tool_execution_start",
    };
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    if (result !== undefined) {
      try {
        if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_LIVE_RESULT_BYTES) {
          next.result = structuredClone(result);
        } else delete next.result;
      } catch {
        delete next.result;
      }
    }
    if (event.type === "tool_execution_end") {
      next.ended = true;
      next.isError = event.isError === true;
      next.durationMs = event.durationMs;
    }
    live.delete(event.toolCallId);
    live.set(event.toolCallId, next);
    trim(live);
  }

  function render({ toolCallId, cols, expanded }) {
    const current = owner();
    if (typeof runner?.resolveToolRenderers !== "function") return { rendered: false };
    let slot;
    try {
      let canonical = lookupMessages(current.messages ?? [], toolCallId);
      if (canonical.ambiguous) return { rendered: false };
      if (!canonical.call) {
        const branchMessages = (current.sessionManager?.getBranch?.() ?? [])
          .filter((entry) => entry?.type === "message")
          .map((entry) => entry.message);
        canonical = lookupMessages(branchMessages, toolCallId);
      }
      if (canonical.ambiguous) return { rendered: false };
      const observed = live.get(toolCallId);
      const observedParent = observed?.parentToolCallId
        ? lookupMessages(current.messages ?? [], observed.parentToolCallId)
        : undefined;
      const call =
        canonical.call ??
        (observed?.name && observedParent?.call && !observedParent.ambiguous
          ? { name: observed.name, arguments: observed.args }
          : undefined);
      if (!call || typeof call.name !== "string") return { rendered: false };
      const definition = runner.resolveToolRenderers(call.name, () =>
        current.getToolDefinition?.(call.name),
      );
      if (
        typeof definition?.renderCall !== "function" &&
        typeof definition?.renderResult !== "function"
      ) {
        return { rendered: false };
      }
      slot = slots.get(toolCallId);
      if (!slot || slot.name !== call.name) {
        if (slot) disposeComponents(slot);
        slot = { name: call.name, state: {}, active: true };
      }
      slots.delete(toolCallId);
      slots.set(toolCallId, slot);
      trim(slots, disposeComponents);
      const args = structuredClone(call.arguments ?? {});
      const result = structuredClone(canonical.result ?? observed?.result);
      const isPartial = canonical.result
        ? false
        : observed
          ? !observed.ended
          : call.status === "unfinished";
      const context = {
        args,
        toolCallId,
        state: slot.state,
        cwd: current.sessionManager?.getCwd?.() ?? "",
        executionStarted: observed?.executionStarted === true,
        argsComplete: call.arguments !== undefined,
        isPartial,
        expanded: expanded === true,
        showImages: false,
        isError:
          canonical.result?.isError ??
          observed?.isError ??
          result?.isError ??
          call.status === "error",
        durationMs: isPartial
          ? undefined
          : (canonical.result?.durationMs ?? observed?.durationMs ?? call.durationMs),
        outputPad: current.settingsManager?.getOutputPad?.() ?? 0,
        invalidate: () => {
          // Expanded views query again on their bounded presentation timer.
          // Invalidations from a disposed predecessor have no live effect.
          if (slot.active) slot.invalidated = true;
        },
      };
      const lines = [];
      let bytes = 0;
      const renderSlot = (key, renderer, value, options) => {
        const prior = slot[key];
        const component = options
          ? renderer(value, options, getTheme(), { ...context, lastComponent: prior })
          : renderer(value, getTheme(), { ...context, lastComponent: prior });
        if (!component || typeof component.render !== "function") {
          try {
            component?.dispose?.();
          } catch {
            // Invalid extension components still receive best-effort teardown.
          }
          throw new Error("Invalid tool renderer component");
        }
        slot[key] = component;
        if (
          prior &&
          prior !== component &&
          prior !== slot.callComponent &&
          prior !== slot.resultComponent
        ) {
          try {
            prior.dispose?.();
          } catch {
            // A failed old component must not prevent the replacement render.
          }
        }
        const rendered = component.render(Math.max(20, Math.min(240, Math.floor(cols))));
        if (!Array.isArray(rendered)) throw new Error("Invalid tool renderer output");
        for (const line of rendered) {
          if (typeof line !== "string") throw new Error("Invalid tool renderer output");
          bytes += Buffer.byteLength(line, "utf8") + (lines.length > 0 ? 1 : 0);
          if (bytes > TOOL_RENDER_MAX_BYTES) throw new Error("Tool renderer output too large");
          lines.push(line);
        }
      };
      if (typeof definition.renderCall === "function") {
        renderSlot("callComponent", definition.renderCall, args);
      }
      if (result && typeof definition.renderResult === "function") {
        renderSlot("resultComponent", definition.renderResult, result, {
          expanded: context.expanded,
          isPartial,
        });
      }
      return { rendered: true, ansi: lines.join("\n") };
    } catch {
      if (slot) disposeComponents(slot);
      slots.delete(toolCallId);
      return { rendered: false, error: true };
    }
  }

  return { render, observe, reset, dispose: reset };
}
