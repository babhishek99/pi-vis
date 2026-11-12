import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewaySpendAttribution } from "./gateway-spend.mjs";

const HEADER = "x-llmgateway-custom-tags";
const BASE = "https://gateway.example.test/provider/v1";
const DESTINATION = `${BASE}/responses`;
const ID = "88eb469c-b9f5-479b-8476-cd0337557d5d";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const METHODS = ["stream", "complete", "streamSimple", "completeSimple"];
const model = Object.freeze({ provider: "gateway", api: "openai-responses", id: "fixture-model" });
const roots = [];

function hash(id) {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture({
  id = ID,
  gateways = [{ provider: "gateway", baseUrl: BASE }],
  trackingPath = "tracking",
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pivis-gateway-spend-"));
  roots.push(root);
  const directory = path.join(root, trackingPath);
  const config = { version: 1, gateways, trackingDirectory: directory };
  const manager = { getSessionId: vi.fn(() => id) };
  const fetch = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const runtime = Object.fromEntries(
    METHODS.map((method) => [method, vi.fn((_model, _context, options) => options)]),
  );
  const wrapped = withGatewaySpendAttribution(runtime, manager, JSON.stringify(config));
  return {
    root,
    directory,
    config,
    manager,
    fetch,
    runtime,
    wrapped,
    markerPath: path.join(directory, `${hash(id)}.json`),
    options: (options, selected = model, method = "streamSimple") =>
      wrapped[method](selected, {}, options),
  };
}

function tagsAt(fetch, index = 0) {
  return new Headers(fetch.mock.calls[index][1]?.headers).get(HEADER);
}

function parsedTags(fetch, index = 0) {
  return tagsAt(fetch, index)
    .split(",")
    .map((tag) => tag.trim());
}

function ownTag(fetch, key, index = 0) {
  return parsedTags(fetch, index)
    .find((tag) => tag.startsWith(`${key}:`))
    .slice(key.length + 1);
}

function seedMarker(f, value, { mode = 0o600 } = {}) {
  mkdirSync(f.directory, { mode: 0o700 });
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(f.markerPath, text, { mode });
  return text;
}

function validMarker(id = ID) {
  return { version: 1, sessionTag: hash(id), trackedSince: "2024-01-02T03:04:05.006Z" };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gateway spend configuration and public runtime decoration", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["old version", { version: 2 }],
    ["missing directory", { trackingDirectory: undefined }],
    ["relative directory", { trackingDirectory: "relative/tracking" }],
    ["filesystem root", { trackingDirectory: path.parse(process.cwd()).root }],
    ["NUL directory", { trackingDirectory: "/tmp/invalid\0tracking" }],
    ["empty gateways", { gateways: [] }],
    [
      "oversized gateway list",
      { gateways: Array.from({ length: 17 }, () => ({ provider: "gateway", baseUrl: BASE })) },
    ],
    ["missing provider", { gateways: [{ baseUrl: BASE }] }],
    ["invalid provider", { gateways: [{ provider: "bad provider", baseUrl: BASE }] }],
    ["invalid URL", { gateways: [{ provider: "gateway", baseUrl: "not a URL" }] }],
    ["non-web URL", { gateways: [{ provider: "gateway", baseUrl: "file:///tmp/gateway" }] }],
    [
      "HTTP remote",
      { gateways: [{ provider: "gateway", baseUrl: "http://gateway.example.test/v1" }] },
    ],
    [
      "HTTP DNS loopback",
      { gateways: [{ provider: "gateway", baseUrl: "http://localhost:1234/v1" }] },
    ],
    [
      "HTTP non-loopback",
      { gateways: [{ provider: "gateway", baseUrl: "http://127.0.0.2:1234/v1" }] },
    ],
    [
      "credentials",
      {
        gateways: [{ provider: "gateway", baseUrl: "https://user:secret@gateway.example.test/v1" }],
      },
    ],
    ["query", { gateways: [{ provider: "gateway", baseUrl: `${BASE}?key=secret` }] }],
    ["fragment", { gateways: [{ provider: "gateway", baseUrl: `${BASE}#secret` }] }],
    ["whitespace URL", { gateways: [{ provider: "gateway", baseUrl: ` ${BASE}` }] }],
    ["encoded separator", { gateways: [{ provider: "gateway", baseUrl: `${BASE}%2fother` }] }],
    ["unexpected identity", { identity: "private" }],
    [
      "unexpected gateway data",
      { gateways: [{ provider: "gateway", baseUrl: BASE, headers: { authorization: "secret" } }] },
    ],
    ["oversized config", " ".repeat(64 * 1024 + 1)],
  ])("leaves the exact original runtime unchanged for %s configuration", (_label, input) => {
    const f = fixture();
    const raw =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? JSON.stringify({ ...f.config, ...input })
        : input;
    expect(withGatewaySpendAttribution(f.runtime, f.manager, raw)).toBe(f.runtime);
    expect(f.manager.getSessionId).not.toHaveBeenCalled();
    expect(existsSync(f.directory)).toBe(false);
  });

  it("accepts a bounded main projection that grows beyond the source config's byte limit", () => {
    const f = fixture();
    const raw = JSON.stringify({
      ...f.config,
      gateways: Array.from({ length: 16 }, () => ({
        provider: "gateway",
        baseUrl: `${BASE}/${"a".repeat(1900)}`,
      })),
      trackingDirectory: path.join(f.root, "nested/".repeat(300)),
    });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(32 * 1024);
    expect(Buffer.byteLength(raw)).toBeLessThan(64 * 1024);
    expect(withGatewaySpendAttribution(f.runtime, f.manager, raw)).not.toBe(f.runtime);
    expect(existsSync(f.directory)).toBe(false);
  });

  it("binds all other methods/getters to the original runtime and memoizes function wrappers", () => {
    const f = fixture();
    const provider = Object.freeze({ auth: Object.freeze({ fixture: true }) });
    const symbol = Symbol("public method");
    class Runtime {
      #private = provider;
      get value() {
        return this.#private;
      }
      getProvider() {
        return this.#private;
      }
      [symbol]() {
        return this.#private;
      }
      stream(_model, _context, options) {
        return { owner: this, options };
      }
    }
    const runtime = new Runtime();
    const wrapped = withGatewaySpendAttribution(runtime, f.manager, JSON.stringify(f.config));
    expect(wrapped).toBeInstanceOf(Runtime);
    expect(wrapped.value).toBe(provider);
    const detached = wrapped.getProvider;
    expect(detached()).toBe(provider);
    expect(wrapped.getProvider).toBe(detached);
    expect(wrapped[symbol]).toBe(wrapped[symbol]);
    expect(wrapped[symbol]()).toBe(provider);
    expect(wrapped.stream).toBe(wrapped.stream);
    expect(wrapped.stream(model, {}).owner).toBe(runtime);
    const replacement = function () {
      return this.value;
    };
    runtime.getProvider = replacement;
    expect(wrapped.getProvider).not.toBe(detached);
    expect(wrapped.getProvider()).toBe(provider);
    expect(runtime.getProvider).toBe(replacement);
    expect(f.manager.getSessionId).not.toHaveBeenCalled();
    expect(existsSync(f.directory)).toBe(false);
  });

  it.each(METHODS)(
    "clones only %s's third argument while retaining all public request options",
    (method) => {
      const f = fixture();
      const options = Object.freeze({
        fetch: globalThis.fetch,
        onPayload: vi.fn(),
        onResponse: vi.fn(),
        onProviderStreamEvent: vi.fn(),
        signal: new AbortController().signal,
        maxRetries: 4,
        maxRetryDelayMs: 750,
        timeoutMs: 1234,
        reasoning: "high",
        headers: Object.freeze({ authorization: "fixture-only" }),
        transformHeaders: vi.fn(),
        env: Object.freeze({ FIXTURE_ONLY: "yes" }),
        metadata: { fixture: true },
        telemetry: {},
        samplingParams: { temperature: 0.2 },
      });
      const context = {};
      const fourth = Symbol("future positional argument");
      const decorated = f.wrapped[method](model, context, options, fourth);
      expect(decorated).not.toBe(options);
      expect(decorated.fetch).not.toBe(options.fetch);
      for (const [key, value] of Object.entries(options)) {
        if (key !== "fetch") expect(decorated[key]).toBe(value);
      }
      expect(f.runtime[method].mock.calls[0]).toEqual([model, context, decorated, fourth]);
      expect(options.fetch).toBe(globalThis.fetch);
      expect(f.manager.getSessionId).not.toHaveBeenCalled();
      expect(existsSync(f.directory)).toBe(false);
    },
  );

  it.each(["inherited", "non-enumerable", "accessor"])(
    "leaves %s public option dictionaries intact rather than spreading away their behavior",
    (kind) => {
      const f = fixture();
      const signal = new AbortController().signal;
      const options = kind === "inherited" ? Object.create({ signal }) : {};
      if (kind !== "inherited") {
        Object.defineProperty(options, "signal", {
          ...(kind === "accessor" ? { get: () => signal } : { value: signal }),
          enumerable: kind === "accessor",
        });
      }
      expect(f.options(options)).toBe(options);
      expect(f.manager.getSessionId).not.toHaveBeenCalled();
      expect(existsSync(f.directory)).toBe(false);
    },
  );

  it.each([undefined, null, vi.fn()])(
    "preserves an explicit non-default custom fetch verbatim (%s)",
    (fetch) => {
      const f = fixture();
      // undefined is the supported absent/default case, not a custom fetch.
      if (fetch === undefined) {
        expect(f.options({ fetch }).fetch).toBeTypeOf("function");
      } else {
        const options = Object.freeze({ fetch, maxRetries: 1 });
        expect(f.options(options)).toBe(options);
      }
      expect(existsSync(f.directory)).toBe(false);
    },
  );

  it.each([
    { ...model, provider: "foreign" },
    { ...model, api: "openai-completions" },
    { ...model, api: "azure-openai-responses" },
    { ...model, api: "unknown" },
    { ...model, api: "virtual" },
    { ...model, type: "image" },
    { ...model, type: "classifier" },
  ])("does not instrument unsupported/unconfigured model %j", (selected) => {
    const f = fixture();
    const options = Object.freeze({ onResponse: vi.fn() });
    for (const method of METHODS) expect(f.options(options, selected, method)).toBe(options);
    expect(existsSync(f.directory)).toBe(false);
  });

  it("leaves dedicated image/classifier/deferred and direct provider methods unwrapped", () => {
    const f = fixture();
    const result = {};
    for (const name of [
      "generateImages",
      "classify",
      "streamDeferred",
      "fetchDeferred",
      "cancelDeferred",
    ]) {
      f.runtime[name] = vi.fn(() => result);
      const options = {};
      expect(f.wrapped[name](model, {}, options)).toBe(result);
      expect(f.runtime[name].mock.calls[0][2]).toBe(options);
    }
    expect(existsSync(f.directory)).toBe(false);
  });

  it("uses one opaque logical UUID per invocation, reuses it for HTTP attempts, and never deduplicates", async () => {
    const f = fixture();
    const first = f.options();
    const second = f.options();
    const failure = new Error("fixture transport error");
    f.fetch.mockRejectedValueOnce(failure);
    await expect(first.fetch(DESTINATION)).rejects.toBe(failure);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await first.fetch(DESTINATION);
    await second.fetch(DESTINATION);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    const firstId = ownTag(f.fetch, "pivis_call");
    expect(firstId).toMatch(UUID);
    expect(ownTag(f.fetch, "pivis_call", 1)).toBe(firstId);
    expect(ownTag(f.fetch, "pivis_call", 2)).toMatch(UUID);
    expect(ownTag(f.fetch, "pivis_call", 2)).not.toBe(firstId);
  });
});

