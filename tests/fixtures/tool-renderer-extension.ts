import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function toolRendererFixture(pi: ExtensionAPI): void {
  pi.registerToolRenderer((name, next) => {
    const base = next();
    if (name !== "read") return base;
    return {
      ...base,
      renderCall(args, _theme, context) {
        context.state.fixtureCall = context.toolCallId;
        const input = args as { path?: string };
        return (
          context.lastComponent ?? {
            render: (width) => [`CUSTOM READ CALL ${String(input.path)} (${width} cols)`],
            invalidate() {},
          }
        );
      },
      renderResult(result, _options, _theme, context) {
        context.state.fixtureLastComponent = context.lastComponent !== undefined;
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return (
          context.lastComponent ?? {
            render: () => [
              `CUSTOM READ RESULT ${text}`,
              `SHARED STATE ${context.state.fixtureCall === context.toolCallId ? "PRESERVED" : "LOST"}`,
              `LAST COMPONENT ${context.state.fixtureLastComponent ? "REUSED" : "INITIAL"}`,
              `DURATION ${typeof context.durationMs === "number" ? "KNOWN" : "MISSING"}`,
            ],
            invalidate() {},
          }
        );
      },
    };
  });
}
