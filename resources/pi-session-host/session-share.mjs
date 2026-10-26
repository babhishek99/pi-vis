import { randomUUID } from "node:crypto";
import { RADIUS_MCP_URL } from "./radius-mcp.mjs";

const MAX_SHARE_RESPONSE_BYTES = 64 * 1024;

function authToken(result) {
  if (typeof result?.auth?.apiKey === "string" && result.auth.apiKey) return result.auth.apiKey;
  const authorization = Object.entries(result?.auth?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  return typeof authorization === "string"
    ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]
    : undefined;
}

/** Serialize only the selected public branch, with export-only viewer metadata. */
export function serializeShareBranch(session, version) {
  const manager = session.sessionManager;
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version, id: manager.getSessionId(), timestamp, cwd: manager.getCwd() },
  ];
  let parentId = null;
  for (const entry of manager.getBranch()) {
    entries.push({ ...entry, parentId });
    parentId = entry.id;
  }
  entries.push({
    type: "custom",
    customType: "pi.share",
    id: randomUUID().slice(0, 8),
    parentId,
    timestamp,
    data: {
      systemPrompt: session.state.systemPrompt,
      tools: session.state.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    },
  });
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function readBoundedResponse(response, signal) {
  if (!response.body) throw new Error("Radius returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SHARE_RESPONSE_BYTES) throw new Error("Radius returned an oversized response");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeShareUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * undefined means the ordinary gist path should run. Once an authenticated
 * Radius upload is attempted, failure never uploads the same session elsewhere.
 * Credentials stay inside the SDK host; only the bounded public URL is returned.
 */
export async function shareSessionViaRadius(
  session,
  { version, signal, fetchImpl = globalThis.fetch, assertCurrentOwner = () => {} } = {},
) {
  const destination = session.settingsManager?.getSessionShareDestination?.() ?? "auto";
  if (destination === "gist") return undefined;
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  try {
    assertCurrentOwner();
    boundedSignal.throwIfAborted();
    const modelRuntime = session.modelRuntime;
    const provider = modelRuntime?.getProvider?.("radius");
    const token = provider
      ? authToken(
          await modelRuntime.getAuth("radius", {
            signal: boundedSignal,
            minOAuthValidityMs: 5 * 60_000,
          }),
        )
      : undefined;
    assertCurrentOwner();
    boundedSignal.throwIfAborted();
    if (!token) {
      if (destination === "radius")
        throw new Error("Radius sign-in is required; run /login and choose Radius");
      return undefined;
    }
    const body = serializeShareBranch(session, version);
    const url = new URL("/v1/artifacts", RADIUS_MCP_URL);
    url.searchParams.set("visibility", "organization");
    url.searchParams.set("title", "Pi session");
    assertCurrentOwner();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-ndjson",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
      signal: boundedSignal,
    });
    const json = await readBoundedResponse(response, boundedSignal);
    boundedSignal.throwIfAborted();
    assertCurrentOwner();
    const shareUrl = safeShareUrl(json?.artifact?.canonical_url);
    if (!response.ok || !shareUrl)
      throw new Error("Radius upload did not return a valid share URL");
    return { shareUrl };
  } catch (error) {
    if (signal?.aborted) return { cancelled: true };
    if (error?.message === "Radius sign-in is required; run /login and choose Radius") throw error;
    // Provider/network/JSON errors may contain tokens or response content.
    throw new Error("Could not share the session with Radius; check sign-in and retry");
  }
}
