#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PINNED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PINNED_PI_VERSION = "1.4.0";
export const PINNED_MINIMATCH_VERSION = "10.2.6";
export const PUBLISHED_BRACE_EXPANSION_VERSION = "5.0.9";
export const SAFE_BRACE_EXPANSION_VERSION = "5.0.12";
export const SAFE_UNDICI_VERSION = "8.12.2";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_LOCK_LOCATION = "node_modules/@earendil-works/pi-coding-agent";
const PI_TARBALL =
  "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.4.0.tgz";
const PI_INTEGRITY =
  "sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==";
const MINIMATCH_TARBALL = "https://registry.npmjs.org/minimatch/-/minimatch-10.2.6.tgz";
const MINIMATCH_INTEGRITY =
  "sha512-vpLQEs+VLCr1nU0BXS07maYoFwlDAH0gngQuuttxIwutDFEMHq2blX+8vpgxDdK3J1PwjCJiep77OitTZ4Ll1A==";
const SAFE_BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz";
const SAFE_BRACE_EXPANSION_INTEGRITY =
  "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==";

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${file}.`, { cause: error });
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
  }
}

function requireLockPackage(lock, location, label) {
  const entry = lock?.packages?.[location];
  if (!entry || typeof entry !== "object") {
    throw new Error(`${label} is missing from the root package lock at ${location}.`);
  }
  return entry;
}

function resolveLockedDependency(lock, fromLocation, dependency, label) {
  let ownerLocation = fromLocation;
  const candidates = [];
  while (ownerLocation) {
    const candidate = `${ownerLocation}/node_modules/${dependency}`;
    candidates.push(candidate);
    const nestedAt = ownerLocation.lastIndexOf("/node_modules/");
    if (nestedAt < 0) break;
    ownerLocation = ownerLocation.slice(0, nestedAt);
  }
  candidates.push(`node_modules/${dependency}`);

  for (const location of candidates) {
    const entry = lock?.packages?.[location];
    if (entry && typeof entry === "object") return { entry, location };
  }
  throw new Error(
    `${label} is not reachable in the root package lock; checked ${candidates.join(", ")}.`,
  );
}

function requireProductionLockEntry(entry, label) {
  if (entry.dev === true || entry.optional === true) {
    throw new Error(`${label} must remain reachable as a required production dependency.`);
  }
}

function realpath(file, label) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    throw new Error(`Cannot resolve ${label} at ${file}.`, { cause: error });
  }
}

function requireWithinModulesRoot(file, allowedModulesRoot, label) {
  const resolvedFile = realpath(file, label);
  const relative = path.relative(allowedModulesRoot, resolvedFile);
  if (
    relative !== "" &&
    (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error(
      `${label} escapes the allowed modules root ${allowedModulesRoot}: resolved to ${resolvedFile}.`,
    );
  }
  return resolvedFile;
}

function verifyRootLockPolicy(projectRoot) {
  const manifest = readJson(path.join(projectRoot, "package.json"), "root package manifest");
  const lock = readJson(path.join(projectRoot, "package-lock.json"), "root package lock");

  requireEqual(
    manifest?.dependencies?.[PINNED_PI_PACKAGE],
    PINNED_PI_VERSION,
    `Root ${PINNED_PI_PACKAGE} dependency`,
  );
  requireEqual(
    manifest?.overrides?.[`brace-expansion@${PUBLISHED_BRACE_EXPANSION_VERSION}`],
    SAFE_BRACE_EXPANSION_VERSION,
    "Root vulnerable brace-expansion override",
  );
  requireEqual(
    lock?.packages?.[""]?.dependencies?.[PINNED_PI_PACKAGE],
    PINNED_PI_VERSION,
    `Locked root ${PINNED_PI_PACKAGE} dependency`,
  );

  for (const [requested, safe] of [
    ["8.10.2", SAFE_UNDICI_VERSION],
    ["7.30.0", "7.30.1"],
    ["6.29.0", "6.29.1"],
  ]) {
    requireEqual(
      manifest?.overrides?.[`undici@${requested}`],
      safe,
      `Root undici@${requested} security override`,
    );
  }

  const lockedPi = requireLockPackage(lock, PI_LOCK_LOCATION, `Locked ${PINNED_PI_PACKAGE}`);
  requireEqual(lockedPi.version, PINNED_PI_VERSION, `Locked ${PINNED_PI_PACKAGE} version`);
  requireEqual(lockedPi.resolved, PI_TARBALL, `Locked ${PINNED_PI_PACKAGE} tarball`);
  requireEqual(lockedPi.integrity, PI_INTEGRITY, `Locked ${PINNED_PI_PACKAGE} integrity`);
  requireEqual(
    lockedPi.dependencies?.minimatch,
    PINNED_MINIMATCH_VERSION,
    `Locked ${PINNED_PI_PACKAGE} minimatch dependency`,
  );
  if (Object.hasOwn(lockedPi, "hasShrinkwrap")) {
    throw new Error(
      `Locked ${PINNED_PI_PACKAGE} must omit hasShrinkwrap so the audited root lock remains authoritative.`,
    );
  }

  const { entry: lockedUndici } = resolveLockedDependency(
    lock,
    PI_LOCK_LOCATION,
    "undici",
    "Locked Pi undici",
  );
  requireEqual(lockedUndici.version, SAFE_UNDICI_VERSION, "Locked Pi undici version");
  requireEqual(
    lockedUndici.resolved,
    "https://registry.npmjs.org/undici/-/undici-8.12.2.tgz",
    "Locked Pi undici tarball",
  );
  requireEqual(
    lockedUndici.integrity,
    "sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==",
    "Locked Pi undici integrity",
  );
  requireProductionLockEntry(lockedUndici, "Locked Pi undici");

  const { entry: lockedMinimatch, location: lockedMinimatchLocation } = resolveLockedDependency(
    lock,
    PI_LOCK_LOCATION,
    "minimatch",
    "Locked Pi minimatch",
  );
  requireEqual(lockedMinimatch.version, PINNED_MINIMATCH_VERSION, "Locked Pi minimatch version");
  requireEqual(lockedMinimatch.resolved, MINIMATCH_TARBALL, "Locked Pi minimatch tarball");
  requireEqual(lockedMinimatch.integrity, MINIMATCH_INTEGRITY, "Locked Pi minimatch integrity");
  requireEqual(
    lockedMinimatch.dependencies?.["brace-expansion"],
    "^5.0.8",
    "Locked Pi minimatch brace-expansion range",
  );
  requireProductionLockEntry(lockedMinimatch, "Locked Pi minimatch");

  const { entry: lockedBraceExpansion } = resolveLockedDependency(
    lock,
    lockedMinimatchLocation,
    "brace-expansion",
    "Locked Pi brace-expansion",
  );
  requireEqual(
    lockedBraceExpansion.version,
    SAFE_BRACE_EXPANSION_VERSION,
    "Locked Pi brace-expansion version",
  );
  requireEqual(
    lockedBraceExpansion.resolved,
    SAFE_BRACE_EXPANSION_TARBALL,
    "Locked Pi brace-expansion tarball",
  );
  requireEqual(
    lockedBraceExpansion.integrity,
    SAFE_BRACE_EXPANSION_INTEGRITY,
    "Locked Pi brace-expansion integrity",
  );
  requireProductionLockEntry(lockedBraceExpansion, "Locked Pi brace-expansion");
}

function verifyPublishedPiManifest(piPackageDirectory) {
  // Pi removed its published shrinkwrap in 1.0.1 and pins the safe brace
  // dependency itself. A stale shrinkwrap must never regain authority.
  if (fs.existsSync(path.join(piPackageDirectory, "npm-shrinkwrap.json"))) {
    throw new Error("Published Pi must not contain npm-shrinkwrap.json.");
  }
  const manifest = readJson(path.join(piPackageDirectory, "package.json"), "published Pi manifest");
  requireEqual(
    manifest.dependencies?.["brace-expansion"],
    SAFE_BRACE_EXPANSION_VERSION,
    "Published Pi brace-expansion dependency",
  );
}

export function verifyResolvedPiBraceExpansion({ piPackageDirectory, allowedModulesRoot } = {}) {
  if (!piPackageDirectory) {
    throw new Error("A Pi package directory is required for security-closure verification.");
  }
  if (!allowedModulesRoot) {
    throw new Error("An allowed modules root is required for security-closure verification.");
  }

  const resolvedModulesRoot = realpath(
    path.resolve(allowedModulesRoot),
    "allowed security-closure modules root",
  );

  const piManifestPath = path.join(path.resolve(piPackageDirectory), "package.json");
  const resolvedPiManifestPath = requireWithinModulesRoot(
    piManifestPath,
    resolvedModulesRoot,
    `installed ${PINNED_PI_PACKAGE} manifest`,
  );
  const piManifest = readJson(resolvedPiManifestPath, `installed ${PINNED_PI_PACKAGE} manifest`);
  requireEqual(piManifest.name, PINNED_PI_PACKAGE, "Installed Pi package name");
  requireEqual(piManifest.version, PINNED_PI_VERSION, "Installed Pi package version");
  requireEqual(
    piManifest.dependencies?.minimatch,
    PINNED_MINIMATCH_VERSION,
    "Installed Pi minimatch dependency",
  );

  let minimatchManifestPath;
  try {
    minimatchManifestPath = createRequire(resolvedPiManifestPath).resolve("minimatch/package.json");
  } catch (error) {
    throw new Error(`Cannot resolve minimatch from installed ${PINNED_PI_PACKAGE}.`, {
      cause: error,
    });
  }
  minimatchManifestPath = requireWithinModulesRoot(
    minimatchManifestPath,
    resolvedModulesRoot,
    "Pi-resolved minimatch manifest",
  );
  const minimatchManifest = readJson(minimatchManifestPath, "Pi-resolved minimatch manifest");
  requireEqual(minimatchManifest.name, "minimatch", "Pi-resolved minimatch package name");
  requireEqual(
    minimatchManifest.version,
    PINNED_MINIMATCH_VERSION,
    "Pi-resolved minimatch version",
  );
  requireEqual(
    minimatchManifest.dependencies?.["brace-expansion"],
    "^5.0.8",
    "Pi-resolved minimatch brace-expansion range",
  );

  let braceExpansionManifestPath;
  try {
    braceExpansionManifestPath = createRequire(minimatchManifestPath).resolve(
      "brace-expansion/package.json",
    );
  } catch (error) {
    throw new Error("Cannot resolve brace-expansion from Pi-resolved minimatch.", {
      cause: error,
    });
  }
  braceExpansionManifestPath = requireWithinModulesRoot(
    braceExpansionManifestPath,
    resolvedModulesRoot,
    "Pi/minimatch-resolved brace-expansion manifest",
  );
  const braceExpansionManifest = readJson(
    braceExpansionManifestPath,
    "Pi/minimatch-resolved brace-expansion manifest",
  );
  requireEqual(
    braceExpansionManifest.name,
    "brace-expansion",
    "Pi/minimatch-resolved package name",
  );
  requireEqual(
    braceExpansionManifest.version,
    SAFE_BRACE_EXPANSION_VERSION,
    "Pi/minimatch-resolved brace-expansion version",
  );

  const undiciManifestPath = requireWithinModulesRoot(
    createRequire(resolvedPiManifestPath).resolve("undici/package.json"),
    resolvedModulesRoot,
    "Pi-resolved undici manifest",
  );
  const undiciManifest = readJson(undiciManifestPath, "Pi-resolved undici manifest");
  requireEqual(undiciManifest.name, "undici", "Pi-resolved undici package name");
  requireEqual(undiciManifest.version, SAFE_UNDICI_VERSION, "Pi-resolved undici version");

  return {
    piPackageDirectory,
    minimatchManifestPath,
    minimatchVersion: minimatchManifest.version,
    braceExpansionManifestPath,
    braceExpansionVersion: braceExpansionManifest.version,
    undiciManifestPath,
    undiciVersion: undiciManifest.version,
  };
}

export function verifyInstalledPiSecurityClosure({
  projectRoot = PROJECT_ROOT,
  piPackageDirectory = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
} = {}) {
  verifyRootLockPolicy(projectRoot);
  verifyPublishedPiManifest(piPackageDirectory);
  return verifyResolvedPiBraceExpansion({
    piPackageDirectory,
    allowedModulesRoot: path.join(projectRoot, "node_modules"),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = verifyInstalledPiSecurityClosure();
    console.log(
      `[pi-security-closure] Verified official ${PINNED_PI_PACKAGE}@${PINNED_PI_VERSION} with Pi/minimatch-resolved brace-expansion@${result.braceExpansionVersion}.`,
    );
  } catch (error) {
    console.error(
      `[pi-security-closure] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
