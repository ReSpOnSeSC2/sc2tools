import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * /try end to end: a real replay is analysed by the real in-browser
 * engine (Web Worker + self-hosted Pyodide) and the instant report
 * renders — while NOTHING is sent to the API origin (the privacy promise:
 * replays are analysed on this device).
 *
 * @slow — boots Pyodide and parses a replay (tens of seconds). Runs only
 * when the build has Instant Analysis rolled out to everyone
 * (NEXT_PUBLIC_INSTANT_IMPORT=all at build time, engine assets built) and
 * only on the desktop-1280 project (the engine does not depend on the
 * viewport; the responsive smoke lives in public-pages.spec.ts).
 *
 * Run locally (apps/web):
 *   NEXT_PUBLIC_INSTANT_IMPORT=all ... npm run build
 *   NEXT_PUBLIC_INSTANT_IMPORT=all npx playwright test try-instant --project=desktop-1280
 */

const INSTANT_FOR_ALL = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all";
/** Same default as lib/clientApi.ts and the Playwright webServer env. */
const API_URL = new URL(process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REPLAY = path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay");
/**
 * No request of the flow may carry a body this large, to ANY origin: the
 * fixture replay is ~76 KB, so an upload of the file (or of its parsed
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

test.describe("/try instant analysis", () => {
  test.skip(!INSTANT_FOR_ALL, "Instant Analysis is not rolled out to everyone in this build");

  test("analyses a replay in the browser without calling the API", { tag: "@slow" }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1280", "engine flow runs once, on desktop");
    test.setTimeout(TEST_TIMEOUT_MS);

    const siteOrigin = new URL(String(testInfo.project.use.baseURL)).origin;
    const apiRequests: string[] = [];
    const outbound: string[] = [];
    page.context().on("request", (request) => {
      const url = new URL(request.url());
      const label = `${request.method()} ${url.origin}${url.pathname}`;
      if (isApiOrigin(url)) apiRequests.push(label);
      const bytes = request.postDataBuffer()?.length ?? 0;
      const allowedWrite = url.origin === siteOrigin && ALLOWED_SITE_WRITES.has(url.pathname);
      if (bytes > MAX_REQUEST_BODY_BYTES) outbound.push(`${label} (${bytes} B)`);
      else if (!READ_METHODS.has(request.method()) && !allowedWrite) outbound.push(label);
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      if (!HARNESS_CLERK_ERROR.test(error.message)) pageErrors.push(error.message);
    });

    await page.goto("/try");
    await expect(page.getByRole("heading", { level: 1, name: /analyze your replays in your browser/i })).toBeVisible();

    await page.getByLabel("Replay files").setInputFiles(REPLAY);

    // One loose file carries no toon folder → "Which player are you?".
    await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS });
    await page.getByRole("button", { name: /ReSpOnSe/ }).click();

    await expect(page.getByRole("heading", { name: "Your instant report" })).toBeVisible({ timeout: ENGINE_TIMEOUT_MS });
    await expect(page.getByTestId("report-matchups")).toBeVisible();
    await expect(page.getByTestId("report-matchups")).toContainText("Record by matchup");
    await expect(page.getByTestId("report-macro")).toBeVisible();

    expect(apiRequests, "nothing may leave the browser before the visitor chooses to save").toEqual([]);
    expect(outbound, "no replay or payload may be sent anywhere").toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
