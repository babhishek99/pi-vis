import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionId } from "@shared/ids.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({ getSubprocessEnv: vi.fn() }));

import { getSubprocessEnv } from "./auth.js";
import { OwnerBoundShareEffects, createGistForExport } from "./share.js";

const sessionId = "share-session" as SessionId;
const owner = { hostInstanceId: "share-host", sessionEpoch: 3 };
let tempDir: string | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("owner-bound sharing", () => {
  it("uses fake gh to create a gist from the authoritative exported path", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-vis-fake-gh-"));
    const gh = path.join(tempDir, "gh");
    await writeFile(
      gh,
      '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\nif [ "$1" = "gist" ]; then echo "https://gist.github.com/test/gist-id"; exit 0; fi\nexit 1\n',
    );
    await chmod(gh, 0o755);
    vi.mocked(getSubprocessEnv).mockResolvedValue({ PATH: tempDir });

    await expect(createGistForExport("/authoritative/session.html")).resolves.toEqual({
      ok: true,
      gistUrl: "https://gist.github.com/test/gist-id",
      url: "https://pi.dev/session/#gist-id",
    });
  });

  it("fences stale owners before starting the OS effect", async () => {
    const createGist = vi.fn();
    const effects = new OwnerBoundShareEffects(createGist);
    await expect(
      effects.run(sessionId, owner, "export-1", "/tmp/export.html", () => false),
    ).resolves.toEqual({ ok: false, error: "Session changed before share creation" });
    expect(createGist).not.toHaveBeenCalled();
  });

  it("does not start gh when the owner changes while the shell environment is resolving", async () => {
    let resolveEnv!: (env: Record<string, string>) => void;
    vi.mocked(getSubprocessEnv).mockReturnValue(new Promise((resolve) => (resolveEnv = resolve)));
    let current = true;
    const effects = new OwnerBoundShareEffects();
    const result = effects.run(
      sessionId,
      owner,
      "export-delayed",
      "/tmp/export.html",
      () => current,
    );
    current = false;
    // A missing gh would return the installation error if an OS effect ran.
    resolveEnv({ PATH: "/does-not-exist" });
    await expect(result).resolves.toEqual({
      ok: false,
      error: "Session changed before share creation",
    });
  });

  it("rechecks the owner after gh authentication and before spawning the upload", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-vis-fake-gh-"));
    const gh = path.join(tempDir, "gh");
    const calls = path.join(tempDir, "calls");
    await writeFile(gh, '#!/bin/sh\necho "$1" >> "$CALLS"\nexit 0\n');
    await chmod(gh, 0o755);
    vi.mocked(getSubprocessEnv).mockResolvedValue({ PATH: tempDir, CALLS: calls });
    let ownerChecks = 0;
    await expect(createGistForExport("/tmp/export.html", () => ++ownerChecks < 3)).resolves.toEqual(
      {
        ok: false,
        error: "Session changed before share creation",
      },
    );
    expect(await readFile(calls, "utf8")).toBe("auth\n");
  });

  it("does not replay a lost gist acknowledgement", async () => {
    let resolve!: (value: { ok: true; url: string; gistUrl: string }) => void;
    const createGist = vi.fn(
      () => new Promise<{ ok: true; url: string; gistUrl: string }>((done) => (resolve = done)),
    );
    const effects = new OwnerBoundShareEffects(createGist);
    const first = effects.run(sessionId, owner, "export-1", "/tmp/export.html", () => true);
    const retry = effects.run(sessionId, owner, "export-1", "/tmp/export.html", () => true);
    expect(createGist).toHaveBeenCalledOnce();
    resolve({
      ok: true,
      url: "https://pi.dev/session/#id",
      gistUrl: "https://gist.github.com/u/id",
    });
    await expect(retry).resolves.toEqual(await first);
  });

  it("dedupes only an identical owner-bound export outcome", async () => {
    const createGist = vi.fn(async () => ({
      ok: true as const,
      url: "https://pi.dev/session/#id",
      gistUrl: "https://gist.github.com/u/id",
    }));
    const effects = new OwnerBoundShareEffects(createGist);
    await effects.run(sessionId, owner, "export-1", "/tmp/a.html", () => true);
    await effects.run(sessionId, owner, "export-1", "/tmp/a.html", () => true);
    await expect(
      effects.run(sessionId, owner, "export-1", "/tmp/b.html", () => true),
    ).resolves.toEqual({ ok: false, error: "Export intent was reused with a different path" });
    expect(createGist).toHaveBeenCalledOnce();
  });
});
