import { describe, expect, it, vi } from "vitest";
import { serializeShareBranch, shareSessionViaRadius } from "./session-share.mjs";

function fixture(destination = "auto", token = "fixture-secret") {
  const session = {
    settingsManager: { getSessionShareDestination: () => destination },
    modelRuntime: {
      getProvider: vi.fn(() => ({ id: "radius" })),
      getAuth: vi.fn(async () => (token ? { auth: { apiKey: token } } : undefined)),
    },
    state: {
      systemPrompt: "system prompt",
      tools: [
        {
          name: "read",
          description: "read text",
          parameters: { type: "object" },
          execute: () => {},
        },
      ],
    },
    sessionManager: {
      getSessionId: () => "fixture-session",
      getCwd: () => "/fixture",
      getBranch: () => [
        {
          type: "message",
          id: "branch-a",
          parentId: "omitted-other-branch",
          message: { role: "user", content: "hello 🧪" },
        },
        {
          type: "message",
          id: "branch-b",
          parentId: "branch-a",
          message: { role: "assistant", content: [] },
        },
      ],
    },
  };
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ artifact: { canonical_url: "https://radius.pi.dev/artifact/fixture" } }),
      ),
  );
  return { session, fetchImpl, options: { version: 3, fetchImpl } };
}

describe("session share destinations", () => {
  it("keeps explicit gist private and falls back in auto only before any Radius upload", async () => {
    const gist = fixture("gist");
    await expect(shareSessionViaRadius(gist.session, gist.options)).resolves.toBeUndefined();
    expect(gist.session.modelRuntime.getAuth).not.toHaveBeenCalled();
    expect(gist.fetchImpl).not.toHaveBeenCalled();
    const auto = fixture("auto", undefined);
    auto.session.modelRuntime.getAuth.mockResolvedValue(undefined);
    await expect(shareSessionViaRadius(auto.session, auto.options)).resolves.toBeUndefined();
    expect(auto.fetchImpl).not.toHaveBeenCalled();
    const forced = fixture("radius");
    forced.session.modelRuntime.getAuth.mockResolvedValue(undefined);
    await expect(shareSessionViaRadius(forced.session, forced.options)).rejects.toThrow(
      "Radius sign-in is required",
    );
    expect(forced.fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads only the active branch with viewer metadata and session-resolved credentials", async () => {
    const { session, options, fetchImpl } = fixture();
    await expect(shareSessionViaRadius(session, options)).resolves.toEqual({
      shareUrl: "https://radius.pi.dev/artifact/fixture",
    });
    expect(session.modelRuntime.getAuth).toHaveBeenCalledWith(
      "radius",
      expect.objectContaining({ minOAuthValidityMs: 300000, signal: expect.any(AbortSignal) }),
    );
    const [url, request] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://radius.pi.dev/v1/artifacts?visibility=organization&title=Pi+session",
    );
    expect(request.headers.Authorization).toBe("Bearer fixture-secret");
    expect(request.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(request.headers["Content-Length"]).toBe(String(Buffer.byteLength(request.body)));
    const entries = request.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({
      type: "session",
      version: 3,
      id: "fixture-session",
      cwd: "/fixture",
    });
    expect(entries[1].parentId).toBeNull();
    expect(entries[2].parentId).toBe("branch-a");
    expect(entries[3]).toMatchObject({
      type: "custom",
      customType: "pi.share",
      parentId: "branch-b",
      data: {
        systemPrompt: "system prompt",
        tools: [{ name: "read", parameters: { type: "object" } }],
      },
    });
    expect(JSON.stringify(entries)).not.toContain("execute");
    expect(JSON.stringify(entries)).not.toContain("fixture-secret");
  });

  it("accepts public bearer-token auth while keeping it entirely out of the result", async () => {
    const { session, options, fetchImpl } = fixture("radius");
    session.modelRuntime.getAuth.mockResolvedValue({
      auth: { headers: { authorization: "Bearer bearer-fixture" } },
    });
    const result = await shareSessionViaRadius(session, options);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer bearer-fixture");
    expect(JSON.stringify(result)).not.toContain("bearer-fixture");
  });

  it.each([
    () => new Response(JSON.stringify({ error: "credential fixture-secret" }), { status: 500 }),
    () => new Response("invalid credential fixture-secret"),
    () => new Response(JSON.stringify({ artifact: { canonical_url: "javascript:alert(1)" } })),
    () =>
      new Response(
        JSON.stringify({ artifact: { canonical_url: "https://user:secret@fixture.invalid" } }),
      ),
    () => new Response("x".repeat(65537)),
  ])(
    "fails an attempted upload without leaking provider data or allowing a fallback",
    async (response) => {
      const { session, options, fetchImpl } = fixture();
      fetchImpl.mockImplementation(async () => response());
      await expect(shareSessionViaRadius(session, options)).rejects.toThrow(
        "Could not share the session with Radius; check sign-in and retry",
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("fences a stale owner after credential resolution and after upload", async () => {
    const before = fixture();
    let owner = true;
    before.session.modelRuntime.getAuth.mockImplementation(async () => {
      owner = false;
      return { auth: { apiKey: "fixture-secret" } };
    });
    await expect(
      shareSessionViaRadius(before.session, {
        ...before.options,
        assertCurrentOwner: () => {
          if (!owner) throw new Error("stale");
        },
      }),
    ).rejects.toThrow("Could not share");
    expect(before.fetchImpl).not.toHaveBeenCalled();
    const after = fixture();
    let checks = 0;
    await expect(
      shareSessionViaRadius(after.session, {
        ...after.options,
        assertCurrentOwner: () => {
          if (++checks === 4) throw new Error("stale");
        },
      }),
    ).rejects.toThrow("Could not share");
    expect(after.fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not fall back or replay when an upload loses its response", async () => {
    const { session, options, fetchImpl } = fixture();
    fetchImpl.mockRejectedValue(new Error("upload was accepted, response lost fixture-secret"));
    await expect(shareSessionViaRadius(session, options)).rejects.toThrow(
      "Could not share the session with Radius; check sign-in and retry",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels the response stream as soon as its byte budget is exceeded", async () => {
    const { session, options, fetchImpl } = fixture();
    const cancel = vi.fn();
    fetchImpl.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
          cancel,
        }),
      ),
    );
    await expect(shareSessionViaRadius(session, options)).rejects.toThrow(
      "Could not share the session with Radius; check sign-in and retry",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels a stalled response body when Escape aborts the upload", async () => {
    const { session, options, fetchImpl } = fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    fetchImpl.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = shareSessionViaRadius(session, { ...options, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).resolves.toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels without starting an upload and sanitizes auth failures", async () => {
    const cancelled = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      shareSessionViaRadius(cancelled.session, { ...cancelled.options, signal: controller.signal }),
    ).resolves.toEqual({ cancelled: true });
    expect(cancelled.fetchImpl).not.toHaveBeenCalled();
    const failed = fixture();
    failed.session.modelRuntime.getAuth.mockRejectedValue(
      new Error("auth returned fixture-secret"),
    );
    await expect(shareSessionViaRadius(failed.session, failed.options)).rejects.toThrow(
      "Could not share the session with Radius; check sign-in and retry",
    );
    expect(failed.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not mutate public branch entries while serializing the export", () => {
    const { session } = fixture();
    const branch = session.sessionManager.getBranch();
    session.sessionManager.getBranch = () => branch;
    serializeShareBranch(session, 3);
    expect(branch[0].parentId).toBe("omitted-other-branch");
    expect(branch).toHaveLength(2);
  });
});
