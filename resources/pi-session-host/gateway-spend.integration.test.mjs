import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  PI_AI_VERSION,
  createProvider,
} from "@earendil-works/pi-ai";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewaySpendAttribution } from "./gateway-spend.mjs";

const PROVIDER = "pivis-loopback-fixture";
const MODEL = "responses-fixture";
const HEADER = "x-llmgateway-custom-tags";
const roots = [];
const servers = [];
const runtimes = [];

function hash(id) {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function tag(request, key) {
  return request.headers[HEADER]
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${key}:`))
    ?.slice(key.length + 1);
}

function writeResponse(response, model, number) {
  const id = `resp_fixture_${number}`;
  const item = {
    id: `msg_fixture_${number}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Loopback response.", annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id, model, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Loopback response.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        model,
        status: "completed",
        output: [item],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-fixture-response": "observed",
  });
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function loopback(respond) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const chunk of request) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const captured = { url: request.url, headers: request.headers, body };
      requests.push(captured);
      if (respond && (await respond(captured, response, requests.length))) return;
      writeResponse(response, body.model, requests.length);
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, baseUrl: `${origin}/gateway/v1`, requests, errors };
}

function fixture(baseUrl) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pivis-gateway-sdk-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  const trackingDirectory = path.join(root, "tracking");
  for (const directory of [agentDir, cwd, sessions]) mkdirSync(directory, { mode: 0o700 });
  // Never load credentials, settings, context, or histories from the developer.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  return {
    root,
    agentDir,
    cwd,
    sessions,
    trackingDirectory,
    config: JSON.stringify({
      version: 1,
      gateways: [{ provider: PROVIDER, baseUrl }],
      trackingDirectory,
    }),
  };
}

async function createFixtureServices(
  f,
  baseUrl,
  { authBaseUrl, afterResponse, beforeRequest } = {},
) {
  const modelRuntime = await pi.ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = {
    provider: PROVIDER,
    id: MODEL,
    name: "Responses loopback fixture",
    api: "openai-responses",
    baseUrl,
    headers: { [HEADER]: "harness:pi, team:Fixture" },
    input: ["text"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const provider = createProvider({
    id: PROVIDER,
    baseUrl,
    headers: { [HEADER]: "harness:pi, team:Fixture" },
    models: [model],
    api: responses,
    auth: {
      apiKey: {
        name: "Loopback only",
        check: async () => ({ type: "api_key", source: "fixture" }),
        resolve: async () => ({
          auth: { apiKey: "fixture-only-key", ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}) },
        }),
      },
    },
  });
  const services = await pi.createAgentSessionServices({
    cwd: f.cwd,
    agentDir: f.agentDir,
    modelRuntime,
    settingsManager: pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: {
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (api) => {
          // Use the public managed-provider path BEFORE decoration, as host.mjs
          // does. No SDK/provider/global-fetch monkeypatch is involved.
          api.registerProvider(provider);
          if (afterResponse) api.on("after_provider_response", afterResponse);
          if (beforeRequest) api.on("before_provider_request", beforeRequest);
        },
      ],
    },
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
  });
  expect(services.diagnostics).toEqual([]);
  expect(services.modelRuntime).toBe(modelRuntime);
  expect(services.modelRuntime.getModel(PROVIDER, MODEL)?.api).toBe("openai-responses");
  return services;
}

async function directRuntime(f, baseUrl, options) {
  const services = await createFixtureServices(f, baseUrl, options);
  const manager = pi.SessionManager.inMemory(f.cwd);
  const original = services.modelRuntime;
  services.modelRuntime = withGatewaySpendAttribution(original, manager, f.config);
  const wrapped = services.modelRuntime;
  expect(wrapped).not.toBe(original);
  expect(wrapped).toBeInstanceOf(pi.ModelRuntime);
  expect(wrapped.getProvider(PROVIDER)).toBe(original.getProvider(PROVIDER));
  return { wrapped, original, manager, model: wrapped.getModel(PROVIDER, MODEL) };
}

