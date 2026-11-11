import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import type { PivisAPI } from "../../src/preload/index.js";
import type { RendererPublication } from "../../src/shared/pi-protocol/runtime-state.js";
import { expect, test } from "./support/invariants.mjs";
import {
  PROJECT_ROOT,
  type RealSdkLaunch,
  assertValidSessionJsonl,
  createRealSdkFixture,
  openNewRealSession,
  parseSessionEntries,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import {
  type ScriptedOpenAIStep,
  createScriptedOpenAIProvider,
} from "./support/scripted-openai-provider.mjs";

type SemanticPublication = Extract<RendererPublication, { plane: "semantic" }>;
type ObservedWindow = { pivis: PivisAPI; __tabStopFrames: SemanticPublication[] };
type Entered = { sdkSessionId: string; sessionFile: string };
type Trace = {
  phase: string;
  sdkSessionId: string;
  parentAborted?: boolean;
  label?: string;
  reply?: { success: boolean; data?: { agents: number; workflows: number } };
};
const here = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = process.env["PIVIS_TEST_SUBAGENTS_SOURCE_DIR"];
const labels = [
  "STOP-A-CHILD-1",
  "STOP-A-CHILD-2",
  "STOP-A-WORKFLOW-OUTER",
  "STOP-A-GRANDCHILD",
  "STOP-B-CHILD",
  "STOP-B-IDLE",
  "STOP-A-FRESH",
];

function agent(
  prompt: string,
  extra: Record<string, unknown> = {},
): ScriptedOpenAIStep["response"] {
  return {
    type: "tool_call",
    name: "Agent",
    argumentChunks: [
      JSON.stringify({
        prompt,
        description: prompt,
        subagent_type: "general-purpose",
        run_in_background: true,
        ...extra,
      }),
    ],
  };
}

async function snapshot(page: Page, name: string) {
  return page.evaluate(
    (root) =>
      (window as unknown as ObservedWindow).__tabStopFrames
        .filter((frame) => frame.payload.terminalSnapshot.sessionName === root)
        .at(-1)?.payload.terminalSnapshot,
    name,
  );
}

async function send(textarea: Locator, text: string): Promise<void> {
  await textarea.fill(text);
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
}

/** Opt-in source integration: never reads or updates an installed extension. */
test("bare Escape stops the current tab's real subagents and workflow, not another tab", async () => {
  test.skip(
    !sourceDirectory,
    "Set PIVIS_TEST_SUBAGENTS_SOURCE_DIR to the protocol-3 source checkout",
  );
  test.setTimeout(240_000);
  const source = fs.realpathSync(resolve(sourceDirectory!));
  const manifest = JSON.parse(fs.readFileSync(join(source, "package.json"), "utf8"));
  expect(manifest.name).toBe("@tintinweb/pi-subagents");
  expect(fs.existsSync(join(source, ".git")), "a checkout, never the installed npm extension").toBe(
    true,
  );
  expect(fs.readFileSync(join(source, "src/cross-extension-rpc.ts"), "utf8")).toContain(
    "PROTOCOL_VERSION = 3",
  );
  const workflow = `export const meta = { name: "tab-stop", description: "Bounded cancellation fixture" };\nawait agent("STOP-A-WORKFLOW-OUTER", { label: "outer", agentType: "fixture-delegator" });\nawait agent("MUST-NOT-START-AFTER-STOP");\nreturn "late workflow result";\n`;
  const provider = await createScriptedOpenAIProvider([
    {
      expect: { promptIncludes: "BEGIN-B", toolNames: ["Agent"] },
      response: agent("STOP-B-CHILD"),
    },
    {
      expect: { promptIncludes: "BEGIN-B" },
      response: {
        type: "text",
        chunks: ["B parent streaming", "B PARENT SURVIVED"],
        afterFirstChunkGate: "B-parent",
      },
    },
    {
      expect: { promptIncludes: "BEGIN-A", toolNames: ["SubagentWorkflow"] },
      response: {
        type: "tool_call",
        name: "SubagentWorkflow",
        argumentChunks: [JSON.stringify({ script: workflow })],
      },
    },
    { expect: { promptIncludes: "BEGIN-A" }, response: agent("STOP-A-CHILD-1") },
    { expect: { promptIncludes: "BEGIN-A" }, response: agent("STOP-A-CHILD-2") },
    {
      expect: { promptIncludes: "BEGIN-A" },
      response: agent("FUTURE-SCHEDULE", { name: "future-repeat", schedule: "1h" }),
    },
    {
      expect: { promptIncludes: "BEGIN-A" },
      response: {
        type: "text",
        chunks: ["A parent streaming", "MUST-NOT-COMPLETE-A"],
        afterFirstChunkGate: "A-parent",
      },
    },
    {
      expect: { promptIncludes: "STOP-A-WORKFLOW-OUTER", toolNames: ["Agent"] },
      response: agent("STOP-A-GRANDCHILD", { run_in_background: false }),
    },
    {
      expect: { promptIncludes: "STOP-B-CHILD" },
      response: { type: "text", chunks: ["B CHILD SURVIVED"] },
    },
    { expect: { promptIncludes: "FRESH-A-REQUEST" }, response: agent("STOP-A-FRESH") },
    {
      expect: { promptIncludes: "FRESH-A-REQUEST" },
      response: { type: "text", chunks: ["FRESH A PARENT OK"] },
    },
    {
      expect: { promptIncludes: "STOP-A-FRESH" },
      response: { type: "text", chunks: ["FRESH A CHILD OK"] },
    },
  ]);
  const fixture = createRealSdkFixture({
    providerBaseUrl: provider.baseUrl,
    extensionFiles: [join(here, "../fixtures/tab-stop-extension/probe.ts")],
    defaultTools: [],
  });
  const gateDirectory = join(fixture.dirs.workspace, ".tab-stop-fixture");
  const extension = join(fixture.dirs.agent, "extensions/pi-subagents");
  let launch: RealSdkLaunch | undefined;
  const entered = (label: string): Entered =>
    JSON.parse(fs.readFileSync(join(gateDirectory, `${label}.entered.json`), "utf8"));
  const release = (label: string) => fs.writeFileSync(join(gateDirectory, `${label}.release`), "");
  const traces = (): Trace[] =>
    fs.existsSync(join(gateDirectory, "events.jsonl"))
      ? fs
          .readFileSync(join(gateDirectory, "events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Trace)
      : [];
  const waitEntered = async (label: string) => {
    await expect
      .poll(() => fs.existsSync(join(gateDirectory, `${label}.entered.json`)), { timeout: 60_000 })
      .toBe(true);
    return entered(label);
  };
  const waitSettled = async (target: Entered) => {
    await expect
      .poll(
        () =>
          traces().some(
            (entry) => entry.phase === "settled" && entry.sdkSessionId === target.sdkSessionId,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  };
  try {
    // Copy only the explicit checkout's production source and runtime deps.
    // Public Pi/TypeBox peers resolve through the pristine app's pinned SDK.
    fs.mkdirSync(extension, { recursive: true });
    fs.cpSync(join(source, "src"), join(extension, "src"), { recursive: true });
    fs.writeFileSync(join(extension, "index.ts"), 'export { default } from "./src/index.ts";\n');
    fs.writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: "module",
        pi: { extensions: ["./index.ts"] },
      }),
    );
    for (const dependency of ["croner", "nanoid"]) {
      fs.cpSync(
        join(source, "node_modules", dependency),
        join(extension, "node_modules", dependency),
        { recursive: true },
      );
    }
    fs.cpSync(join(PROJECT_ROOT, "node_modules/typebox"), join(extension, "node_modules/typebox"), {
      recursive: true,
    });
    fs.writeFileSync(
      join(fixture.dirs.agent, "subagents.json"),
      JSON.stringify({
        schedulingEnabled: true,
        workflowsEnabled: true,
        maxConcurrent: 1,
        maxConcurrentForeground: 1,
        maxSubagentDepth: 2,
        fleetView: false,
        widgetMode: "off",
        rememberAgents: true,
        outputTranscript: false,
      }),
    );
    fs.mkdirSync(join(fixture.dirs.agent, "agents"), { recursive: true });
    fs.writeFileSync(
      join(fixture.dirs.agent, "agents/fixture-delegator.md"),
      "---\ndescription: Fixture-only nested delegation\ntools: read\nallowed_subagents: general-purpose\n---\nDelegate the synthetic child task.\n",
    );
    launch = await fixture.launch();
    const page = launch.window;
    await page.evaluate(() => {
      const observed = window as unknown as ObservedWindow;
      observed.__tabStopFrames = [];
      observed.pivis.on("session.publication", (publication) => {
        if (publication.plane === "semantic") observed.__tabStopFrames.push(publication);
      });
    });

    const bInput = await openNewRealSession(page);
    await selectLocalTestModel(page, bInput);
    await send(bInput, "BEGIN-B");
    const bChild = await waitEntered("STOP-B-CHILD");
    const bRoot = await waitEntered("STOP-ROOT-B");
    await provider.waitForRequestCount(2);
    await expect(page.getByText("B parent streaming", { exact: true })).toBeVisible();
    const bBefore = await snapshot(page, "STOP-ROOT-B");
    expect(bBefore?.sdk.isStreaming).toBe(true);

    const aInput = await openNewRealSession(page);
    await send(aInput, "BEGIN-A");
    const aRoot = await waitEntered("STOP-ROOT-A");
    const aChild = await waitEntered("STOP-A-CHILD-1");
    const aOuter = await waitEntered("STOP-A-WORKFLOW-OUTER");
    await provider.waitForRequestCount(7);
    await expect(page.getByText("A parent streaming", { exact: true })).toBeVisible();
    release("STOP-A-WORKFLOW-OUTER");
    const aGrandchild = await waitEntered("STOP-A-GRANDCHILD");
    expect(fs.existsSync(join(gateDirectory, "STOP-A-CHILD-2.entered.json"))).toBe(false);
    const aBefore = await snapshot(page, "STOP-ROOT-A");
    expect(aBefore?.sdk.isStreaming).toBe(true);
    const schedulePath = join(
      fixture.dirs.workspace,
      ".pi/subagent-schedules",
      `${aRoot.sdkSessionId}.json`,
    );
    const schedulesBefore = fs.readFileSync(schedulePath);
    expect(JSON.parse(schedulesBefore.toString()).jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "FUTURE-SCHEDULE", enabled: true })]),
    );

    // Native unclaimed Escape traverses capture hook → store → main → real
    // host authority → this tab's real bound extension, never a test stop API.
    await aInput.focus();
    await page.keyboard.press("Escape");
    await expect
      .poll(
        () =>
          traces().find(
            (entry) => entry.phase === "stop-reply" && entry.sdkSessionId === aRoot.sdkSessionId,
          )?.reply,
        { timeout: 30_000 },
      )
      .toMatchObject({ success: true, data: { agents: 4, workflows: 1 } });
    expect(
      traces().find(
        (entry) => entry.phase === "stop-seen" && entry.sdkSessionId === aRoot.sdkSessionId,
      )?.parentAborted,
    ).toBe(true);
    expect(
      traces().some(
        (entry) => entry.phase === "stop-seen" && entry.sdkSessionId === bRoot.sdkSessionId,
      ),
    ).toBe(false);
    expect(fs.readFileSync(schedulePath)).toEqual(schedulesBefore);
    for (const label of ["STOP-A-CHILD-1", "STOP-A-CHILD-2", "STOP-A-GRANDCHILD"]) release(label);
    provider.releaseGate("A-parent");
    for (const target of [aChild, aOuter, aGrandchild]) await waitSettled(target);
    await expect.poll(async () => (await snapshot(page, "STOP-ROOT-A"))?.sdk.isIdle).toBe(true);
    expect(provider.requests).toHaveLength(8);
    expect(JSON.stringify(parseSessionEntries(aRoot.sessionFile))).not.toContain(
      "MUST-NOT-COMPLETE-A",
    );
    expect(fs.existsSync(join(gateDirectory, "STOP-A-CHILD-2.entered.json"))).toBe(false);

    // The other tab's already-streaming parent and background child both
    // complete after A's stop, under their original live owner.
    provider.releaseGate("B-parent");
    await expect.poll(async () => (await snapshot(page, "STOP-ROOT-B"))?.sdk.isIdle).toBe(true);
    release("STOP-B-CHILD");
    await waitSettled(bChild);
    expect(JSON.stringify(parseSessionEntries(bRoot.sessionFile))).toContain("B PARENT SURVIVED");
    expect(JSON.stringify(parseSessionEntries(bChild.sessionFile))).toContain("B CHILD SURVIVED");
    expect((await snapshot(page, "STOP-ROOT-B"))?.owner).toEqual(bBefore?.owner);

    // Idle parents must not be a renderer-side cancellation no-op.
    const bRow = page.locator(
      `.sidebar__session[data-session-file=${JSON.stringify(bRoot.sessionFile)}]`,
    );
    await bRow.click();
    const input = page.locator(".composer__textarea");
    await expect(page.locator(".composer__attach-btn")).toBeEnabled();
    await send(input, "/tab-stop-fixture-idle");
    const idleChild = await waitEntered("STOP-B-IDLE");
    await expect.poll(async () => (await snapshot(page, "STOP-ROOT-B"))?.sdk.isIdle).toBe(true);
    await input.focus();
    await page.keyboard.press("Escape");
    await expect
      .poll(
        () =>
          traces().find(
            (entry) => entry.phase === "stop-reply" && entry.sdkSessionId === bRoot.sdkSessionId,
          )?.reply,
      )
      .toMatchObject({ success: true, data: { agents: 1, workflows: 0 } });
    release("STOP-B-IDLE");
    await waitSettled(idleChild);
    expect(provider.requests).toHaveLength(9);

    // New explicit work after Escape remains possible without reset/rebind.
    await page
      .locator(`.sidebar__session[data-session-file=${JSON.stringify(aRoot.sessionFile)}]`)
      .click();
    await expect(page.locator(".composer__attach-btn")).toBeEnabled();
    await send(page.locator(".composer__textarea"), "FRESH-A-REQUEST");
    const fresh = await waitEntered("STOP-A-FRESH");
    await provider.waitForRequestCount(11);
    await expect(page.getByText("FRESH A PARENT OK", { exact: true })).toBeVisible();
    release("STOP-A-FRESH");
    await waitSettled(fresh);
    expect(JSON.stringify(parseSessionEntries(fresh.sessionFile))).toContain("FRESH A CHILD OK");
    expect((await snapshot(page, "STOP-ROOT-A"))?.owner).toEqual(aBefore?.owner);
    expect(fs.readFileSync(schedulePath)).toEqual(schedulesBefore);
    expect(provider.requests).toHaveLength(12);
    expect(provider.unexpectedRequests).toEqual([]);
    provider.assertExhausted();
    assertValidSessionJsonl(fixture.sessionFiles());
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nFixture trace:\n${JSON.stringify(traces())}\nProvider requests:\n${JSON.stringify(
        provider.requests.map((request, index) => {
          const body = request.body as {
            model?: string;
            messages?: Array<{ role: string; content: unknown }>;
            tools?: Array<{ function?: { name?: string } }>;
          };
          return {
            index,
            model: body.model,
            messages: body.messages?.filter((message) => message.role !== "system"),
            tools: body.tools?.map((tool) => tool.function?.name),
          };
        }),
        null,
        2,
      )}`,
    );
  } finally {
    fs.mkdirSync(gateDirectory, { recursive: true });
    for (const label of labels) release(label);
    provider.releaseGate("A-parent");
    provider.releaseGate("B-parent");
    await launch?.close();
    await provider.close();
    fixture.cleanup();
  }
});
