import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";

const API = "**/v1/ladder-vods*";
const headers = { "access-control-allow-origin": "*" };

const vod = (n: number) => ({
  vodUrl: `https://www.twitch.tv/videos/${2942000000 + n}?t=${n * 60}s`,
  channel: `streamer${n}`,
  subscribersOnly: n === 2,
  streamerRace: n % 2 ? "zerg" : "terran",
  opponentRace: n % 2 ? "terran" : "zerg",
  rating: 6000 + n * 100,
  map: "Blackrock LE",
  durationSec: 600 + n * 37,
  playedAt: new Date(Date.now() - n * 3_600_000).toISOString(),
});
const maps = [{ id: "55373", name: "Blackrock" }, { id: "55370", name: "Lockdown" }];
const page1 = { available: true, maps, results: [vod(1), vod(2), vod(3), vod(4)], next: "cursor-1", fetchedAt: new Date().toISOString() };
const page2 = { available: true, maps, results: [vod(5)], next: null, fetchedAt: new Date().toISOString() };

/** On a phone length and map sit behind "More filters"; wider screens show them already. */
async function showAllFilters(page: Page) {
  const more = page.getByRole("button", { name: "More filters" });
  if (await more.isVisible()) await more.click();
}

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("searches, shows games and opens a VOD with no SC2Pulse call from the browser", async ({ page }, info) => {
  const providerCalls: string[] = [];
  const searches: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (/sc2pulse|twitch\.tv/.test(url.host)) providerCalls.push(request.url());
  });
  await page.route(API, route => {
    const url = new URL(route.request().url());
    searches.push(url.search);
    return route.fulfill({ json: url.searchParams.get("after") ? page2 : page1, headers });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/ladder-vods");
  await expect(page.getByRole("heading", { level: 1, name: "Ladder VODs" })).toBeVisible();
  await expect(page.getByText("4 recent games with a VOD")).toBeVisible();
  await expect(page.getByLabel("Matchup")).toHaveValue("tvz");

  const first = page.getByRole("link", { name: /Watch streamer1 on Twitch/ });
  await expect(first).toHaveAttribute("href", /^https:\/\/www\.twitch\.tv\/videos\/2942000001\?t=60s$/);
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Subscribers only")).toBeVisible();

  await showAllFilters(page);
  await page.getByLabel("Map").selectOption("55373");
  await page.getByRole("main").getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("4 recent games with a VOD")).toBeVisible();
  expect(searches.at(-1)).toContain("map=55373");

  await page.getByRole("button", { name: "Show more games" }).click();
  await expect(page.getByText(/5 recent games with a VOD · that is all for this search/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more games" })).toHaveCount(0);

  const tall = await first.evaluate(node => node.closest("li")!.getBoundingClientRect().height);
  expect(tall).toBeGreaterThanOrEqual(44);
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(providerCalls).toEqual([]);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/ladder-vods", theme);
  }
});

test("says the finder is not available yet while its gate is off", async ({ page }, info) => {
  await page.route(API, route => route.fulfill({ json: { available: false }, headers }));
  await page.goto("/ladder-vods");
  await expect(page.getByText("The ladder VOD finder is not available yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Live streams" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Search" })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "MMR" })).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/ladder-vods-closed", theme);
  }
});

test("searches with the keyboard", async ({ page }) => {
  const searches: string[] = [];
  await page.route(API, route => {
    searches.push(new URL(route.request().url()).search);
    return route.fulfill({ json: page1, headers });
  });
  await page.goto("/ladder-vods");
  await expect(page.getByText("4 recent games with a VOD")).toBeVisible();
  await showAllFilters(page);
  await page.getByLabel("Length").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Length")).toHaveValue("0");
  const search = page.getByRole("main").getByRole("button", { name: "Search" });
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => searches.at(-1)).toContain("length=0");
});

test("shows an empty state and an error that can be retried", async ({ page }, info) => {
  let mode: "fail" | "empty" = "fail";
  await page.route(API, route => (mode === "fail"
    ? route.fulfill({ status: 503, json: { error: { code: "ladder_vods_unavailable" } }, headers })
    : route.fulfill({ json: { available: true, maps, results: [], next: null, fetchedAt: new Date().toISOString() }, headers })));
  await page.goto("/ladder-vods");
  await expect(page.getByText(/search is unavailable right now/)).toBeVisible();
  await checkAccessibility(page, info, "/ladder-vods-error", "light");
  mode = "empty";
  await page.getByRole("button", { name: "Retry search" }).click();
  await expect(page.getByText(/No recent ladder game with a Twitch VOD matches/)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