const context = () => ({
  messages: [{ role: "user", content: "Loopback fixture only.", timestamp: 1 }],
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pinned Pi 1.4 public runtime gateway attribution (real loopback Responses transport)", () => {
  it("uses the wrapped services in real sessions, preserves response hooks, and writes no attribution to JSONL", async () => {
    expect(pi.VERSION).toBe("1.4.0");
    expect(PI_AI_VERSION).toBe("1.4.0");
    const markerSnapshots = [];
    let f;
    const endpoint = await loopback((request) => {
      const sessionTag = tag(request, "pivis_session");
      markerSnapshots.push(
        JSON.parse(readFileSync(path.join(f.trackingDirectory, `${sessionTag}.json`), "utf8")),
      );
      return false;
    });
    f = fixture(endpoint.baseUrl);
    const afterResponse = vi.fn();
    const beforeRequest = vi.fn();
    const managers = [];
    const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
      const services = await createFixtureServices(f, endpoint.baseUrl, {
        afterResponse,
        beforeRequest,
      });
      services.modelRuntime = withGatewaySpendAttribution(
        services.modelRuntime,
        sessionManager,
        f.config,
      );
      const created = await pi.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: services.modelRuntime.getModel(PROVIDER, MODEL),
        thinkingLevel: "off",
        tools: [],
      });
      expect(created.session.modelRuntime).toBe(services.modelRuntime);
      managers.push(sessionManager);
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const manager = pi.SessionManager.create(f.cwd, f.sessions);
    const runtime = await pi.createAgentSessionRuntime(createRuntime, {
      cwd: f.cwd,
      agentDir: f.agentDir,
      sessionManager: manager,
    });
    runtimes.push(runtime);
    const bindAndPrompt = async (text) => {
      await runtime.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
      await runtime.session.prompt(text);
      expect(runtime.session.getLastAssistantText()).toBe("Loopback response.");
    };
    expect(existsSync(f.trackingDirectory)).toBe(false);
    await bindAndPrompt("First fixture prompt.");
    const sourceFile = runtime.session.sessionFile;
    const sourceRows = readFileSync(sourceFile, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(sourceRows[0].id).toBe(manager.getSessionId());
    expect(tag(endpoint.requests[0], "pivis_session")).toBe(hash(sourceRows[0].id));
    expect(endpoint.requests[0].headers[HEADER]).toContain("harness:pi, team:Fixture");
    const firstMarkerBytes = readFileSync(
      path.join(f.trackingDirectory, `${hash(manager.getSessionId())}.json`),
      "utf8",
    );

    // A new SessionManager opening the canonical JSONL keeps the SDK/header ID.
    await runtime.switchSession(sourceFile);
    await bindAndPrompt("Resumed fixture prompt.");
    expect(managers[1]).not.toBe(managers[0]);
    expect(managers[1].getSessionId()).toBe(managers[0].getSessionId());
    expect(tag(endpoint.requests[1], "pivis_session")).toBe(
      tag(endpoint.requests[0], "pivis_session"),
    );
    expect(
      readFileSync(path.join(f.trackingDirectory, `${hash(manager.getSessionId())}.json`), "utf8"),
    ).toBe(firstMarkerBytes);

    await runtime.newSession();
    await bindAndPrompt("New fixture prompt.");
    expect(managers[2].getSessionId()).not.toBe(manager.getSessionId());
    expect(tag(endpoint.requests[2], "pivis_session")).toBe(hash(managers[2].getSessionId()));

    // SDK fork/clone headers use a fresh identity rather than inheriting the
    // parent's marker or attributing copied conversation history as new work.
    const fork = pi.SessionManager.forkFrom(sourceFile, f.cwd, f.sessions);
    expect(fork.getSessionId()).not.toBe(manager.getSessionId());
    expect(existsSync(path.join(f.trackingDirectory, `${hash(fork.getSessionId())}.json`))).toBe(
      false,
    );
    await runtime.switchSession(fork.getSessionFile());
    await bindAndPrompt("Forked fixture prompt.");
    expect(tag(endpoint.requests[3], "pivis_session")).toBe(hash(fork.getSessionId()));

    expect(endpoint.requests).toHaveLength(4);
    expect(endpoint.errors).toEqual([]);
    expect(afterResponse).toHaveBeenCalledTimes(4);
    expect(beforeRequest).toHaveBeenCalledTimes(4);
    for (const [event] of afterResponse.mock.calls) {
      expect(event).toMatchObject({
        type: "after_provider_response",
        status: 200,
        headers: { "x-fixture-response": "observed" },
      });
    }
    expect(markerSnapshots).toHaveLength(4);
    expect(markerSnapshots.map((marker) => marker.sessionTag)).toEqual(
      endpoint.requests.map((request) => tag(request, "pivis_session")),
    );
    for (const request of endpoint.requests) {
      expect(request.url).toBe("/gateway/v1/responses");
      expect(JSON.stringify(request.body)).not.toMatch(/pivis_session|pivis_call|trackedSince/u);
    }
    for (const file of readdirSync(f.sessions).filter((file) => file.endsWith(".jsonl"))) {
      const bytes = readFileSync(path.join(f.sessions, file), "utf8");
      expect(bytes).not.toMatch(
        /pivis_session|pivis_call|trackedSince|x-llmgateway-custom-tags|fixture-only-key/u,
      );
      expect(bytes).not.toContain(f.trackingDirectory);
      for (const request of endpoint.requests) {
        expect(bytes).not.toContain(tag(request, "pivis_session"));
        expect(bytes).not.toContain(tag(request, "pivis_call"));
      }
    }
  }, 20_000);

  it.each(["stream", "complete", "streamSimple", "completeSimple"])(
    "passes %s options and onResponse through the real SDK",
    async (method) => {
      const endpoint = await loopback();
      const f = fixture(endpoint.baseUrl);
      const { wrapped, model, manager } = await directRuntime(f, endpoint.baseUrl);
      const onResponse = vi.fn();
      const onPayload = vi.fn((payload) => ({ ...payload, metadata: { fixture: method } }));
      const options = Object.freeze({
        onPayload,
        onResponse,
        maxRetries: 0,
        signal: new AbortController().signal,
      });
      const request = wrapped[method](model, context(), options);
      const result = await (method.startsWith("stream") ? request.result() : request);
      expect(result).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Loopback response." }],
      });
      expect(onPayload).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 200,
          headers: expect.objectContaining({ "x-fixture-response": "observed" }),
        }),
        expect.objectContaining({ provider: PROVIDER, api: "openai-responses" }),
      );
      expect(endpoint.requests[0].body.metadata).toEqual({ fixture: method });
      expect(tag(endpoint.requests[0], "pivis_session")).toBe(hash(manager.getSessionId()));
      expect(options).not.toHaveProperty("fetch");
      expect(endpoint.errors).toEqual([]);
    },
  );

  it("retains one logical UUID but sends every real HTTP retry", async () => {
    const endpoint = await loopback((_request, response, count) => {
      if (count !== 1) return false;
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "fixture retry", type: "server_error" } }));
      return true;
    });
    const f = fixture(endpoint.baseUrl);
    const { wrapped, model } = await directRuntime(f, endpoint.baseUrl);
    const onResponse = vi.fn();
    const result = await wrapped.completeSimple(model, context(), { maxRetries: 1, onResponse });
    expect(result.stopReason).toBe("stop");
    expect(endpoint.requests).toHaveLength(2);
    expect(tag(endpoint.requests[0], "pivis_call")).toBe(tag(endpoint.requests[1], "pivis_call"));
    expect(tag(endpoint.requests[0], "pivis_session")).toBe(
      tag(endpoint.requests[1], "pivis_session"),
    );
    expect(onResponse).toHaveBeenCalledOnce();
    expect(endpoint.errors).toEqual([]);
  });

  it.each(["foreign origin", "outside provider path"])(
    "does not tag or mark an auth-resolved %s override",
    async (kind) => {
      const endpoint = await loopback();
      const foreign = await loopback();
      const actualBase =
        kind === "foreign origin" ? foreign.baseUrl : `${endpoint.origin}/outside/v1`;
      const receiver = kind === "foreign origin" ? foreign : endpoint;
      const f = fixture(endpoint.baseUrl);
      const { wrapped, model } = await directRuntime(f, endpoint.baseUrl, {
        authBaseUrl: actualBase,
      });
      expect(model.baseUrl).toBe(endpoint.baseUrl);
      const onResponse = vi.fn();
      expect(
        (await wrapped.completeSimple(model, context(), { onResponse, maxRetries: 0 })).stopReason,
      ).toBe("stop");
      expect(receiver.requests).toHaveLength(1);
      expect(receiver.requests[0].headers[HEADER]).toBe("harness:pi, team:Fixture");
      expect(tag(receiver.requests[0], "pivis_session")).toBeUndefined();
      expect(existsSync(f.trackingDirectory)).toBe(false);
      expect(onResponse).toHaveBeenCalledOnce();
      expect(endpoint.errors).toEqual([]);
      expect(foreign.errors).toEqual([]);
    },
  );

  it("validates the actual allowed auth endpoint instead of trusting selected model metadata", async () => {
    const endpoint = await loopback();
    const f = fixture(endpoint.baseUrl);
    // This metadata address is never contacted: auth resolves to IPv4 loopback.
    const { wrapped, model, manager } = await directRuntime(f, "https://unused.example.test/v1", {
      authBaseUrl: endpoint.baseUrl,
    });
    expect((await wrapped.completeSimple(model, context(), { maxRetries: 0 })).stopReason).toBe(
      "stop",
    );
    expect(tag(endpoint.requests[0], "pivis_session")).toBe(hash(manager.getSessionId()));
  });

  it("refuses real redirects before they can forward attribution to a foreign destination", async () => {
    const foreign = await loopback();
    const endpoint = await loopback((_request, response) => {
      response.writeHead(307, { location: `${foreign.baseUrl}/responses` });
      response.end();
      return true;
    });
    const f = fixture(endpoint.baseUrl);
    const { wrapped, model, manager } = await directRuntime(f, endpoint.baseUrl);
    const result = await wrapped.completeSimple(model, context(), { maxRetries: 0 });
    expect(result.stopReason).toBe("error");
    expect(endpoint.requests).toHaveLength(1);
    expect(tag(endpoint.requests[0], "pivis_session")).toBe(hash(manager.getSessionId()));
    expect(foreign.requests).toHaveLength(0);
    expect(endpoint.errors).toEqual([]);
  });

  it("keeps original custom fetch and direct provider calls explicitly untracked", async () => {
    const endpoint = await loopback();
    const f = fixture(endpoint.baseUrl);
    const { wrapped, model } = await directRuntime(f, endpoint.baseUrl);
    const customFetch = vi.fn((...args) => globalThis.fetch(...args));
    expect(
      (await wrapped.completeSimple(model, context(), { fetch: customFetch, maxRetries: 0 }))
        .stopReason,
    ).toBe("stop");
    expect(customFetch).toHaveBeenCalledOnce();
    const provider = wrapped.getProvider(PROVIDER);
    const direct = provider.streamSimple(
      model,
      { messages: context().messages },
      { apiKey: "fixture-only-key", maxRetries: 0 },
    );
    expect((await direct.result()).stopReason).toBe("stop");
    expect(endpoint.requests).toHaveLength(2);
    expect(endpoint.requests.map((request) => request.headers[HEADER])).toEqual([
      "harness:pi, team:Fixture",
      "harness:pi, team:Fixture",
    ]);
    expect(existsSync(f.trackingDirectory)).toBe(false);
  });
});
