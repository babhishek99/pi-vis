import { expect, test } from "@playwright/test";

test("share consumes the authoritative Radius URL without running the gist effect", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __pivisStore?: { getState(): { activeSessionId?: string } } }
      ).__pivisStore?.getState().activeSessionId,
  );
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const target = window as unknown as {
      pivis: { invoke(channel: string, payload: unknown): Promise<unknown> };
      __shareEffects: string[];
      __shareClipboard: string[];
    };
    target.__shareEffects = [];
    target.__shareClipboard = [];
    const original = target.pivis.invoke.bind(target.pivis);
    target.pivis.invoke = (channel, payload) => {
      if (channel === "session.share") target.__shareEffects.push(channel);
      if (channel === "clipboard.writeText")
        target.__shareClipboard.push((payload as { text: string }).text);
      return original(channel, payload);
    };
  });
  const composer = page.locator(".composer__textarea");
  await composer.fill("/share");
  await composer.press("Escape");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText("Share URL: https://radius.pi.dev/artifact/preview", { exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(() => {
    const target = window as unknown as { __shareEffects: string[]; __shareClipboard: string[] };
    return { effects: target.__shareEffects, clipboard: target.__shareClipboard };
  });
  expect(result.effects).toEqual([]);
  expect(result.clipboard).toEqual(["https://radius.pi.dev/artifact/preview"]);
});
