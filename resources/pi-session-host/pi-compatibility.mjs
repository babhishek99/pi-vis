/** App-owned migration for Pi's renamed Azure provider; no private SDK imports. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
export const AZURE_PROVIDER = "azure";

export function normalizePiProviderId(provider) {
  return provider === LEGACY_AZURE_PROVIDER ? AZURE_PROVIDER : provider;
}

export function normalizePiModelPattern(pattern) {
  const prefix = `${LEGACY_AZURE_PROVIDER}/`;
  return typeof pattern === "string" && pattern.startsWith(prefix)
    ? `${AZURE_PROVIDER}/${pattern.slice(prefix.length)}`
    : pattern;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAuth(authPath) {
  const text = fs.readFileSync(authPath, "utf8");
  const auth = JSON.parse(text.replace(/^\uFEFF/u, ""));
  if (!isRecord(auth)) throw new Error("Invalid global account configuration");
  return { auth, text };
}

function isAzureCredential(value) {
  return (
    isRecord(value) &&
    value.type === "api_key" &&
    (value.key === undefined || typeof value.key === "string") &&
    (value.env === undefined ||
      (isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string")))
  );
}

/**
 * Move the retired global credential once, under the same lock Pi uses.
 * A concurrently configured new account wins. Removing the retired key in the
 * same commit prevents a later logout from resurrecting it on the next spawn.
 * No credential values cross IPC, and no project file is read or written.
 */
export async function migrateLegacyAzureCredential(agentDir) {
  const authPath = path.join(agentDir, "auth.json");
  if (!fs.existsSync(authPath)) return { changed: false };
  const initial = readAuth(authPath);
  if (!Object.hasOwn(initial.auth, LEGACY_AZURE_PROVIDER)) return { changed: false };

  const release = await lockfile.lock(authPath, {
    lockfilePath: `${authPath}.lock`,
    realpath: false,
    retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
  });
  let temporaryPath;
  let descriptor;
  try {
    // Preserve a user-managed auth.json symlink; commit beside its target.
    const writePath = fs.realpathSync(authPath);
    const { auth, text } = readAuth(writePath);
    if (!Object.hasOwn(auth, LEGACY_AZURE_PROVIDER)) return { changed: false };
    if (!isAzureCredential(auth[LEGACY_AZURE_PROVIDER]))
      throw new Error("Invalid legacy Azure account configuration");
    if (!Object.hasOwn(auth, AZURE_PROVIDER)) auth[AZURE_PROVIDER] = auth[LEGACY_AZURE_PROVIDER];
    delete auth[LEGACY_AZURE_PROVIDER];
    const existing = fs.statSync(writePath);
    if (!existing.isFile()) throw new Error("Global account configuration is not a file");
    const mode = existing.mode & 0o777;
    const indent = /^([ \t]+)\S/m.exec(text)?.[1] || "  ";
    temporaryPath = path.join(
      path.dirname(writePath),
      `.auth.json.tmp-${process.pid}-${randomUUID()}`,
    );
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    const temporary = fs.fstatSync(descriptor);
    if (temporary.uid !== existing.uid || temporary.gid !== existing.gid)
      fs.fchownSync(descriptor, existing.uid, existing.gid);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(auth, null, indent)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.realpathSync(authPath) !== writePath)
      throw new Error("Global account configuration changed during migration");
    fs.renameSync(temporaryPath, writePath);
    temporaryPath = undefined;
    try {
      const directory = fs.openSync(path.dirname(writePath), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      /* Directory fsync is unavailable on some filesystems. */
    }
    return { changed: true };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryPath !== undefined) fs.rmSync(temporaryPath, { force: true });
    await release().catch(() => {});
  }
}
