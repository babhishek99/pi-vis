import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewaySpendConfigSchema, loadGatewaySpendConfig, readBoundedJson } from "./config.js";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pivis-spend-config-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const config = {
  version: 1,
  pupExecutable: process.execPath,
  auditQuery: 'service:gateway "audit trail message"',
  userEmail: "person@example.test",
  gateways: [
    {
      provider: "fixture-gateway",
      baseUrl: "https://gateway.example.test/api/v2/providers/openai/v1",
    },
  ],
};

describe("private gateway configuration", () => {
  it("distinguishes missing, malformed and configured, with identity-scoped fingerprint", async () => {
    const dir = await temporary();
    expect(await loadGatewaySpendConfig(dir)).toEqual({ state: "absent" });
    await writeFile(path.join(dir, "gateway-spend.json"), "not json");
    expect(await loadGatewaySpendConfig(dir)).toEqual({ state: "invalid" });
    await writeFile(path.join(dir, "gateway-spend.json"), JSON.stringify(config));
    const first = await loadGatewaySpendConfig(dir);
    expect(first).toMatchObject({ state: "configured", config });
    await writeFile(
      path.join(dir, "gateway-spend.json"),
      JSON.stringify({ ...config, userEmail: "another@example.test" }),
    );
    const second = await loadGatewaySpendConfig(dir);
    if (first.state !== "configured" || second.state !== "configured")
      throw new Error("Expected configured fixture");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("rejects non-absolute commands, injected identities and credentialed/insecure URLs", () => {
    for (const changes of [
      { pupExecutable: "pup" },
      { userEmail: 'person@example.test" OR *' },
      { gateways: [{ provider: "gateway", baseUrl: "http://remote.example.test/v1" }] },
      {
        gateways: [
          { provider: "gateway", baseUrl: "https://user:password@gateway.example.test/v1" },
        ],
      },
      {
        gateways: [{ provider: "gateway", baseUrl: "https://gateway.example.test/v1?key=secret" }],
      },
      { gateways: [{ provider: "gateway", baseUrl: "http://localhost:1234/v1" }] },
      { gateways: [{ provider: "gateway", baseUrl: "http://[::1]:1234/v1" }] },
      { gateways: [{ provider: "gateway", baseUrl: "https://gateway.example.test/v1?" }] },
      { gateways: [{ provider: "gateway", baseUrl: "https://gateway.example.test/v1#" }] },
      { gateways: [{ provider: "gateway", baseUrl: "https://gateway.example.test/v1%2fother" }] },
      { gateways: [] },
    ])
      expect(
        GatewaySpendConfigSchema.safeParse({ ...config, ...changes }).success,
        JSON.stringify(changes),
      ).toBe(false);
    expect(
      GatewaySpendConfigSchema.safeParse({
        ...config,
        gateways: [{ provider: "local", baseUrl: "http://127.0.0.1:12345/v1" }],
      }).success,
    ).toBe(true);
  });

  it("bounds configuration and cache reads without accepting directories", async () => {
    const dir = await temporary();
    const file = path.join(dir, "large.json");
    await writeFile(file, JSON.stringify("x".repeat(100)));
    await expect(readBoundedJson(file, 32)).rejects.toThrow();
    await expect(readBoundedJson(dir, 32)).rejects.toThrow();
  });
});
