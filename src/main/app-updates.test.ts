import { app, autoUpdater } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getName: vi.fn(() => "Pi-Vis"),
    getVersion: () => "0.3.3",
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

describe("app updates", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(app.getName).mockReturnValue("Pi-Vis");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PIVIS_DISABLE_APP_UPDATES", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the update.electronjs.org feed with platform and arch", async () => {
    const { buildAppUpdateFeedUrl } = await import("./app-updates.js");
    expect(
      buildAppUpdateFeedUrl({
        owner: "rsingapuri",
        repo: "pi-vis",
        platform: "darwin",
        arch: "arm64",
        version: "0.3.3",
      }),
    ).toBe("https://update.electronjs.org/rsingapuri/pi-vis/darwin-arm64/0.3.3");
  });

  it("does not overlap app-updater checks while one is in progress", async () => {
    const { checkForAppUpdate, initAppUpdates } = await import("./app-updates.js");
    initAppUpdates(() => {});
    checkForAppUpdate();
    checkForAppUpdate();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(autoUpdater.setFeedURL).toHaveBeenCalledOnce();
  });

  it("permanently disables personal-build checks and installs, even with a feed override", async () => {
    vi.mocked(app.getName).mockReturnValue("Pi-Vis Personal");
    vi.stubEnv("PIVIS_APP_UPDATE_FEED_URL", "https://updates.example.invalid/custom");
    const { checkForAppUpdate, getAppUpdateStatus, initAppUpdates, installAppUpdate } =
      await import("./app-updates.js");
    initAppUpdates(() => {});

    expect(getAppUpdateStatus()).toMatchObject({ state: "disabled" });
    expect(checkForAppUpdate()).toMatchObject({ state: "disabled" });
    expect(installAppUpdate()).toMatchObject({ state: "disabled" });
    expect(getAppUpdateStatus().feedUrl).toBeUndefined();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("retains the explicit disable switch for ordinary builds", async () => {
    vi.stubEnv("PIVIS_DISABLE_APP_UPDATES", "1");
    const { checkForAppUpdate, initAppUpdates, installAppUpdate } = await import(
      "./app-updates.js"
    );
    initAppUpdates(() => {});

    expect(checkForAppUpdate().state).toBe("disabled");
    expect(installAppUpdate().state).toBe("disabled");
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
