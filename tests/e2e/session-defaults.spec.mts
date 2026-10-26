import fs from "node:fs";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/invariants.mjs";
import {
  type RealSdkLaunch,
  createRealSdkFixture,
  openNewRealSession,
} from "./support/real-sdk-host.mjs";

const ORIGINAL = "pivis-original-model";
const SELECTED = "pivis-selected-model";

async function rename(textarea: Locator, name: string): Promise<void> {
  await textarea.fill(`/name ${name}`);
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
}

async function expectSelection(page: Page, modelName: string, thinking: string): Promise<void> {
  await expect(page.locator(".session-header__model-btn")).toContainText(modelName, {
    timeout: 30_000,
  });
  await expect(
    page.locator(".session-header__thinking > .session-header__picker-btn"),
  ).toContainText(thinking);
}

test("ordinary selections become durable defaults for new sessions and app relaunch", async () => {
  test.setTimeout(90_000);
  const fixture = createRealSdkFixture({
    // No requests are made: both models have inert local credentials, and every
    // session remains empty throughout this settings-only lifecycle journey.
    providerBaseUrl: "http://127.0.0.1:1/v1",
    localModelIds: [ORIGINAL, SELECTED],
    enabledModels: [`pivis-local/${ORIGINAL}:xhigh`, `pivis-local/${SELECTED}:xhigh`],
  });
  const settingsPath = join(fixture.dirs.agent, "settings.json");
  const projectSettingsPath = join(fixture.dirs.workspace, ".pi", "settings.json");
  fs.mkdirSync(join(fixture.dirs.workspace, ".pi"), { recursive: true });
  const projectSettings = {
    defaultProvider: "pivis-local",
    defaultModel: ORIGINAL,
    defaultThinkingLevel: "xhigh",
    enabledModels: [`pivis-local/${ORIGINAL}:xhigh`, `pivis-local/${SELECTED}:xhigh`],
  };
  fs.writeFileSync(projectSettingsPath, JSON.stringify(projectSettings));
  new ProjectTrustStore(fixture.dirs.agent).set(fixture.dirs.workspace, true);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ...settings,
      defaultProvider: "pivis-local",
      defaultModel: ORIGINAL,
      defaultThinkingLevel: "low",
      defaultProjectTrust: "always",
      modelThinkingLevels: {
        [`pivis-local/${ORIGINAL}`]: "xhigh",
        [`pivis-local/${SELECTED}`]: "xhigh",
      },
    }),
  );
  const modelsPath = join(fixture.dirs.agent, "models.json");
  const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  models.providers["pivis-local"].models[0].name = "Original Reasoning Model";
  models.providers["pivis-local"].models[1].name = "Selected Reasoning Model";
  fs.writeFileSync(modelsPath, JSON.stringify(models));

  let launch: RealSdkLaunch | undefined;
  try {
    launch = await fixture.launch();
    let { window } = launch;
    window.setDefaultTimeout(10_000);
    await rename(await openNewRealSession(window), "Original empty session");
    await expectSelection(window, "Original Reasoning Model", "low");

    await rename(await openNewRealSession(window), "Changed empty session");
    const modelButton = window.locator(".session-header__model-btn");
    await modelButton.click();
    const modelSearch = window.locator(".session-header__dropdown-search-input");
    await modelSearch.fill(SELECTED);
    await modelSearch.press("Enter");
    await expectSelection(window, "Selected Reasoning Model", "high");
    const thinking = window.locator(".session-header__thinking");
    await thinking.locator(".session-header__picker-btn").click();
    await thinking.getByRole("option", { name: "medium", exact: true }).click();
    await expectSelection(window, "Selected Reasoning Model", "medium");

    // Simulate older project preferences excluding the selected global model.
    // Fresh hosts must retain the UI choice without rewriting those settings.
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({ ...projectSettings, enabledModels: [`pivis-local/${ORIGINAL}:xhigh`] }),
    );
    await openNewRealSession(window);
    await expectSelection(window, "Selected Reasoning Model", "medium");
    expect(JSON.parse(fs.readFileSync(projectSettingsPath, "utf8")).enabledModels).toEqual([
      `pivis-local/${ORIGINAL}:xhigh`,
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      defaultProvider: "pivis-local",
      defaultModel: SELECTED,
      defaultThinkingLevel: "medium",
    });

    // Slash selections follow the same rule, including same-host /new and a
    // subsequent process relaunch. No prompt is needed to make settings stick.
    const textarea = window.locator(".composer__textarea");
    await textarea.fill(`/model pivis-local/${ORIGINAL}`);
    await textarea.press("Enter");
    await expect(textarea).toHaveValue("");
    await expectSelection(window, "Original Reasoning Model", "high");
    await textarea.fill("/thinking low");
    await textarea.press("Enter");
    await expect(textarea).toHaveValue("");
    await expectSelection(window, "Original Reasoning Model", "low");
    await textarea.fill("/new");
    await textarea.press("Enter");
    await expect(textarea).toHaveValue("");
    await expectSelection(window, "Original Reasoning Model", "low");

    await launch.close();
    launch = await fixture.launch();
    window = launch.window;
    await openNewRealSession(window);
    await expectSelection(window, "Original Reasoning Model", "low");
    await expect(window.locator(".transcript-block--user")).toHaveCount(0);
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\n${launch?.output.join("") ?? ""}`,
    );
  } finally {
    await launch?.close();
    fixture.cleanup();
  }
});
