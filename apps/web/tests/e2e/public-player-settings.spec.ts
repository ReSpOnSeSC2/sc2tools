import { expect, test } from "@playwright/test";
import { openPublicPlayerSettingsFixture } from "./public-player-settings-fixture.mjs";

test("settings fit 320/390/768/1440 in both themes and copy denial has a selected visible fallback", async ({ page }, info) => {
  const evidence = await openPublicPlayerSettingsFixture(page);
  for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`public-settings-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Copy profile link", exact: true }).click();
  const fallback = page.getByRole("textbox", { name: "Copy profile link", exact: true });
  await expect(fallback).toBeVisible(); await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue("https://public-player-settings-fixture.local/players/frontier-0123456789");
  expect(await fallback.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBeGreaterThan(0);
  await fallback.press("Escape"); await expect(fallback).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy profile link", exact: true })).toBeFocused();
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.writes).toEqual([]);
});

test("a held settings save cannot complete into a later A to B to A account", async ({ page }) => {
  const evidence = await openPublicPlayerSettingsFixture(page);
  await page.getByRole("checkbox", { name: "Public profile on" }).uncheck();
  await page.getByRole("button", { name: "Save public profile", exact: true }).click();
  await expect.poll(() => evidence.writes.length).toBe(1);
  await page.getByRole("button", { name: "Use fixture account B" }).click();
  await expect(page.getByRole("textbox", { name: "Player link prefix" })).toHaveValue("beta");
  await page.getByRole("button", { name: "Use fixture account A" }).click();
  await expect(page.getByRole("textbox", { name: "Player link prefix" })).toHaveValue("frontier");
  await evidence.releaseWrites();
  await expect(page.getByRole("checkbox", { name: "Public profile on" })).toBeChecked();
  await expect(page.getByText("Public profile settings saved.", { exact: true })).toHaveCount(0);
  expect(evidence.writes[0].owner).toBe("owner-a"); expect(evidence.writes[0].body.enabled).toBe(false);
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});
