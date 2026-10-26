import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SettingsManager,
  generateSummaryWithUsage,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../node_modules/@earendil-works/pi-ai/dist/compat.js";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  PI_ATTRIBUTION,
  formatUserAgent,
  getIdentityHeaders,
} from "../node_modules/@earendil-works/pi-ai/dist/utils/identity.js";

const piRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const aiRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-ai");

// These tests call the shipped public SDK. They intentionally do not patch Pi
// implementation files or rely on a developer-installed CLI.
describe("Pi 1.1–1.4 public feature and breaking-change integration", () => {
  it("lets summaries use the model output limit and omits replayed thinking", async () => {
    const response = fauxAssistantMessage("complete summary");
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
      });
      return stream;
    });
    const model = {
      id: "summary",
      name: "Summary",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1/unused",
      input: ["text"],
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 64000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const messages = [
      {
        ...fauxAssistantMessage("visible answer"),
        content: [
          { type: "thinking", thinking: "SECRET REPLAYED THINKING" },
          { type: "text", text: "visible answer" },
        ],
      },
    ];
    expect(serializeConversation(messages as never)).toContain("visible answer");
    expect(serializeConversation(messages as never)).not.toContain("SECRET REPLAYED THINKING");
    await expect(
      generateSummaryWithUsage(
        messages as never,
        model as never,
        1,
        "fixture-key",
        undefined,
        undefined,
        "retain the instructions",
        undefined,
        "high",
        streamFn as never,
      ),
    ).resolves.toMatchObject({ text: "complete summary" });
    const [, context, options] = streamFn.mock.calls[0] as unknown as [
      unknown,
      { messages: unknown },
      Record<string, unknown>,
    ];
    expect(options).not.toHaveProperty("maxTokens");
    expect(options.reasoning).toBe("high");
    expect(options.cacheRetention).toBe("none");
    expect(JSON.stringify(context.messages)).toContain("retain the instructions");
    expect(JSON.stringify(context.messages)).not.toContain("SECRET REPLAYED THINKING");
  });

  it("inherits Pi client identity and supports explicit header overrides", () => {
    expect(formatUserAgent()).toMatch(/^pi\/1\.4\.0 \(/);
    expect(formatUserAgent({ userAgent: "short" })).toBe("pi");
    expect(
      getIdentityHeaders(
        { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
        { attribution: PI_ATTRIBUTION },
      ),
    ).toMatchObject({ "X-OpenRouter-Title": "pi", "HTTP-Referer": "https://pi.dev" });
  });

  it("round-trips share destinations and publishes all generated configuration schemas", async () => {
    const settings = SettingsManager.inMemory();
    expect(settings.getSessionShareDestination()).toBe("auto");
    for (const destination of ["gist", "radius", "auto"] as const) {
      settings.setSessionShareDestination(destination);
      await settings.flush();
      expect(settings.getSessionShareDestination()).toBe(destination);
      expect(settings.getGlobalSettings().sessionShareDestination).toBe(destination);
    }
    for (const schema of ["models", "settings", "keybindings", "theme"]) {
      const document = JSON.parse(
        readFileSync(join(piRoot, "schemas", `${schema}.schema.json`), "utf8"),
      );
      expect(document.$id).toBe(`https://pi.dev/schemas/${schema}.schema.json`);
      expect(document.properties).toBeDefined();
    }
  });

  it("pins the new public discriminants and removed legacy SDK surfaces", () => {
    const types = readFileSync(join(aiRoot, "dist", "types.d.ts"), "utf8");
    expect(types).toContain("telemetry?: TelemetrySpan");
    expect(types).not.toContain("telemetryContext");
    expect(types).toContain("samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel");
    expect(types).toContain("images?: ImageContent[]");
    expect(existsSync(join(aiRoot, "dist", "utils", "assistant-message-frame.d.ts"))).toBe(false);
    expect(existsSync(join(aiRoot, "dist", "utils", "pi-user-agent.js"))).toBe(false);
    const extensionTypes = readFileSync(
      join(piRoot, "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    expect(extensionTypes).toContain('messageType: "user"');
    expect(extensionTypes).toContain('messageType: "custom"');
    expect(extensionTypes).toContain("registerToolRenderer(resolver: ToolRendererResolver)");
    expect(extensionTypes).toContain("reachesTools?:");
    expect(extensionTypes).toContain("durationMs: number | undefined");
    expect(readFileSync(join(piRoot, "dist", "core", "mcp-servers.d.ts"), "utf8")).toContain(
      "clientRegistration?:",
    );
  });
});
