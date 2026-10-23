import { expect, test } from "@playwright/test";
import { openGuideTimingsFixture } from "./guide-timings-fixture.mjs";

async function dismissCookies(page: import("@playwright/test").Page) {
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (await reject.isVisible()) await reject.click();
}
async function noOverflow(page: import("@playwright/test").Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true); }

test("guide openers preserve rank through search, sorting and published-only filtering", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto("/guides/pvz"); expect(response?.status()).toBe(200); await dismissCookies(page);
  const search = page.getByRole("searchbox", { name: "Find an opener" }); await search.fill("blink"); await expect(page.getByText("1 of 4 openers", { exact: true })).toBeVisible();
  const cards = page.getByRole("list", { name: "Opener cards" }); const mobile = testInfo.project.name === "mobile-360";
  if (mobile) { await expect(cards.getByRole("link", { name: "Standard Blink Macro", exact: true })).toBeVisible(); await expect(cards.getByRole("listitem")).toContainText("#2"); }
  else await expect(page.getByRole("table").getByRole("rowheader", { name: "Standard Blink Macro", exact: true })).toBeVisible();
  await search.fill(""); await page.getByRole("checkbox", { name: "Only openers with a full guide" }).check(); await expect(page.getByText("3 of 4 openers", { exact: true })).toBeVisible();
  if (mobile) { await page.getByRole("combobox", { name: "Sort by" }).selectOption("games:asc"); await expect(cards.getByRole("listitem").first()).toContainText("#3"); await page.setViewportSize({ width: 375, height: 900 }); await search.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("guides-openers-375.png") }); }
  else { const table = page.getByRole("table"); await table.getByRole("button", { name: "Games", exact: true }).click(); await table.getByRole("button", { name: "Games", exact: true }).click(); await expect(table.getByRole("rowheader").first()).toHaveText("Robo Opener"); }
  expect((await search.boundingBox())?.width).toBeGreaterThan(250); await noOverflow(page); expect(errors).toEqual([]);
});

test("guide counters and map pool support sorting, missing cells and race-specific columns", async ({ page }, testInfo) => {
  await page.goto("/guides/pvz/counter"); await dismissCookies(page); await expect(page.getByRole("link", { name: "How to beat Ling Bane Bust", exact: true })).toBeVisible();
  const items = page.locator("main").getByRole("listitem").filter({ has: page.getByRole("link", { name: /^How to beat/ }) }); await expect(items.first()).toContainText("Ling Bane Bust"); await page.getByRole("combobox", { name: "Sort by" }).selectOption("games"); await expect(items.first()).toContainText("12 Pool");
  await page.goto("/guides/maps"); await page.getByRole("button", { name: "Table", exact: true }).click(); const table = page.getByRole("table", { name: "Map pool win rates by matchup" }); await expect(table.getByRole("columnheader")).toHaveCount(7);
  await page.getByRole("combobox", { name: "I play" }).selectOption("P"); await expect(table.getByRole("columnheader")).toHaveCount(3); await table.getByRole("button", { name: "PvZ", exact: true }).click(); await table.getByRole("button", { name: "PvZ", exact: true }).click(); await expect(table.getByRole("rowheader").first()).toHaveText("Fixture Canyon LE"); await expect(table.getByRole("rowheader").last()).toHaveText("Fixture Ridge LE");
  await noOverflow(page); if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await table.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("guides-map-pool-375.png") }); }
  await page.reload(); await expect(page.getByRole("table")).toBeVisible();
});

test("build guide groups and all-map disclosure remain accessible and recover the complete list", async ({ page }, testInfo) => {
  const response = await page.goto("/guides/pvz/stargate-into-glaives"); expect(response?.status()).toBe(200); await dismissCookies(page);
  await expect(page.getByRole("heading", { name: "Too close to call (8)" })).toBeVisible(); const group = page.getByRole("table", { name: "Too close to call opponent openers" }); await expect(group.getByRole("rowheader")).toHaveCount(5);
  await page.getByRole("button", { name: "Show 3 more", exact: true }).click(); await expect(group.getByRole("rowheader")).toHaveCount(8); await expect(page.getByRole("button", { name: "Show fewer", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.getByText("Show all 7 maps", { exact: true }).click(); const maps = page.getByRole("table", { name: "All maps for this build" }); await expect(maps.getByRole("rowheader")).toHaveCount(7); await expect(maps.getByRole("link")).toHaveCount(1); await expect(page.getByRole("columnheader", { name: "You", exact: true })).toHaveCount(0);
  await noOverflow(page); if (testInfo.project.name === "desktop-1280") { await page.setViewportSize({ width: 1440, height: 1000 }); await group.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("guides-matchup-groups-1440.png") }); }
});

test("personal guide timings use one request, explain deltas and recover through Retry", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); const fixture = await openGuideTimingsFixture(page, "retry");
  const retry = page.getByRole("button", { name: "Retry", exact: true }); await expect(retry).toBeVisible(); expect(fixture.requests()).toBe(1); await retry.click(); await expect(page.getByRole("button", { name: "Retrying…" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("You: 48.6% over 37 games · community 55.0% (−6.4 pp)", { exact: true })).toBeVisible(); expect(fixture.requests()).toBe(2); await expect(page.getByRole("columnheader", { name: "You based on 2 of your games" })).toBeVisible(); await expect(page.getByText("+12s · late", { exact: true })).toBeVisible(); await expect(page.getByText("Your median is 12 seconds later than the community median, later than most players", { exact: true })).toHaveClass("sr-only");
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await expect(page.getByRole("columnheader", { name: "You based on 2 of your games" })).toBeInViewport(); await page.screenshot({ path: testInfo.outputPath("guides-personal-timings-375.png") }); }
  if (testInfo.project.name === "desktop-1280") { await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: testInfo.outputPath("guides-personal-timings-1440.png") }); }
  await noOverflow(page); expect(errors).toEqual([]);
});

test("a guide timing session expiry returns to the contextual sign-in prompt", async ({ page }) => {
  const fixture = await openGuideTimingsFixture(page, "signedout"); await expect(page.getByRole("link", { name: "Sign in to see your own timings next to these" })).toHaveAttribute("href", "/sign-in?redirect_url=%2Fguides%2Fpvz%2Fstargate-into-glaives"); await expect(page.getByRole("columnheader", { name: /^You/ })).toHaveCount(0); expect(fixture.requests()).toBe(1); await noOverflow(page);
});

test("guide ranks and complete map disclosure remain available without JavaScript", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1280", "one independent no-JavaScript context covers the server contract");
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 900 } });
  try {
    const page = await context.newPage(); const openers = await page.goto(`${baseURL}/guides/pvz`); expect(openers?.status()).toBe(200); const cards = page.getByRole("list", { name: "Opener cards" }); await expect(cards.getByRole("listitem")).toHaveCount(4); await expect(cards.getByRole("listitem").first()).toContainText("#1Stargate into Glaives");
    const build = await page.goto(`${baseURL}/guides/pvz/stargate-into-glaives`); expect(build?.status()).toBe(200); await expect(page.getByRole("table", { name: "Too close to call opponent openers" }).getByRole("rowheader")).toHaveCount(5); await page.getByText("Show all 7 maps", { exact: true }).click(); await expect(page.getByRole("table", { name: "All maps for this build" }).getByRole("rowheader")).toHaveCount(7); await noOverflow(page);
  } finally { await context.close(); }
});