describe("actual request URL and header safety", () => {
  it.each([
    [BASE, true],
    [`${BASE}/`, true],
    [DESTINATION, true],
    [`${DESTINATION}?fixture=yes`, true],
    ["https://GATEWAY.example.test:443/provider/v1/responses", true],
    ["https://gateway.example.test/provider/v10/responses", false],
    ["https://gateway.example.test/provider/v1-other/responses", false],
    ["https://gateway.example.test/provider", false],
    ["https://gateway.example.test/other/v1/responses", false],
    ["https://gateway.example.test/provider/v1/../foreign", false],
    ["https://gateway.example.test/provider/v1/%2e%2e/foreign", false],
    ["https://gateway.example.test/provider/v1/%2f..%2fforeign", false],
    ["https://gateway.example.test/provider/v1/%5c..%5cforeign", false],
    ["https://gateway.example.test/provider/v1/%252f..", false],
    ["https://gateway.example.test/provider/v1%2fresponses", false],
    ["https://gateway.example.test:444/provider/v1/responses", false],
    ["http://gateway.example.test/provider/v1/responses", false],
    ["https://other.example.test/provider/v1/responses", false],
    ["https://gateway.example.test.evil.test/provider/v1/responses", false],
    ["https://user:secret@gateway.example.test/provider/v1/responses", false],
    ["https://user@gateway.example.test/provider/v1/responses", false],
    ["file:///provider/v1/responses", false],
    ["/provider/v1/responses", false],
    ["not a URL", false],
  ])("attributes actual destination %s: %s", async (url, allowed) => {
    const f = fixture();
    const headers = Object.freeze({
      "X-LlmGateway-Custom-Tags": "harness:pi",
      "x-extra": "KeepCase",
    });
    const init = Object.freeze({ method: "POST", headers, redirect: "follow" });
    await f.options().fetch(url, init);
    const [sentInput, sentInit] = f.fetch.mock.calls[0];
    expect(sentInput).toBe(url);
    if (allowed) {
      expect(sentInit).not.toBe(init);
      expect(sentInit.redirect).toBe("error");
      expect(parsedTags(f.fetch)).toContain("harness:pi");
      expect(ownTag(f.fetch, "pivis_session")).toBe(hash(ID));
      expect(existsSync(f.markerPath)).toBe(true);
    } else {
      expect(sentInit).toBe(init);
      expect(existsSync(f.directory)).toBe(false);
      expect(f.manager.getSessionId).not.toHaveBeenCalled();
    }
  });

  it("ignores selected model.baseUrl, including an auth override to a foreign endpoint", async () => {
    const f = fixture();
    const selected = {
      ...model,
      get baseUrl() {
        throw new Error("must never read selected endpoint");
      },
    };
    const options = f.options({}, selected);
    await options.fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session")).toBe(hash(ID));
    const foreign = new Request("https://auth-override.example.test/responses", {
      method: "POST",
      headers: { [HEADER]: "harness:pi" },
      body: "fixture",
      redirect: "follow",
    });
    const init = Object.freeze({ signal: new AbortController().signal });
    await options.fetch(foreign, init);
    expect(f.fetch.mock.calls[1]).toEqual([foreign, init]);
    expect(f.fetch.mock.calls[1][0]).toBe(foreign);
    expect(f.fetch.mock.calls[1][1]).toBe(init);
    expect(foreign.headers.get(HEADER)).toBe("harness:pi");
    expect(foreign.bodyUsed).toBe(false);
  });

  it("validates a Request's real URL even when a subclass presents a misleading URL getter", async () => {
    const f = fixture();
    class MisleadingRequest extends Request {
      get url() {
        return DESTINATION;
      }
    }
    const request = new MisleadingRequest("https://foreign.example.test/responses", {
      headers: { [HEADER]: "harness:pi" },
    });
    const init = {};
    await f.options().fetch(request, init);
    expect(f.fetch.mock.calls[0][0]).toBe(request);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(existsSync(f.directory)).toBe(false);
  });

  it("allows each configured provider boundary, including a root and trailing-slash base", async () => {
    const f = fixture({
      gateways: [
        { provider: "gateway", baseUrl: `${BASE}/` },
        { provider: "gateway", baseUrl: "https://alternate.example.test/" },
        { provider: "another", baseUrl: "https://another.example.test/nested" },
      ],
    });
    await f.options().fetch(DESTINATION);
    await f.options().fetch("https://alternate.example.test/responses");
    await f
      .options({}, { ...model, provider: "another" })
      .fetch("https://another.example.test/nested");
    for (let index = 0; index < 3; index += 1) {
      expect(ownTag(f.fetch, "pivis_session", index)).toBe(hash(ID));
    }
  });

  it.each(["record", "Headers", "tuples"])(
    "preserves harness/unrelated tags and never mutates %s headers",
    async (kind) => {
      const f = fixture();
      const value = "Harness:Pi, TEAM:KeepCase, PiVis_Session:old, pivis_call:old, region:EU:west";
      const entries = [
        ["X-LlmGateway-Custom-Tags", value],
        ["Authorization", "fixture-secret"],
        ["X-Extra", "KeepCase"],
      ];
      const source =
        kind === "record"
          ? Object.freeze(Object.fromEntries(entries))
          : kind === "Headers"
            ? new Headers(entries)
            : Object.freeze(entries.map((entry) => Object.freeze(entry)));
      const before = [...new Headers(source)];
      const init = Object.freeze({
        headers: source,
        redirect: "follow",
        method: "POST",
        body: "fixture-body",
      });
      await f.options().fetch(DESTINATION, init);
      const sent = f.fetch.mock.calls[0][1];
      expect(sent).not.toBe(init);
      expect(sent.headers).not.toBe(source);
      expect([...new Headers(source)]).toEqual(before);
      expect(sent.method).toBe(init.method);
      expect(sent.body).toBe(init.body);
      expect(sent.headers.get("authorization")).toBe("fixture-secret");
      expect(sent.headers.get("x-extra")).toBe("KeepCase");
      expect(parsedTags(f.fetch)).toEqual([
        "Harness:Pi",
        "TEAM:KeepCase",
        "region:EU:west",
        `pivis_session:${hash(ID)}`,
        `pivis_call:${ownTag(f.fetch, "pivis_call")}`,
      ]);
      expect(ownTag(f.fetch, "pivis_call")).toMatch(UUID);
    },
  );

  it.each(["inherited", "non-enumerable", "accessor"])(
    "does not drop %s RequestInit fields while adding attribution",
    async (kind) => {
      const f = fixture();
      const init = kind === "inherited" ? Object.create({ method: "POST" }) : {};
      if (kind !== "inherited") {
        Object.defineProperty(init, "method", {
          ...(kind === "accessor" ? { get: () => "POST" } : { value: "POST" }),
          enumerable: kind === "accessor",
        });
      }
      await f.options().fetch(DESTINATION, init);
      expect(f.fetch.mock.calls[0][1]).toBe(init);
      expect(f.fetch.mock.calls[0][1].method).toBe("POST");
      expect(existsSync(f.directory)).toBe(false);
    },
  );

  it("combines case-varied tag headers without replacing harness, and removes every old owned tag", async () => {
    const f = fixture();
    const headers = Object.freeze({
      "X-LLMGateway-Custom-Tags": "harness:pi, PIVIS_SESSION:old",
      "x-llmgateway-custom-tags": "team:One, PiViS_CaLl:old, pivis_session:older",
    });
    await f.options().fetch(DESTINATION, { headers });
    expect(parsedTags(f.fetch)).toEqual([
      "harness:pi",
      "team:One",
      `pivis_session:${hash(ID)}`,
      `pivis_call:${ownTag(f.fetch, "pivis_call")}`,
    ]);
  });

  it("clones Request headers without consuming/mutating the Request and respects init header replacement", async () => {
    const f = fixture();
    const request = new Request(DESTINATION, {
      method: "POST",
      body: "fixture-body",
      redirect: "follow",
      headers: { [HEADER]: "harness:pi", "x-original": "yes" },
    });
    await f.options().fetch(request);
    expect(f.fetch.mock.calls[0][0]).toBe(request);
    expect(f.fetch.mock.calls[0][1].redirect).toBe("error");
    expect(parsedTags(f.fetch)).toContain("harness:pi");
    expect(request.headers.get(HEADER)).toBe("harness:pi");
    expect(request.redirect).toBe("follow");
    expect(request.bodyUsed).toBe(false);
    const init = Object.freeze({ headers: Object.freeze({ [HEADER]: "team:Override" }) });
    await f.options().fetch(request, init);
    const sent = f.fetch.mock.calls[1][1];
    expect(sent.headers.get("x-original")).toBe(null);
    expect(parsedTags(f.fetch, 1)).toContain("team:Override");
    expect(parsedTags(f.fetch, 1)).not.toContain("harness:pi");
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    "",
    "broken",
    ":missing-key",
    "empty:",
    "harness:pi,,team:yes",
    "harness:pi,",
    "invalid key:value",
    "unicode:é",
    "control:\nvalue",
    `large:${"x".repeat(4096)}`,
    `large:${"x".repeat(4080)}`,
    Array.from({ length: 65 }, (_, index) => `key${index}:value`).join(","),
  ])("leaves malformed/oversized tag values untouched (%s)", async (value) => {
    const f = fixture();
    const init = Object.freeze({ headers: Object.freeze({ [HEADER]: value }), redirect: "follow" });
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(existsSync(f.directory)).toBe(false);
  });

  it.each(["follow", "manual", "error"])(
    "forces redirect:error only when adding tags (original %s)",
    async (redirect) => {
      const f = fixture();
      const init = Object.freeze({ redirect });
      await f.options().fetch(DESTINATION, init);
      expect(f.fetch.mock.calls[0][1].redirect).toBe("error");
      expect(init.redirect).toBe(redirect);
      const foreign = "https://foreign.example.test/responses";
      await f.options().fetch(foreign, init);
      expect(f.fetch.mock.calls[1][1]).toBe(init);
    },
  );

  it("freezes an allowed URL object before asynchronous marker work", async () => {
    const f = fixture();
    const blocked = deferred();
    const reached = deferred();
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      reached.resolve();
      await blocked.promise;
      return link(...args);
    });
    const url = new URL(DESTINATION);
    const pending = f.options().fetch(url);
    await reached.promise;
    url.hostname = "foreign.example.test";
    f.manager.getSessionId.mockReturnValue("successor-after-fetch-invocation");
    blocked.resolve();
    await pending;
    expect(f.fetch.mock.calls[0][0]).toBe(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session")).toBe(hash(ID));
    await f.options().fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session", 1)).toBe(hash("successor-after-fetch-invocation"));
  });

  it("passes unsupported request inputs and missing/invalid manager IDs through unchanged", async () => {
    const f = fixture();
    const requestLike = { url: DESTINATION };
    const init = {};
    await f.options().fetch(requestLike, init);
    expect(f.fetch.mock.calls[0]).toEqual([requestLike, init]);
    for (const id of [undefined, null, "", 123, "x".repeat(4097)]) {
      f.manager.getSessionId.mockReturnValue(id);
      await f.options().fetch(DESTINATION, init);
      expect(f.fetch.mock.calls.at(-1)[1]).toBe(init);
    }
    f.manager.getSessionId.mockImplementation(() => {
      throw new Error("fixture manager failure");
    });
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls.at(-1)[1]).toBe(init);
    expect(existsSync(f.directory)).toBe(false);
  });
});

