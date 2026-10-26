import { spawn, spawnSync } from "node:child_process";
import type { SessionId } from "@shared/ids.js";
import type { RuntimeIdentity } from "@shared/pi-protocol/runtime-state.js";
import { getSubprocessEnv } from "./auth.js";

export const GH_NOT_INSTALLED_MESSAGE =
  "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/";
export const GH_NOT_LOGGED_IN_MESSAGE = "GitHub CLI is not logged in. Run 'gh auth login' first.";

export function getShareViewerUrl(gistId: string): string {
  const baseUrl = process.env["PI_SHARE_VIEWER_URL"] || "https://pi.dev/session/";
  return `${baseUrl}#${gistId}`;
}

export interface ShareResult {
  ok: true;
  url: string;
  gistUrl: string;
}

export interface ShareError {
  ok: false;
  error: string;
}

/** Owner-fenced, no-replay escrow for the main-only OS effect. */
export class OwnerBoundShareEffects {
  private effects = new Map<
    string,
    { exportedPath: string; result: Promise<ShareResult | ShareError> }
  >();

  constructor(
    private createGist: (
      exportedPath: string,
      isCurrentOwner: () => boolean,
    ) => Promise<ShareResult | ShareError> = createGistForExport,
  ) {}

  run(
    sessionId: SessionId,
    owner: RuntimeIdentity,
    exportIntentId: string,
    exportedPath: string,
    isCurrentOwner: () => boolean,
  ): Promise<ShareResult | ShareError> {
    if (!isCurrentOwner())
      return Promise.resolve({ ok: false, error: "Session changed before share creation" });
    if (!exportedPath || !exportIntentId)
      return Promise.resolve({ ok: false, error: "Missing authoritative export outcome" });
    const key = `${sessionId}\0${owner.hostInstanceId}\0${owner.sessionEpoch}\0${exportIntentId}`;
    const existing = this.effects.get(key);
    if (existing) {
      if (existing.exportedPath !== exportedPath)
        return Promise.resolve({
          ok: false,
          error: "Export intent was reused with a different path",
        });
      return existing.result;
    }
    const result = this.createGist(exportedPath, isCurrentOwner);
    this.effects.set(key, { exportedPath, result });
    return result;
  }
}

/**
 * Performs only the OS-facing half of sharing. The caller must first receive
 * the exported path in the child authority frame; this function never routes
 * a command to Pi or infers an export result.
 */
export async function createGistForExport(
  exportedPath: string,
  isCurrentOwner: () => boolean = () => true,
): Promise<ShareResult | ShareError> {
  const staleOwner = (): ShareError => ({
    ok: false,
    error: "Session changed before share creation",
  });
  if (!isCurrentOwner()) return staleOwner();
  const env = await getSubprocessEnv();
  if (!isCurrentOwner()) return staleOwner();
  try {
    const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8", env });
    const errCode = (authResult.error as NodeJS.ErrnoException | undefined)?.code;
    if (errCode === "ENOENT" || authResult.status === null)
      return { ok: false, error: GH_NOT_INSTALLED_MESSAGE };
    if (authResult.status !== 0) return { ok: false, error: GH_NOT_LOGGED_IN_MESSAGE };
  } catch {
    return { ok: false, error: GH_NOT_INSTALLED_MESSAGE };
  }
  if (!isCurrentOwner()) return staleOwner();

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve) => {
      if (!isCurrentOwner()) {
        resolve({ stdout: "", stderr: "Session changed before share creation", code: null });
        return;
      }
      let stdout = "";
      let stderr = "";
      const proc = spawn("gh", ["gist", "create", "--public=false", exportedPath], { env });
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => resolve({ stdout, stderr, code }));
      proc.on("error", (error) => resolve({ stdout: "", stderr: error.message, code: null }));
    },
  );
  if (result.code !== 0)
    return {
      ok: false,
      error: `Failed to create gist: ${result.stderr.trim() || "Unknown error"}`,
    };

  const gistUrl = result.stdout.trim();
  const gistId = gistUrl.split("/").pop();
  if (!gistId) return { ok: false, error: "Failed to parse gist ID from gh output" };
  return { ok: true, url: getShareViewerUrl(gistId), gistUrl };
}
