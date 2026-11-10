import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const TAG_HEADER = "x-llmgateway-custom-tags";
const ATTRIBUTED_METHODS = new Set(["stream", "complete", "streamSimple", "completeSimple"]);
// Main's bounded 32-KiB config can gain an absolute tracking-directory path
// when projected into host-only configuration. Keep that projection bounded too.
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TAG_BYTES = 4096;
const MAX_TAGS = 64;
const MAX_MARKER_BYTES = 1024;
const MAX_IN_FLIGHT_MARKERS = 128;
// Only concurrent marker work is retained. Re-read completed markers so a
// removed/corrupt/unreadable marker cannot silently keep attribution enabled.
const inFlightMarkers = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canCopyOptions(value) {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // Spreading a dictionary with inherited, accessor or non-enumerable options
  // could drop a signal/body/hook or change getter behavior. Leave such calls
  // wholly untouched instead of altering a working request for attribution.
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedString(value, maxBytes) {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function parseConfig(raw) {
  try {
    if (!boundedString(raw, MAX_CONFIG_BYTES)) return undefined;
    const config = JSON.parse(raw);
    if (
      !hasExactKeys(config, ["version", "gateways", "trackingDirectory"]) ||
      config.version !== 1 ||
      !Array.isArray(config.gateways) ||
      config.gateways.length === 0 ||
      config.gateways.length > 16 ||
      !boundedString(config.trackingDirectory, 4096) ||
      config.trackingDirectory.includes("\0") ||
      !path.isAbsolute(config.trackingDirectory) ||
      path.resolve(config.trackingDirectory) === path.parse(config.trackingDirectory).root
    ) {
      return undefined;
    }
    const gateways = new Map();
    for (const entry of config.gateways) {
      if (
        !hasExactKeys(entry, ["provider", "baseUrl"]) ||
        !boundedString(entry.provider, 128) ||
        !/^[a-zA-Z0-9_.-]+$/u.test(entry.provider) ||
        !boundedString(entry.baseUrl, 2048) ||
        entry.baseUrl.trim() !== entry.baseUrl ||
        entry.baseUrl.includes("?") ||
        entry.baseUrl.includes("#")
      )
        return undefined;
      const url = new URL(entry.baseUrl);
      // No general HTTP. Explicit IPv4 loopback lets hermetic tests exercise
      // the real pinned transport without weakening TLS for remote gateways.
      if (
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
        !url.hostname ||
        url.username ||
        url.password ||
        unsafePath(url.pathname)
      ) {
        return undefined;
      }
      const gateway = {
        origin: url.origin,
        pathname: url.pathname.replace(/\/+$/u, "") || "/",
      };
      const entries = gateways.get(entry.provider) ?? [];
      entries.push(gateway);
      gateways.set(entry.provider, entries);
    }
    return { gateways, trackingDirectory: config.trackingDirectory };
  } catch {
    return undefined;
  }
}

function unsafePath(pathname) {
  // Do not attribute paths whose encoded separators could be interpreted as
  // escaping the provider prefix by a gateway/router after URL validation.
  return /%(?:2f|5c|25|00)/iu.test(pathname);
}

function requestDestination(input) {
  if (typeof input === "string") return { url: new URL(input), input };
  if (input instanceof URL) {
    const url = new URL(input.href);
    // URL objects are mutable: freeze the validated destination across marker
    // I/O instead of later sending a possibly changed URL with tagged headers.
    return { url, input: url.href };
  }
  if (typeof Request === "function" && input instanceof Request) {
    return {
      url: new URL(Reflect.get(Request.prototype, "url", input)),
      input,
      headers: Reflect.get(Request.prototype, "headers", input),
    };
  }
  return undefined;
}

function isAllowedDestination(url, gateways) {
  return (
    !url.username &&
    !url.password &&
    !unsafePath(url.pathname) &&
    gateways.some(
      ({ origin, pathname }) =>
        url.origin === origin &&
        (pathname === "/" || url.pathname === pathname || url.pathname.startsWith(`${pathname}/`)),
    )
  );
}

function attributedHeaders(source, sessionTag, callId) {
  const headers = new Headers(source);
  const existing = headers.get(TAG_HEADER);
  const retained = [];
  if (existing !== null) {
    if (Buffer.byteLength(existing, "utf8") > MAX_TAG_BYTES) return undefined;
    const tags = existing.split(",");
    if (tags.length > MAX_TAGS) return undefined;
    for (const tag of tags) {
      const trimmed = tag.trim();
      const colon = trimmed.indexOf(":");
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      // Unknown tag syntax is left completely untouched, not "repaired" at
      // the expense of an existing request or its harness attribution.
      if (colon <= 0 || !/^[a-zA-Z0-9_.-]+$/u.test(key) || !value || !/^[ -~]+$/u.test(value))
        return undefined;
      const lowerKey = key.toLowerCase();
      if (lowerKey !== "pivis_session" && lowerKey !== "pivis_call") retained.push(trimmed);
    }
  }
  retained.push(`pivis_session:${sessionTag}`, `pivis_call:${callId}`);
  const next = retained.join(", ");
  if (retained.length > MAX_TAGS || Buffer.byteLength(next, "utf8") > MAX_TAG_BYTES) {
    return undefined;
  }
  headers.set(TAG_HEADER, next);
  return headers;
}

function assertPrivate(stat, type, mode) {
  if (
    !stat[type]() ||
    (stat.mode & 0o7777) !== mode ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Tracking metadata is not private");
  }
}

async function syncDirectoryAncestors(directory) {
  let parent = path.dirname(path.resolve(directory));
  for (;;) {
    const handle = await fs.open(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const next = path.dirname(parent);
    if (parent === next) return;
    parent = next;
  }
}

async function openPrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await fs.lstat(directory);
  assertPrivate(entry, "isDirectory", 0o700);
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    assertPrivate(stat, "isDirectory", 0o700);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new Error("Tracking directory changed");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function validTrackedSince(value) {
  if (typeof value !== "string") return false;
  // Keep valid UTC ISO precision intact, including markers without millis.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/u.exec(value);
  const time = Date.parse(value);
  return (
    match &&
    Number.isFinite(time) &&
    time <= Date.now() &&
    new Date(time).toISOString().startsWith(`${match[1]}:${match[2] ?? "00"}`)
  );
}

async function readMarker(file, sessionTag) {
  let entry;
  try {
    entry = await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  assertPrivate(entry, "isFile", 0o600);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    assertPrivate(stat, "isFile", 0o600);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > MAX_MARKER_BYTES) {
      throw new Error("Invalid tracking marker");
    }
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_MARKER_BYTES) throw new Error("Oversized tracking marker");
    const marker = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)),
    );
    if (
      !hasExactKeys(marker, ["version", "sessionTag", "trackedSince"]) ||
      marker.version !== 1 ||
      marker.sessionTag !== sessionTag ||
      !/^[a-f0-9]{64}$/u.test(marker.sessionTag) ||
      !validTrackedSince(marker.trackedSince)
    ) {
      throw new Error("Invalid tracking marker");
    }
    await handle.sync();
    return marker;
  } finally {
    await handle.close();
  }
}

