import { expect, test } from "@playwright/test";
import path from "node:path";

/** Exercise the production editor through the selected parser: a real local
 * replay for all-mode, or a synthetic intercepted legacy response otherwise. */
test("phone build editor keeps private notes and rule controls inside its modal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "the touch-size viewport is set explicitly");
  await page.setViewportSize({ width: 375, height: 900 });
  let browserMode = false, previewCalls = 0;
  const uploads: string[] = [];
  page.on("request", request => { if ((request.postDataBuffer()?.byteLength ?? 0) > 32_000) uploads.push(request.url()); });
  await page.route("**/v1/public/preview-replay", route => {
    previewCalls++;
    if (browserMode) return route.abort();
    return route.fulfill({
    status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" },
    body: JSON.stringify({
      ok: true, game_id: "synthetic-editor-phone", map: "Fixture Map", duration_sec: 600, date: "2026-10-23T00:00:00Z",
      players: [
        { name: "Fixture player", race: "Protoss", result: "Win", handle: null, build_log: ["[0:20] Gateway", "[1:30] CyberneticsCore", "[3:10] Stargate"] },
        { name: "Fixture opponent", race: "Zerg", result: "Loss", handle: null, build_log: [] },
      ],
    }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  browserMode = await page.getByText("Runs in your browser — the replay never leaves your device.", { exact: true }).count() > 0;
  const picker = page.getByLabel("Replay for the build editor demo");
  if (browserMode) {
    test.setTimeout(180_000);
    await picker.setInputFiles(path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay"));
    await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: /ReSpOnSe.*Protoss/ }).click();
  } else {
    await picker.setInputFiles({ name: "synthetic-editor.SC2Replay", mimeType: "application/octet-stream", buffer: Buffer.from("synthetic test fixture") });
  }
  const editor = page.getByRole("dialog").filter({ has: page.getByRole("region", { name: "Basics", exact: true }) });
  await expect(editor).toBeVisible({ timeout: browserMode ? 120_000 : 5_000 });
  expect(previewCalls).toBe(browserMode ? 0 : 1);
  expect(uploads).toEqual([]);
  const notes = editor.getByRole("textbox", { name: "Personal notes (private)" });
  await notes.fill("Scouting tells and timings. ".repeat(270));
  await expect(editor.getByRole("status", { name: "Personal notes character count" })).toContainText("/8000");
  await editor.getByRole("button", { name: /^Add rule: / }).first().click();
  await expect(editor.getByRole("link", { name: "Sign up to save", exact: true })).toBeVisible();
  expect(await editor.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await notes.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("build-editor-phone.png") });
  await editor.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
});