describe("SDK session identity and durable metadata-only tracking markers", () => {
  it("creates a private, exact metadata marker before the first tagged fetch, not at runtime/call construction", async () => {
    const f = fixture();
    const before = Date.now();
    const options = f.options();
    expect(existsSync(f.directory)).toBe(false);
    f.fetch.mockImplementation(async () => {
      const marker = JSON.parse(readFileSync(f.markerPath, "utf8"));
      expect(marker).toEqual({
        version: 1,
        sessionTag: hash(ID),
        trackedSince: expect.any(String),
      });
      expect(new Date(marker.trackedSince).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(marker.trackedSince).getTime()).toBeLessThanOrEqual(Date.now());
      expect(statSync(f.directory).mode & 0o7777).toBe(0o700);
      expect(statSync(f.markerPath).mode & 0o7777).toBe(0o600);
      return { ok: true };
    });
    await options.fetch(DESTINATION);
    expect(readdirSync(f.directory)).toEqual([`${hash(ID)}.json`]);
    const bytes = readFileSync(f.markerPath, "utf8");
    expect(bytes).not.toContain(ID);
    expect(bytes).not.toContain("pivis_call");
    expect(bytes).not.toContain(DESTINATION);
  });

  it("samples the exact UTF-8 SDK ID at fetch invocation and follows new/fork/clone IDs but not tree/epoch changes", async () => {
    const f = fixture();
    const options = f.options();
    const current = "  new-SDK-identity-é  ";
    f.manager.getSessionId.mockReturnValue(current);
    f.manager.getSessionFile = () => {
      throw new Error("must not use the JSONL filename");
    };
    f.manager.rendererId = "unrelated-registry-ID";
    f.manager.epoch = 3;
    await options.fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session")).toBe(hash(current));
    f.manager.epoch = 4;
    f.manager.leaf = "different-tree-node";
    await options.fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session", 1)).toBe(hash(current));
    const successor = withGatewaySpendAttribution(
      f.runtime,
      { getSessionId: () => current },
      JSON.stringify(f.config),
    );
    await successor.streamSimple(model, {}).fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session", 2)).toBe(hash(current));
    f.manager.getSessionId.mockReturnValue("new-fork-or-clone-SDK-UUID");
    await options.fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session", 3)).toBe(hash("new-fork-or-clone-SDK-UUID"));
    expect(readdirSync(f.directory).filter((file) => file.endsWith(".json"))).toHaveLength(2);
  });

  it.each(["2024-01-02T03:04:05.006Z", "2024-01-02T03:04:05Z", "2024-01-02T03:04Z"])(
    "preserves the earliest valid marker (%s) byte-for-byte across requests and runtime reload",
    async (trackedSince) => {
      const f = fixture();
      const text = seedMarker(f, { ...validMarker(), trackedSince });
      const before = statSync(f.markerPath);
      await f.options().fetch(DESTINATION);
      await withGatewaySpendAttribution(f.runtime, f.manager, JSON.stringify(f.config))
        .completeSimple(model, {})
        .fetch(DESTINATION);
      expect(readFileSync(f.markerPath, "utf8")).toBe(text);
      expect(statSync(f.markerPath).ino).toBe(before.ino);
      expect(statSync(f.markerPath).mtimeMs).toBe(before.mtimeMs);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(ownTag(f.fetch, "pivis_session", 1)).toBe(hash(ID));
    },
  );

  it.each([
    "{",
    " ".repeat(1025),
    {},
    [],
    { ...validMarker(), version: 2 },
    { ...validMarker(), sessionTag: "0".repeat(64) },
    { ...validMarker(), sessionTag: hash(ID).toUpperCase() },
    { ...validMarker(), trackedSince: "not a date" },
    { ...validMarker(), trackedSince: "2024-01-02" },
    { ...validMarker(), trackedSince: "2024-02-31T00:00:00Z" },
    { ...validMarker(), trackedSince: "2999-01-01T00:00:00.000Z" },
    { ...validMarker(), extra: "must never clobber" },
  ])("never clobbers corrupt/oversized/mismatched existing marker %j", async (value) => {
    const f = fixture();
    const text = seedMarker(f, value);
    const init = Object.freeze({
      redirect: "follow",
      headers: Object.freeze({ [HEADER]: "harness:pi" }),
    });
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(readFileSync(f.markerPath, "utf8")).toBe(text);
    expect(readdirSync(f.directory)).toEqual([`${hash(ID)}.json`]);
  });

  it("privately creates and syncs every new directory's parent entry", async () => {
    const f = fixture({ trackingPath: "nested/profile/tracking" });
    const open = vi.spyOn(fs, "open");
    await f.options().fetch(DESTINATION);
    expect(ownTag(f.fetch, "pivis_session")).toBe(hash(ID));
    for (const directory of [
      f.root,
      path.join(f.root, "nested"),
      path.join(f.root, "nested/profile"),
    ]) {
      expect(open.mock.calls.some(([file]) => file === directory)).toBe(true);
      expect(statSync(directory).mode & 0o7777).toBe(0o700);
    }
  });

  it.each(["BOM", "invalid UTF-8"])(
    "does not overwrite or attribute a marker with %s bytes",
    async (kind) => {
      const f = fixture();
      const text = seedMarker(f, validMarker());
      const original =
        kind === "BOM"
          ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
          : Buffer.concat([Buffer.from(text), Buffer.from([0xff])]);
      writeFileSync(f.markerPath, original);
      const init = {};
      await f.options().fetch(DESTINATION, init);
      expect(f.fetch.mock.calls[0][1]).toBe(init);
      expect(readFileSync(f.markerPath)).toEqual(original);
    },
  );

  it("bounds the actual marker read even if a file grows after stat", async () => {
    const f = fixture();
    seedMarker(f, " ".repeat(4096));
    const open = fs.open.bind(fs);
    const reads = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === f.markerPath) {
        const stat = await handle.stat();
        vi.spyOn(handle, "stat").mockResolvedValue(Object.assign(stat, { size: 16 }));
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((...readArgs) => {
          reads.push(readArgs);
          return read(...readArgs);
        });
      }
      return handle;
    });
    const init = {};
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(reads).toHaveLength(1);
    expect(reads[0][0].length).toBe(1025);
    expect(reads[0][2]).toBe(1025);
    expect(statSync(f.markerPath).size).toBe(4096);
  });

  it("revalidates completed markers instead of hiding corruption behind a success cache", async () => {
    const f = fixture();
    await f.options().fetch(DESTINATION);
    expect(tagsAt(f.fetch)).toContain(`pivis_session:${hash(ID)}`);
    writeFileSync(f.markerPath, "corrupt", { mode: 0o600 });
    const init = {};
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[1][1]).toBe(init);
    expect(readFileSync(f.markerPath, "utf8")).toBe("corrupt");
  });

  it.each([
    "public directory",
    "public marker",
    "directory marker",
    "symlink marker",
    "symlink directory",
  ])("fails open without tagging or clobbering a %s", async (kind) => {
    const f = fixture();
    if (kind === "symlink directory") {
      const target = path.join(f.root, "other");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, f.directory);
    } else {
      mkdirSync(f.directory, { mode: 0o700 });
      if (kind === "public directory") chmodSync(f.directory, 0o755);
      if (kind === "public marker")
        writeFileSync(f.markerPath, JSON.stringify(validMarker()), { mode: 0o644 });
      if (kind === "directory marker") mkdirSync(f.markerPath, { mode: 0o700 });
      if (kind === "symlink marker") {
        const target = path.join(f.root, "other.json");
        writeFileSync(target, JSON.stringify(validMarker()), { mode: 0o600 });
        symlinkSync(target, f.markerPath);
      }
    }
    const init = {};
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(readdirSync(f.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["mkdir", "open", "link", "unlink"])(
    "does not affect the existing request when marker %s fails",
    async (operation) => {
      const f = fixture();
      vi.spyOn(fs, operation).mockRejectedValueOnce(
        Object.assign(new Error("fixture IO error"), { code: "EACCES" }),
      );
      const init = Object.freeze({
        headers: Object.freeze({ [HEADER]: "harness:pi" }),
        redirect: "follow",
      });
      const errorLog = vi.spyOn(console, "error");
      await f.options().fetch(DESTINATION, init);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.fetch.mock.calls[0][1]).toBe(init);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it.each(["file", "directory"])("requires successful %s fsync before tagging", async (kind) => {
    const f = fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if ((kind === "file") === (args[1] === "wx")) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("fixture fsync failure"));
      }
      return handle;
    });
    const init = {};
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(readdirSync(f.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never removes another publisher's temporary file when exclusive creation fails", async () => {
    const f = fixture();
    const open = fs.open.bind(fs);
    const unlink = vi.spyOn(fs, "unlink");
    let otherTemporary;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[1] === "wx") {
        otherTemporary = args[0];
        writeFileSync(otherTemporary, "other publisher's metadata", { flag: "wx", mode: 0o600 });
      }
      return open(...args);
    });
    const init = {};
    await f.options().fetch(DESTINATION, init);
    expect(f.fetch.mock.calls[0][1]).toBe(init);
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(otherTemporary, "utf8")).toBe("other publisher's metadata");
    expect(existsSync(f.markerPath)).toBe(false);
  });

  it("coalesces concurrent first requests, persists one marker, and keeps every HTTP attempt", async () => {
    const f = fixture();
    const link = vi.spyOn(fs, "link");
    const requests = Array.from({ length: 20 }, () =>
      withGatewaySpendAttribution(f.runtime, f.manager, JSON.stringify(f.config))
        .streamSimple(model, {})
        .fetch(DESTINATION),
    );
    await Promise.all(requests);
    expect(link).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(20);
    expect(readdirSync(f.directory)).toEqual([`${hash(ID)}.json`]);
    for (let index = 0; index < 20; index += 1)
      expect(ownTag(f.fetch, "pivis_session", index)).toBe(hash(ID));
    expect(
      new Set(f.fetch.mock.calls.map((_, index) => ownTag(f.fetch, "pivis_call", index))).size,
    ).toBe(20);
  });

  it.each([false, true])(
    "uses atomic no-overwrite publication when another host wins (corrupt winner: %s)",
    async (corrupt) => {
      const f = fixture();
      const winner = corrupt ? "malformed competing marker" : JSON.stringify(validMarker());
      const link = fs.link.bind(fs);
      vi.spyOn(fs, "link").mockImplementationOnce(async (source, target) => {
        // This produces a real EEXIST from the OS, as a separate publisher would.
        writeFileSync(target, winner, { mode: 0o600, flag: "wx" });
        return link(source, target);
      });
      const init = {};
      await f.options().fetch(DESTINATION, init);
      expect(readFileSync(f.markerPath, "utf8")).toBe(winner);
      expect(readdirSync(f.directory)).toEqual([`${hash(ID)}.json`]);
      if (corrupt) expect(f.fetch.mock.calls[0][1]).toBe(init);
      else expect(ownTag(f.fetch, "pivis_session")).toBe(hash(ID));
    },
  );
});
