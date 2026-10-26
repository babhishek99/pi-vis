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

test("real Pi tool renderer resolvers render canonical calls and results through owner-bound reads", async () => {
  test.setTimeout(120_000);
  const provider = await createScriptedOpenAIProvider(
    [
      {
        expect: { promptIncludes: "read the renderer fixture", compaction: false },
        response: {
          type: "tool_call",
          name: "read",
          id: "call_custom_renderer",
          argumentChunks: ['{"path":"renderer.txt"}'],
        },
      },
      {
        expect: { promptIncludes: "NATIVE TOOL OUTPUT", compaction: false },
        response: { type: "text", chunks: ["TOOL RENDERER COMPLETE"] },
      },
    ],
    { latency: REAL_SDK_PROVIDER_LATENCY },
  );
  const fixture = createRealSdkFixture({
    providerBaseUrl: provider.baseUrl,
    extensionFiles: [join(here, "../fixtures/tool-renderer-extension.ts")],
  });
  fs.writeFileSync(join(fixture.dirs.workspace, "renderer.txt"), "NATIVE TOOL OUTPUT");
  let launch: Awaited<ReturnType<typeof fixture.launch>> | undefined;
  try {
    launch = await fixture.launch();
    const textarea = await openNewRealSession(launch.window);
    await selectLocalTestModel(launch.window, textarea);
    await textarea.fill("read the renderer fixture");
    await textarea.press("Enter");
    await expect(launch.window.getByText("TOOL RENDERER COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const card = launch.window.locator(".tool-card").filter({ hasText: "renderer.txt" });
    await card.locator(".tool-card__header").click();
    await expect(card.getByText(/CUSTOM READ CALL renderer\.txt \(\d+ cols\)/)).toBeVisible();
    await expect(
      card.getByText("CUSTOM READ RESULT NATIVE TOOL OUTPUT", { exact: false }),
    ).toBeVisible();
    await expect(card.getByText("SHARED STATE PRESERVED", { exact: false })).toBeVisible();
    await expect(card.getByText("DURATION KNOWN", { exact: false })).toBeVisible();
    await expect(card.getByText("LAST COMPONENT REUSED", { exact: false })).toBeVisible();
    await expect(card).toContainText("NATIVE TOOL OUTPUT");

    await textarea.fill("/reload");
    await textarea.press("Escape");
    await textarea.press("Enter");
    await expect(textarea).toHaveValue("");
    await expect(
      card.getByText("CUSTOM READ RESULT NATIVE TOOL OUTPUT", { exact: false }),
    ).toBeVisible();
    await expect(card.getByText("SHARED STATE PRESERVED", { exact: false })).toBeVisible();
    await expect(card.getByText("LAST COMPONENT REUSED", { exact: false })).toBeVisible();
    provider.assertExhausted();
    expect(provider.requests).toHaveLength(2);
    const persisted = fixture
      .sessionFiles()
      .map((path) => fs.readFileSync(path, "utf8"))
      .join("\n");
    expect(persisted).toContain("NATIVE TOOL OUTPUT");
    expect(persisted).not.toContain("CUSTOM READ RESULT");
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
