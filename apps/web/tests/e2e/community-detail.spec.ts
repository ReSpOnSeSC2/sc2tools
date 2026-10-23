import { expect, test } from "@playwright/test";

test("community detail keeps phone actions first, readable metadata and measured description disclosure", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  expect((await page.goto("/community/builds/fixture-community-polish"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Fixture safe opening", level: 1 })).toBeVisible();
  const reject = page.locator("[data-cookie-banner]").getByRole("button", { name: "Reject" }); if (await reject.isVisible()) await reject.click();
  const actions = page.getByRole("region", { name: "Build actions" });
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await expect(actions).toBeVisible();
    const actionBox = await actions.boundingBox(); const rules = await page.getByRole("heading", { name: "Build order", exact: true }).boundingBox();
    expect(actionBox!.y + actionBox!.height).toBeLessThan(rules!.y);
    expect((await actions.getByRole("button", { name: "Share", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } else await expect(actions).toBeHidden();
  const main = page.getByRole("main");
  const details = main.getByLabel("Build details");
  await expect(details.getByText("Oct 3, 2026", { exact: true })).toBeVisible();
  await expect(details.getByText("Build to play", { exact: true })).toBeVisible();
  expect(await details.locator("dt").allTextContents()).toEqual(["Matchup", "Type", "Rules", "Skill level", "Published", "Updated"]);
  const about = page.getByRole("heading", { name: "About this build" }).locator("..");
  const more = about.getByRole("button", { name: "Show more" });
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await more.click(); await expect(about.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await about.getByRole("button", { name: "Show less" }).click(); await expect(more).toHaveAttribute("aria-expanded", "false");
  }
  await expect(main.getByText("Something wrong with this build? Report it.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.getByRole("heading", { name: "Fixture safe opening", level: 1 }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("community-build-actions-375.png") }); }
});

test("author browsing sorts, filters present matchups and searches descriptions without redundant author links", async ({ page }, testInfo) => {
  await page.goto("/community/authors/fixture-community-author");
  const reject = page.locator("[data-cookie-banner]").getByRole("button", { name: "Reject" }); if (await reject.isVisible()) await reject.click();
  const list = page.getByRole("list", { name: "Published builds", exact: true });
  await expect(list.getByRole("heading", { level: 3 }).first()).toHaveText("Fixture safe opening");
  await page.getByRole("radio", { name: "Top", exact: true }).click(); await expect(list.getByRole("heading", { level: 3 }).first()).toHaveText("Fixture opener 4");
  await page.getByRole("button", { name: "PvZ · 4", exact: true }).click(); await expect(list.getByRole("heading", { level: 3 })).toHaveCount(4);
  await page.getByRole("searchbox", { name: "Search author's builds" }).fill("scouting"); await expect(list.getByRole("heading", { level: 3 })).toHaveText("Fixture opener 2");
  await page.getByRole("searchbox", { name: "Search author's builds" }).fill("missing"); await expect(page.getByText("No builds match “missing”", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click(); await expect(list.getByRole("heading", { level: 3 })).toHaveCount(6);
  await expect(list.getByRole("link", { name: /^A{80}$/ })).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(main.getByText("Mar 2026", { exact: true })).toBeVisible(); await expect(main.getByText("Across 2 matchups", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.getByRole("heading", { name: "Published builds", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("community-author-browse-375.png") }); }
  if (testInfo.project.name === "desktop-1280") { await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole("heading", { name: "FixtureBuilder", level: 1 }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("community-author-browse-1440.png") }); }
});
