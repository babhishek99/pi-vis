import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const GatewayTargetSchema = z
  .object({
    provider: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    baseUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" ||
              (url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
            value.trim() === value &&
            !value.includes("?") &&
            !value.includes("#") &&
            !url.username &&
            !url.password &&
            !/%(?:2f|5c|25|00)/iu.test(url.pathname)
          );
        } catch {
          return false;
        }
      }, "Use credential-free HTTPS (HTTP is allowed only for an explicit IPv4 loopback gateway)"),
  })
  .strict();

/** Private, launch-scoped configuration. Deliberately NOT AppSettings: queries,
 * identity, executable paths and internal URLs never enter renderer IPC. */
export const GatewaySpendConfigSchema = z
  .object({
    version: z.literal(1),
    pupExecutable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => path.isAbsolute(value)),
    auditQuery: z.string().trim().min(1).max(4096),
    userEmail: z
      .string()
      .email()
      .max(254)
      .regex(/^[A-Za-z0-9._+@-]+$/),
    gateways: z.array(GatewayTargetSchema).min(1).max(16),
  })
  .strict();
export type GatewaySpendConfig = z.infer<typeof GatewaySpendConfigSchema>;

export type LoadedGatewaySpendConfig =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "configured"; config: GatewaySpendConfig; fingerprint: string };

export async function readBoundedJson(file: string, maxBytes: number): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid bounded JSON file");
    // Bound the read itself too: a writer can grow a file after fstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Invalid bounded JSON file");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally {
    await handle.close();
  }
}

export async function loadGatewaySpendConfig(directory: string): Promise<LoadedGatewaySpendConfig> {
  try {
    const config = GatewaySpendConfigSchema.parse(
      await readBoundedJson(path.join(directory, "gateway-spend.json"), 32 * 1024),
    );
    const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    return { state: "configured", config, fingerprint };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "invalid" };
  }
}

export function gatewaySpendDataDirectory(directory: string, fingerprint: string): string {
  return path.join(directory, "gateway-spend", "v1", fingerprint);
}
