import { expect, test } from "@playwright/test";
import { openSharedAnalysisFixture } from "./shared-analysis-fixture.mjs";

test("shared analysis keeps the filtered return context through links and keyboard navigation", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); await openSharedAnalysisFixture(page);
  const back = page.getByRole("link", { name: "Back to PvZ · Losses · page 3" }); await expect(back).toHaveAttribute("href", "/players/fixture-analysis-player/replays?result=loss&matchup=PvZ&cursor=old&page=3");
  const older = page.getByRole("link", { name: "Older game", exact: true }); await expect(older).toBeVisible(); await expect(page.getByRole("link", { name: "Newer game", exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.screenshot({ path: testInfo.outputPath("shared-analysis-header-375.png") }); }
  await older.click(); await expect(page).toHaveURL(/older-game\?from=/); await expect(page.getByTitle("This is the oldest game in this list")).toHaveAttribute("aria-disabled", "true"); await expect(back).toHaveAttribute("href", "/players/fixture-analysis-player/replays?result=loss&matchup=PvZ&cursor=old&page=3");
  await page.locator("body").click({ position: { x: 2, y: 2 } }); await page.keyboard.press("ArrowRight"); await expect(page).toHaveURL(/newer-game\?from=/); await expect(page.getByTitle("This is the newest game in this list")).toHaveAttribute("aria-disabled", "true");
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test("section links, stream recordings and macro leaks work with the real timeline", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); await page.emulateMedia({ reducedMotion: "reduce" }); await openSharedAnalysisFixture(page);
  await expect(page.getByLabel("Stream recordings of this game")).toHaveCount(1); await expect(page.getByRole("link", { name: "Watch POV (2)", exact: true })).toHaveAttribute("href", "#watch");
  const nav = page.getByRole("navigation", { name: "On this page" }); await nav.getByRole("link", { name: "Macro", exact: true }).click(); await expect(page).toHaveURL(/#macro-breakdown$/); await expect(nav.getByRole("link", { name: "Macro", exact: true })).toHaveAttribute("aria-current", "true");
  const all = page.getByRole("button", { name: "Show all 5 leaks", exact: true }); await expect(all).toHaveAttribute("aria-expanded", "false"); await all.click(); await expect(page.getByRole("button", { name: "Show fewer leaks", exact: true })).toHaveAttribute("aria-expanded", "true"); await expect(page.getByText("≈ 1,240 minerals lost across 5 leaks", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.getByRole("heading", { name: "Highest-impact macro leaks" }).evaluate((heading) => window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - 110 })); await page.screenshot({ path: testInfo.outputPath("shared-analysis-leaks-375.png") }); }
  await page.getByRole("button", { name: "Jump timeline to 6:42", exact: true }).click(); const slider = page.getByRole("slider", { name: "Scrub game time", exact: true }); await expect(slider).toHaveAttribute("aria-valuetext", "6:42"); await expect(slider).toBeInViewport();
  const current = page.url(); await slider.focus(); await page.keyboard.press("ArrowRight"); expect(page.url()).toBe(current); await expect(slider).not.toHaveAttribute("aria-valuetext", "6:42");
  if (testInfo.project.name === "desktop-1280") { await page.setViewportSize({ width: 1440, height: 1000 }); await nav.getByRole("link", { name: "Macro", exact: true }).click(); await page.screenshot({ path: testInfo.outputPath("shared-analysis-macro-1440.png") }); }
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
