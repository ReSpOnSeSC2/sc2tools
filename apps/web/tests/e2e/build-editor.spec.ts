import { expect, test } from "@playwright/test";

/** The production editor UI uses a synthetic preview response; no real replay is uploaded. */
test("phone build editor keeps private notes and rule controls inside its modal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "the touch-size viewport is set explicitly");
  await page.setViewportSize({ width: 375, height: 900 });
  await page.route("**/v1/public/preview-replay", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      ok: true, game_id: "synthetic-editor-phone", map: "Fixture Map", duration_sec: 600, date: "2026-10-23T00:00:00Z",
      players: [
        { name: "Fixture player", race: "Protoss", result: "Win", handle: null, build_log: ["[0:20] Gateway", "[1:30] CyberneticsCore", "[3:10] Stargate"] },
        { name: "Fixture opponent", race: "Zerg", result: "Loss", handle: null, build_log: [] },
      ],
    }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const picker = page.locator('input[type="file"]').first();
  await picker.setInputFiles({ name: "synthetic-editor.SC2Replay", mimeType: "application/octet-stream", buffer: Buffer.from("synthetic test fixture") });
  const editor = page.getByRole("dialog").filter({ has: page.getByRole("region", { name: "Basics", exact: true }) });
  await expect(editor).toBeVisible();
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
