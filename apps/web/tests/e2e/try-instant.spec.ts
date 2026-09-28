import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * /try end to end: real replays are analysed by the real in-browser
 * engine (Web Worker + self-hosted Pyodide) and the instant report
 * renders — the cards, "Opponent openers", the MMR card and the game by
 * game view with both build orders and the macro timeline — while
 * NOTHING is sent to the API origin (the privacy promise: replays are
 * analysed on this device).
 *
 * @slow — boots Pyodide and parses replays (tens of seconds). Runs only
 * when the build has Instant Analysis rolled out to everyone
 * (NEXT_PUBLIC_INSTANT_IMPORT=all at build time, engine assets built):
 * the two-game flow on desktop-1280, a one-game flow on mobile-360 that
 * also checks the report never scrolls sideways. Other projects skip.
 *
 * Run locally (apps/web):
 *   NEXT_PUBLIC_INSTANT_IMPORT=all ... npm run build
 *   NEXT_PUBLIC_INSTANT_IMPORT=all npx playwright test try-instant --project=desktop-1280 --project=mobile-360
 */

const INSTANT_FOR_ALL = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all";
/** Same default as lib/clientApi.ts and the Playwright webServer env. */
const API_URL = new URL(process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FIXTURES = path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays");
/** One loose PvZ ladder game (player ReSpOnSe). */
const WARPGATE = path.join(FIXTURES, "warpgate_adept_tracking.SC2Replay");
/** Two ladder games of the same Terran account on the Terran queue. */
const LADDER_PAIR = ["ladder_zvt_winter_madness.SC2Replay", "ladder_tvt_tourmaline.SC2Replay"].map((name) =>
  path.join(FIXTURES, name),
);
/**
 * No request of the flow may carry a body this large, to ANY origin: the
 * fixture replays are 60–80 KB, so an upload of a file (or of its parsed
 * payload) anywhere would trip it, while small same-site pings would not.
 */
const MAX_REQUEST_BODY_BYTES = 1024;
/** Methods that only read; any other request must be an allowed same-site ping. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Same-site writes that may happen while any page is open (the presence
 * heartbeat posts "{}"). Chromium does not always expose Blob/File bodies
 * to Playwright, so every other write fails the test whatever its size.
 */
const ALLOWED_SITE_WRITES = new Set(["/api/site/presence"]);

/** True for the API origin, however the loopback host is spelled. */
function isApiOrigin(url: URL): boolean {
  if (url.origin === API_URL.origin) return true;
  return LOOPBACK_HOSTS.has(API_URL.hostname) && LOOPBACK_HOSTS.has(url.hostname) && url.port === API_URL.port;
}

/** First boot downloads + verifies the engine, then scans and parses. */
const ENGINE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 240_000;
/**
 * The harness runs with a format-valid dummy Clerk key whose frontend API
 * (clerk.example.com) does not exist (see playwright.config.ts), so
 * clerk-js can never load. That one known error is not the page's fault.
 */
const HARNESS_CLERK_ERROR = /failed_to_load_clerk_js/;

interface Traffic {
  apiRequests: string[];
  outbound: string[];
  pageErrors: string[];
}

/** Record every API-origin request, every upload-sized or write request, and page errors. */
function watchTraffic(page: Page, siteOrigin: string): Traffic {
  const traffic: Traffic = { apiRequests: [], outbound: [], pageErrors: [] };
  page.context().on("request", (request) => {
    const url = new URL(request.url());
    const label = `${request.method()} ${url.origin}${url.pathname}`;
    if (isApiOrigin(url)) traffic.apiRequests.push(label);
    const bytes = request.postDataBuffer()?.length ?? 0;
    const allowedWrite = url.origin === siteOrigin && ALLOWED_SITE_WRITES.has(url.pathname);
    if (bytes > MAX_REQUEST_BODY_BYTES) traffic.outbound.push(`${label} (${bytes} B)`);
    else if (!READ_METHODS.has(request.method()) && !allowedWrite) traffic.outbound.push(label);
  });
  page.on("pageerror", (error) => {
    if (!HARNESS_CLERK_ERROR.test(error.message)) traffic.pageErrors.push(error.message);
  });
  return traffic;
}

/** Drop the replays on /try, answer "Which player are you?", wait for the report. */
async function analyse(page: Page, files: string[], player: RegExp): Promise<void> {
  await page.goto("/try");
  await expect(page.getByRole("heading", { level: 1, name: /analyze your replays in your browser/i })).toBeVisible();
  await page.getByLabel("Replay files").setInputFiles(files);
  // Loose files carry no toon folder → "Which player are you?".
  await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS });
  await page.getByRole("button", { name: player }).first().click();
  await expect(page.getByRole("heading", { name: "Your instant report" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS });
}

