import { expect, test } from "@playwright/test";
const root = "/players/fixture-archive-player/replays";

test("archive selects combine immediately, chips reset pagination and records reflect the full match", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto(root);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const main = page.getByRole("main"); const record = main.getByLabel("Filtered replay record"); await expect(record).toContainText("65 replays");
  await expect(main.getByRole("button", { name: "Apply", exact: true })).toBeHidden();
  await main.getByRole("combobox", { name: "Result", exact: true }).selectOption("loss"); await expect(page).toHaveURL(/result=loss/); await expect(record).toContainText("Losses:"); await expect(record).not.toContainText("%");
  await main.getByRole("combobox", { name: "Map", exact: true }).selectOption("Alcyone LE"); await expect(page).toHaveURL(/map=Alcyone/); await expect(record).toContainText("Map: Alcyone LE");
  await expect(main.getByRole("link", { name: "Remove filter: Losses", exact: true })).toBeVisible(); await main.getByRole("link", { name: "Remove filter: Losses", exact: true }).click();
  await expect(page).not.toHaveURL(/result=/); await expect(record).toContainText("Map: Alcyone LE"); await expect(record).toContainText("%");
  const search = main.getByRole("searchbox", { name: "Search replays" }); await search.fill("Blink"); await expect(page).toHaveURL(/search=Blink/); await expect(record).toContainText("“Blink”");
  await main.getByRole("button", { name: "Clear search", exact: true }).click(); await expect(page).toHaveURL(/search=&/); await expect(record).not.toContainText("“Blink”");
  await main.getByRole("combobox", { name: "Order", exact: true }).selectOption("date_asc"); await expect(page).toHaveURL(/sort=date_asc/);
  await main.getByRole("link", { name: "Newer replays", exact: true }).click(); await expect(page).toHaveURL(/cursor=offset%3A25&page=2#replay-results$/);
  await expect(main.getByRole("region", { name: "Replay results" })).toBeFocused({ timeout: 20_000 }); await expect(main.getByText("Page 2 · Showing 26–43", { exact: true })).toBeVisible();
  await main.getByRole("link", { name: "Remove filter: Map: Alcyone LE", exact: true }).click(); await expect(page).not.toHaveURL(/cursor=|page=|map=/); await expect(main.getByRole("link", { name: "Remove filter: Oldest first" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await main.getByRole("search").evaluate((form) => { form.scrollIntoView({ block: "start" }); window.scrollBy(0, -80); }); await page.screenshot({ path: testInfo.outputPath("public-archive-filters-375.png") }); }
});

test("native Apply still filters without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:3210${root}`); const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: "Apply", exact: true })).toBeVisible(); await main.getByRole("combobox", { name: "Result", exact: true }).selectOption("tie");
    await main.getByRole("button", { name: "Apply", exact: true }).click(); await expect(page).toHaveURL(/result=tie/); await expect(main.getByLabel("Filtered replay record")).toContainText("Ties: 13 replays");
    await expect(main.getByRole("link", { name: "Remove filter: Ties", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("laptop cards keep the public Analysis action inside the viewport", async ({ page }, testInfo) => {
  test.setTimeout(60_000); await page.goto(root); await page.getByRole("button", { name: "Reject", exact: true }).click();
  for (const width of [1024, 1100, 1190]) {
    await page.setViewportSize({ width, height: 900 }); const main = page.getByRole("main");
    await expect(main.getByRole("table", { name: "Replay history for Fixture Player" })).toBeHidden();
    const action = main.getByRole("link", { name: /Open replay analysis for|Timeline, macro breakdown/ }).first(); await expect(action).toBeVisible();
    const box = await action.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
  if (testInfo.project.name === "desktop-1280") { await page.getByRole("main").getByRole("link", { name: /Open replay analysis for|Timeline, macro breakdown/ }).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("public-archive-cards-1190.png") }); }
});
