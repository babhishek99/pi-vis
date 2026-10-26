import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./support/invariants.mjs";
import {
  REAL_SDK_PROVIDER_LATENCY,
  createRealSdkFixture,
  openNewRealSession,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import { createScriptedOpenAIProvider } from "./support/scripted-openai-provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("real Pi /share uploads the selected branch to Radius through public settings and auth", async () => {
  test.setTimeout(120_000);
  const provider = await createScriptedOpenAIProvider(
    [
      {
        expect: { promptIncludes: "share this selected branch", compaction: false },
        response: { type: "text", chunks: ["SELECTED BRANCH READY"] },
      },
    ],
    { latency: REAL_SDK_PROVIDER_LATENCY },
  );
  const fixture = createRealSdkFixture({
    providerBaseUrl: provider.baseUrl,
    extensionFiles: [join(here, "../fixtures/session-share-extension.ts")],
  });
  const settingsPath = join(fixture.dirs.agent, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(settingsPath, "utf8")),
      sessionShareDestination: "radius",
    }),
  );
  fs.writeFileSync(
    join(fixture.dirs.agent, "auth.json"),
    JSON.stringify({
      radius: { type: "api_key", key: "offline-radius-fixture-token" },
    }),
  );
  let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
  try {
    launch = await fixture.launch();
    const textarea = await openNewRealSession(launch.window);
    await selectLocalTestModel(launch.window, textarea);
    await textarea.fill("share this selected branch");
    await textarea.press("Enter");
    await expect(launch.window.getByText("SELECTED BRANCH READY", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await textarea.fill("/share");
    await textarea.press("Escape");
    await textarea.press("Enter");
    await expect(textarea).toHaveValue("");
    await expect(
      launch.window.getByText("Share URL: https://radius.pi.dev/artifact/real-sdk-fixture", {
        exact: true,
      }),
    ).toBeVisible();
    const uploaded = JSON.parse(
      fs.readFileSync(join(fixture.dirs.agent, "share-upload.json"), "utf8"),
    );
    expect(uploaded.method).toBe("POST");
    expect(uploaded.url).toBe(
      "https://radius.pi.dev/v1/artifacts?visibility=organization&title=Pi+session",
    );
    expect(uploaded.headers.Authorization).toBe("Bearer offline-radius-fixture-token");
    expect(uploaded.body).toContain("share this selected branch");
    expect(uploaded.body).toContain("SELECTED BRANCH READY");
    const entries = uploaded.body
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({
      type: "custom",
      customType: "pi.share",
      data: { tools: expect.any(Array), systemPrompt: expect.any(String) },
    });
    expect(uploaded.body).not.toContain("offline-radius-fixture-token");
    const persisted = fixture
      .sessionFiles()
      .map((path) => fs.readFileSync(path, "utf8"))
      .join("\n");
    expect(persisted).not.toContain('"customType":"pi.share"');
    expect(persisted).not.toContain("offline-radius-fixture-token");
    provider.assertExhausted();
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\n${launch?.output.join("") ?? ""}`,
    );
  } finally {
    await launch?.close();
    await provider.close();
    fixture.cleanup();
  }
});
