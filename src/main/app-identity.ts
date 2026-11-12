import path from "node:path";

export const PERSONAL_APP_NAME = "Pi-Vis Personal";

export function isPersonalAppName(name: string): boolean {
  return name === PERSONAL_APP_NAME;
}

/** Resolve the launch profile before diagnostics, windows or instance locks exist. */
export function resolveAppIdentity(
  packagedName: string,
  appDataDirectory: string,
  settingsDirectory?: string,
): { name: string; userDataDirectory: string | null } {
  const personal = isPersonalAppName(packagedName);
  return {
    name: personal ? PERSONAL_APP_NAME : "Pi-Vis",
    userDataDirectory:
      settingsDirectory || (personal ? path.join(appDataDirectory, "pi-vis-personal") : null),
  };
}
