import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAL_APP_NAME, isPersonalAppName, resolveAppIdentity } from "./app-identity.js";

const appData = path.join(path.sep, "profiles");

describe("app identity", () => {
  it("selects the personal profile without a shell environment override", () => {
    expect(resolveAppIdentity(PERSONAL_APP_NAME, appData)).toEqual({
      name: PERSONAL_APP_NAME,
      userDataDirectory: path.join(appData, "pi-vis-personal"),
    });
  });

  it("preserves explicit profile overrides for personal builds and isolated tests", () => {
    const override = path.join(appData, "isolated-test");
    expect(resolveAppIdentity(PERSONAL_APP_NAME, appData, override)).toEqual({
      name: PERSONAL_APP_NAME,
      userDataDirectory: override,
    });
    expect(resolveAppIdentity("pi-vis", appData, override)).toEqual({
      name: "Pi-Vis",
      userDataDirectory: override,
    });
  });

  it("leaves the upstream and development profile defaults unchanged", () => {
    for (const name of ["pi-vis", "Pi-Vis", "Electron"]) {
      expect(resolveAppIdentity(name, appData)).toEqual({
        name: "Pi-Vis",
        userDataDirectory: null,
      });
    }
  });

  it("treats an empty override as absent and recognizes only the exact personal identity", () => {
    expect(resolveAppIdentity(PERSONAL_APP_NAME, appData, "").userDataDirectory).toBe(
      path.join(appData, "pi-vis-personal"),
    );
    expect(isPersonalAppName(PERSONAL_APP_NAME)).toBe(true);
    expect(isPersonalAppName("Pi-Vis")).toBe(false);
    expect(isPersonalAppName("pi-vis-personal")).toBe(false);
  });
});