/** Both build orders and the (lazily loaded) macro chart of the selected game. */
async function expectSelectedGameDetail(page: Page): Promise<void> {
  const builds = page.getByTestId("report-build-orders");
  await builds.scrollIntoViewIfNeeded();
  await expect(builds.getByTestId("build-column-me")).toBeVisible();
  await expect(builds.getByTestId("build-column-opp")).toBeVisible();
  await expect(builds).not.toContainText(/RewardDance|Beacon|Spray/);
  const chart = page.getByTestId("report-macro-chart");
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.getByRole("img", { name: /Army value/ })).toBeVisible();
}

function expectNothingSent(traffic: Traffic): void {
  expect(traffic.apiRequests, "nothing may leave the browser before the visitor chooses to save").toEqual([]);
  expect(traffic.outbound, "no replay or payload may be sent anywhere").toEqual([]);
  expect(traffic.pageErrors).toEqual([]);
}

test.describe("/try instant analysis", () => {
  test.skip(!INSTANT_FOR_ALL, "Instant Analysis is not rolled out to everyone in this build");

  test("analyses replays in the browser without calling the API", { tag: "@slow" }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1280", "the two-game flow runs on desktop");
    test.setTimeout(TEST_TIMEOUT_MS);
    const traffic = watchTraffic(page, new URL(String(testInfo.project.use.baseURL)).origin);

    await analyse(page, LADDER_PAIR, /· 2 games/);
    await expect(page.getByTestId("report-matchups")).toContainText("Record by matchup");
    await expect(page.getByTestId("report-macro")).toBeVisible();
    await expect(page.getByTestId("report-opp-openers")).toContainText("Opponent openers");
    await expect(page.getByTestId("report-mmr")).toContainText("Terran queue");

    const games = page.getByRole("list", { name: "Your games" }).getByRole("button");
    await expect(games).toHaveCount(2);
    await expect(games.first()).toHaveAttribute("aria-pressed", "true");
    await expectSelectedGameDetail(page);
    // The newest game of the queue: pre-game MMRs only, never a change.
    const gameMmr = page.getByTestId("report-game-mmr");
    await expect(gameMmr).toContainText("Pre-game MMR");
    await expect(gameMmr).not.toContainText("by your next game");

    // The older game has a later game on the same queue: its MMR change
    // (3671 − 3703, both pre-game values from the replays) shows.
    await games.nth(1).click();
    await expect(games.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(gameMmr).toContainText("−32 by your next game");
    await expectSelectedGameDetail(page);

    expectNothingSent(traffic);
  });

  test("fits a 360 px phone without calling the API", { tag: "@slow" }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-360", "the phone flow runs on mobile-360");
    test.setTimeout(TEST_TIMEOUT_MS);
    const traffic = watchTraffic(page, new URL(String(testInfo.project.use.baseURL)).origin);

    await analyse(page, [WARPGATE], /ReSpOnSe/);
    await expect(page.getByTestId("report-opp-openers")).toContainText("Opponent openers");
    await expectSelectedGameDetail(page);
    await expect(page.getByTestId("report-game-mmr")).toContainText("favored by 208");
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, "the report must not scroll sideways").toBeLessThanOrEqual(overflow.clientWidth);

    expectNothingSent(traffic);
  });
});