async function establishMarker(directory, sessionTag) {
  let directoryHandle;
  let temporaryHandle;
  let temporaryPath;
  try {
    directoryHandle = await openPrivateDirectory(directory);
    const markerPath = path.join(directory, `${sessionTag}.json`);
    if (!(await readMarker(markerPath, sessionTag))) {
      // Before publishing a first marker, durably publish its directory chain
      // too. Another host may have just mkdir'd it but not yet synced parents;
      // relying on this call's mkdir result would leave that race uncovered.
      await syncDirectoryAncestors(directory);
      const candidate = path.join(directory, `.${sessionTag}.${randomUUID()}.tmp`);
      temporaryHandle = await fs.open(candidate, "wx", 0o600);
      temporaryPath = candidate;
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.writeFile(
        JSON.stringify({
          version: 1,
          sessionTag,
          trackedSince: new Date().toISOString(),
        }),
        "utf8",
      );
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      try {
        // A rename would clobber another host's (possibly older) marker. A
        // hard link publishes the fully synced file atomically, never over it.
        await fs.link(temporaryPath, markerPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!(await readMarker(markerPath, sessionTag)))
          throw new Error("Tracking marker disappeared");
      }
    }
    // Require directory durability too. Unsupported/erroring filesystems just
    // retain the original untagged request; no error or metadata is logged.
    await directoryHandle.sync();
    return true;
  } finally {
    try {
      await temporaryHandle?.close();
    } finally {
      try {
        if (temporaryPath) await fs.unlink(temporaryPath);
      } finally {
        await directoryHandle?.close();
      }
    }
  }
}

