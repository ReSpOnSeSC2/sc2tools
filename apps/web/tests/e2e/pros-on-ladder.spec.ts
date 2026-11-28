import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";

const BOARD = "**/v1/pros-on-ladder";
const STATUS = "**/v1/pros-on-ladder/status";
const headers = { "access-control-allow-origin": "*" };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const player = (n: number) => ({
  race: (["terran", "zerg", "protoss"] as const)[n % 3],
  league: "grandmaster",
  rating: 4900 + n * 100,
  playedAt: ago(n * 4),
});
const game = (n: number) => ({ map: "Blackrock", opponentRace: n % 2 ? "terran" : "zerg", won: n % 2 === 1, durationSec: 480 + n * 61, playedAt: ago(15 * n) });
const pro = (n: number, live: boolean) => ({
  ...player(n),
  rating: 5400 + n * 7,
  nickname: `ProName${n}`,
  team: n % 2 ? "Team Liquid" : null,
  live: live ? { platform: "twitch", channel: `proname${n}`, url: `https://www.twitch.tv/proname${n}`, viewers: 1200 } : null,
  games: [game(1), game(2), game(3)],
});
const board = (showNames: boolean) => ({
  available: true,
  showNames,
  pros: showNames ? [pro(1, true), pro(2, false), pro(3, false)] : [],
  players: Array.from({ length: 18 }, (_, index) => player(index + 1)),
  fetchedAt: ago(1),
});

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function serve(page: Page, answer: unknown, status: { available: boolean; showNames: boolean }) {
  await page.route(STATUS, route => route.fulfill({ json: status, headers }));
  await page.route(BOARD, route => route.fulfill({ json: answer, headers }));
}

test("shows named pros with their games and a live link, and no provider call from the browser", async ({ page }, info) => {
  const providerCalls: string[] = [];
  page.on("request", request => {
    if (/sc2pulse/.test(new URL(request.url()).host)) providerCalls.push(request.url());
  });
  await serve(page, board(true), { available: true, showNames: true });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/pros-on-ladder");
  await expect(page.getByRole("heading", { level: 1, name: "Pros on Ladder" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Pros playing now" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "ProName1" })).toBeVisible();
  const watch = page.getByRole("link", { name: /Watch proname1 live/ });
  await expect(watch).toHaveAttribute("href", "https://www.twitch.tv/proname1");
  await expect(watch).toHaveAttribute("target", "_blank");
  expect((await watch.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("link", { name: /Watch proname2 live/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Also playing now" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(providerCalls).toEqual([]);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/pros-on-ladder", theme);
  }
});

test("with names off every row is anonymous", async ({ page }, info) => {
  await serve(page, board(false), { available: true, showNames: false });
  await page.goto("/pros-on-ladder");
  await expect(page.getByRole("heading", { level: 2, name: "Playing now" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
  await expect(page.getByText(/ProName/)).toHaveCount(0);
  await expect(page.getByText("Grandmaster", { exact: true })).toHaveCount(18);
  expect(await noSidewaysScroll(page)).toBe(true);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/pros-on-ladder-anonymous", theme);
  }
});

test("says the board is not available yet while its gate is off", async ({ page }, info) => {
  await serve(page, { available: false }, { available: false, showNames: false });
  await page.goto("/pros-on-ladder");
  await expect(page.getByText("Pros on Ladder is not available yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Live streams" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await checkAccessibility(page, info, "/pros-on-ladder-closed", theme);
  }
});

test("shows an error that can be retried, then the board", async ({ page }, info) => {
  let failing = true;
  await page.route(STATUS, route => route.fulfill({ json: { available: true, showNames: false }, headers }));
  await page.route(BOARD, route => (failing
    ? route.fulfill({ status: 503, json: { error: { code: "pros_on_ladder_unavailable" } }, headers })
    : route.fulfill({ json: board(false), headers })));
  await page.goto("/pros-on-ladder");
  await expect(page.getByText(/could not be loaded right now/)).toBeVisible();
  await checkAccessibility(page, info, "/pros-on-ladder-error", "light");
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Playing now" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});

test("the retry button works from the keyboard", async ({ page }) => {
  let failing = true;
  await page.route(STATUS, route => route.fulfill({ json: { available: true, showNames: false }, headers }));
  await page.route(BOARD, route => (failing
    ? route.fulfill({ status: 503, json: {}, headers })
    : route.fulfill({ json: board(false), headers })));
  await page.goto("/pros-on-ladder");
  const retry = page.getByRole("button", { name: "Retry" });
  await retry.focus();
  failing = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Playing now" })).toBeVisible();
});
