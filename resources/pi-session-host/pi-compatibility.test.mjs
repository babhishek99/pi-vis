import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateLegacyAzureCredential,
  normalizePiModelPattern,
  normalizePiProviderId,
} from "./pi-compatibility.mjs";

const legacy = {
  type: "api_key",
  key: "fixture-secret",
  env: { AZURE_OPENAI_ENDPOINT: "https://fixture.invalid" },
};
const roots = [];
function fixture(auth) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pivis-azure-"));
  roots.push(root);
  if (auth !== undefined)
    fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify(auth), { mode: 0o640 });
  return root;
}
const read = (root) => JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8"));
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi 1.4 Azure compatibility", () => {
  it("moves the valid legacy account once, preserving unrelated accounts and permissions", async () => {
    const root = fixture({ "azure-openai-responses": legacy, fixture: legacy });
    await expect(migrateLegacyAzureCredential(root)).resolves.toEqual({ changed: true });
    expect(read(root)).toEqual({ azure: legacy, fixture: legacy });
    expect(fs.statSync(path.join(root, "auth.json")).mode & 0o777).toBe(0o640);
    await expect(migrateLegacyAzureCredential(root)).resolves.toEqual({ changed: false });
    expect(fs.readdirSync(root)).toEqual(["auth.json"]);
  });

  it("preserves auth.json symlinks and atomically migrates their original target", async () => {
    const root = fixture();
    const target = path.join(root, "shared", "credentials.json");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ "azure-openai-responses": legacy }), { mode: 0o640 });
    const file = path.join(root, "auth.json");
    fs.symlinkSync(path.join("shared", "credentials.json"), file);
    const original = fs.statSync(target);
    await migrateLegacyAzureCredential(root);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(file)).toBe(path.join("shared", "credentials.json"));
    expect(read(root)).toEqual({ azure: legacy });
    const migrated = fs.statSync(target);
    expect(migrated.mode & 0o777).toBe(0o640);
    expect([migrated.uid, migrated.gid]).toEqual([original.uid, original.gid]);
  });

  it("preserves an already configured Azure account and does not resurrect a logout", async () => {
    const current = { type: "api_key", key: "newer-fixture-secret" };
    const root = fixture({ "azure-openai-responses": legacy, azure: current });
    await migrateLegacyAzureCredential(root);
    expect(read(root)).toEqual({ azure: current });
    fs.writeFileSync(path.join(root, "auth.json"), "{}");
    await expect(migrateLegacyAzureCredential(root)).resolves.toEqual({ changed: false });
    expect(read(root)).toEqual({});
  });

  it("rereads after waiting for Pi's lock and preserves concurrent account changes", async () => {
    const root = fixture({ "azure-openai-responses": legacy });
    const file = path.join(root, "auth.json");
    const release = await lockfile.lock(file, { realpath: false });
    const migration = migrateLegacyAzureCredential(root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const current = { type: "api_key", key: "concurrent-fixture-secret" };
    fs.writeFileSync(
      file,
      JSON.stringify({ "azure-openai-responses": legacy, azure: current, added: legacy }),
    );
    await release();
    await migration;
    expect(read(root)).toEqual({ azure: current, added: legacy });
  });

  it.each(["{ invalid", "[]", '{"azure-openai-responses":{"type":"api_key","key":42}}'])(
    "leaves malformed accounts byte-for-byte unchanged: %s",
    async (text) => {
      const root = fixture({});
      const file = path.join(root, "auth.json");
      fs.writeFileSync(file, text);
      await expect(migrateLegacyAzureCredential(root)).rejects.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      expect(fs.readdirSync(root)).toEqual(["auth.json"]);
    },
  );

  it("does not create a missing auth file or reinterpret other provider/pattern IDs", async () => {
    const root = fixture();
    await expect(migrateLegacyAzureCredential(root)).resolves.toEqual({ changed: false });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(normalizePiProviderId("azure-openai-responses")).toBe("azure");
    expect(normalizePiProviderId("fixture-azure-openai-responses")).toBe(
      "fixture-azure-openai-responses",
    );
    expect(normalizePiModelPattern("azure-openai-responses/deployment:high")).toBe(
      "azure/deployment:high",
    );
    expect(normalizePiModelPattern("fixture/azure-openai-responses/model")).toBe(
      "fixture/azure-openai-responses/model",
    );
  });
});