async function ensureMarker(directory, sessionTag) {
  const key = path.join(directory, `${sessionTag}.json`);
  const existing = inFlightMarkers.get(key);
  if (existing) return existing;
  if (inFlightMarkers.size >= MAX_IN_FLIGHT_MARKERS) return false;
  const pending = establishMarker(directory, sessionTag).catch(() => false);
  inFlightMarkers.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightMarkers.delete(key);
  }
}

function attributedFetch(fetch, gateways, sessionManager, trackingDirectory, callId) {
  return async (...args) => {
    let outgoing;
    try {
      const [input, init] = args;
      const destination = requestDestination(input);
      if (destination && isAllowedDestination(destination.url, gateways) && canCopyOptions(init)) {
        // Sample the SDK manager at *fetch invocation*, not runtime creation,
        // selection, renderer identity, JSONL pathname, or transport epoch.
        const id = sessionManager.getSessionId();
        if (boundedString(id, 4096)) {
          const sessionTag = createHash("sha256").update(id, "utf8").digest("hex");
          const headers = attributedHeaders(
            init?.headers !== undefined ? init.headers : destination.headers,
            sessionTag,
            callId,
          );
          if (headers) {
            const next = [...args];
            next[0] = destination.input;
            next[1] = { ...init, headers, redirect: "error" };
            if (await ensureMarker(trackingDirectory, sessionTag)) outgoing = next;
          }
        }
      }
    } catch {
      // Attribution is optional. Config/header/manager/marker failures must not
      // change the existing request, expose data, or trigger a second fetch.
    }
    // Keep transport errors outside the attribution catch. In particular, a
    // redirect refusal must never be retried here as an untagged/following call.
    return Reflect.apply(fetch, globalThis, outgoing ?? args);
  };
}

/**
 * Prospective, partial gateway attribution on Pi's public ModelRuntime only.
 * No header hook can establish the actual auth/routing-resolved destination.
 * Dedicated image/classifier APIs, direct provider calls, external subagents,
 * unknown chat APIs, and custom fetch implementations intentionally stay out.
 */
export function withGatewaySpendAttribution(runtime, sessionManager, rawConfig) {
  const config = parseConfig(rawConfig);
  if (!config) return runtime;
  const methods = new Map();
  return new Proxy(runtime, {
    get(target, property) {
      const original = Reflect.get(target, property, target);
      if (typeof original !== "function") return original;
      const prior = methods.get(property);
      if (prior?.original === original) return prior.bound;
      const bound = ATTRIBUTED_METHODS.has(property)
        ? (...args) => {
            let next = args;
            try {
              const [model, , options] = args;
              const gateways =
                model?.api === "openai-responses" &&
                (model.type === undefined || model.type === "chat") &&
                config.gateways.get(model.provider);
              const fetch = globalThis.fetch;
              if (
                gateways &&
                typeof fetch === "function" &&
                canCopyOptions(options) &&
                (options?.fetch === undefined || options.fetch === fetch)
              ) {
                next = [...args];
                next[2] = {
                  ...options,
                  fetch: attributedFetch(
                    fetch,
                    gateways,
                    sessionManager,
                    config.trackingDirectory,
                    randomUUID(),
                  ),
                };
              }
            } catch {
              // Preserve even unusual caller options verbatim if they cannot be
              // safely decorated; never interfere with Pi's own validation.
            }
            return Reflect.apply(original, target, next);
          }
        : original.bind(target);
      methods.set(property, { original, bound });
      return bound;
    },
  });
}
