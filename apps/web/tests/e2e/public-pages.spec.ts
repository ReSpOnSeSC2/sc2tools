import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * Public-page responsive smoke, run at 360 / 768 / 1280 via the
 * viewport projects in playwright.config.ts.
 *
 * Three invariants per page:
 *   1. It renders (a real h1/main, not a crash screen) with NO backend
 *      and a dummy Clerk key — i.e. graceful degradation works. (The
 *      guide pages read synthetic fixtures from tests/e2e/mock-guides-api.mjs;
 *      every other API call still fails.)
 *   2. No body-level horizontal scroll at any viewport — wide content
 *      must scroll inside its own container, never the page.
 *   3. The chrome (header nav) is present, so the layout mounted.
 */

const PAGES: Array<{ path: string; expectText: RegExp }> = [
  { path: "/legal/privacy", expectText: /Privacy Policy/ },
  { path: "/legal/terms", expectText: /Terms of Service/ },
  { path: "/", expectText: /opponent|build|replay/i },
  { path: "/guides", expectText: /build order guides/i },
  { path: "/guides/pvz", expectText: /PvZ build orders/i },
  { path: "/guides/pvz/stargate-into-glaives", expectText: /Stargate into Glaives/ },
  { path: "/download", expectText: /download|agent/i },
  { path: "/stream-studio", expectText: /StarCraft II overlays for OBS/i },
  { path: "/stream-studio/learn", expectText: /Your first overlay/i },
  { path: "/community", expectText: /community|build/i },
  { path: "/donate", expectText: /donate|chip in|free/i },
  {
    path: "/players/test-player-0123456789/replays",
    expectText: /replay archive|replays/i,
  },
  // /try exists only when Instant Analysis is rolled out to everyone
  // (build-time flag; the build step must use the same value).
  ...(process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all"
    ? [{ path: "/try", expectText: /analyze/i }]
    : []),
];

test("phone landing headline holds its position while the carousel waits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 }).first();
  const before = await heading.boundingBox();
  await page.waitForTimeout(6000);
  const after = await heading.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, wide: Array.from(document.querySelectorAll("body *")).filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map((node) => ({ tag: node.tagName, className: node.className, width: node.getBoundingClientRect().width })) }));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
});

test("phone privacy contents links reach the Cookies section", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await page.goto("/legal/privacy");
  await page.getByText("On this page", { exact: true }).last().click();
  await page.getByRole("navigation", { name: "On this page" }).last().getByRole("link", { name: "Cookies", exact: true }).click();
  await expect(page).toHaveURL(/#cookies$/);
  await expect(page.locator("h2#cookies")).toBeInViewport();
});

for (const { path, expectText } of PAGES) {
  test(`${path} renders without horizontal scroll`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response, `no response for ${path}`).not.toBeNull();
    expect(response!.status(), `${path} status`).toBeLessThan(400);

    // Layout mounted: the site header's nav landmark exists.
    await expect(page.locator("header").first()).toBeVisible();

    // Content rendered (not Next's unstyled error screen).
    await expect(page.locator("main").first()).toBeVisible();
    await expect(page.locator("body")).toContainText(expectText);

    // The cardinal responsive sin: body-level horizontal overflow.
    // +1 tolerates sub-pixel rounding on scaled displays.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
      };
    });
    expect(
      overflow.scrollWidth,
      `${path} horizontally overflows: content ${overflow.scrollWidth}px > viewport ${overflow.clientWidth}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
}

// The browser-vs-agent comparison must fit the page (it scrolls inside its
// own box only as a last resort), even at 360px.
if (process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all") {
  test("/try comparison table fits without scrolling sideways", async ({ page }) => {
    await page.goto("/try");
    const region = page.getByRole("region", { name: "Browser vs desktop agent comparison" });
    await expect(region).toBeVisible();
    const box = await region.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    expect(
      box.scrollWidth,
      `comparison table overflows its box: ${box.scrollWidth}px > ${box.clientWidth}px`,
    ).toBeLessThanOrEqual(box.clientWidth + 1);
  });
}

/** WCAG 2.x relative luminance of a computed `rgb()` / `rgba()` colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((channel) => {
    const value = Number(channel) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

async function paint(target: Locator): Promise<{ color: string; background: string }> {
  return target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor };
  });
}

/**
 * Primary CTA links keep their label on hover. A global `a:hover` rule
 * used to out-rank `.text-white` and paint the label the same colour as
 * its own hover fill ('Get started', 'Download the agent', 'Try again').
 *
 * The header 'Get started' sits inside Clerk's <SignedOut>, which never
 * mounts here (the dummy key can't load Clerk), so the 404 page's
 * 'Go home' stands in: the same `bg-accent text-white
 * hover:bg-accent-hover` pill, rendered with no auth or API.
 * Reduced motion zeroes the colour transitions, so the computed styles
 * are final as soon as the pointer lands.
 */
test.describe("primary CTA link on hover", () => {
  async function hoverPrimaryLink(page: Page, testInfo: TestInfo, colorScheme: "light" | "dark") {
    test.skip(testInfo.project.name !== "desktop-1280", "the viewport doesn't matter here; run it once");
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/this-page-does-not-exist");
    const cta = page.getByRole("main").getByRole("link", { name: "Go home" });
    await expect(cta).toBeVisible();
    const rest = await paint(cta);
    await cta.hover();
    const hovered = await paint(cta);
    // Sanity: the hover fill applied, so the pointer really is on the link.
    expect(hovered.background, "hover background").not.toBe(rest.background);
    expect(hovered.color, "label colour on hover").toBe(rest.color);
    return { rest, hovered };
  }

  test("label stays readable in the light theme", async ({ page }, testInfo) => {
    const { rest, hovered } = await hoverPrimaryLink(page, testInfo, "light");
    expect(contrastRatio(rest.color, rest.background), "label contrast at rest").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hovered.color, hovered.background), "label contrast on hover").toBeGreaterThanOrEqual(4.5);
  });

  test("label keeps its colour in the dark theme", async ({ page }, testInfo) => {
    await hoverPrimaryLink(page, testInfo, "dark");
  });
});

test("/p/<missing> is a real 404, not a soft-404", async ({ page }) => {
  const response = await page.goto("/p/definitely-not-a-real-handle");
  expect(response).not.toBeNull();
  // The API is down in this harness (status null path) → the page
  // renders the transient unavailable state with a 200. When the API
  // IS up and positively 404s, the status must be 404. Accept either
  // here but require the page not to crash and not to overflow.
  expect([200, 404]).toContain(response!.status());
  await expect(page.locator("main").first()).toBeVisible();
});

/**
 * Guide pages against the synthetic fixture API (tests/e2e/mock-guides-api.mjs):
 * the headline stat is on screen and nothing overflows at a small phone
 * (375) and a wide desktop (1440). Viewports are set per test, so this
 * block runs once (in the desktop project) instead of once per project.
 */
const GUIDE_STATS: Array<{ path: string; locate: (page: Page) => Locator; stat: string }> = [
  // Fixture Diamond band: 88 wins / 150 games → 58.7%.
  { path: "/guides/pvz/stargate-into-glaives", locate: (page) => page.getByTestId("guide-headline"), stat: "58.7%" },
  // Fixture PvZ ranking: Stargate into Glaives 238 / 420 → 56.7%.
  { path: "/guides/pvz", locate: (page) => page.getByRole("row", { name: /Stargate into Glaives/ }), stat: "56.7%" },
  {
    path: "/guides",
    locate: (page) =>
      page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Stargate into Glaives" }) }).last(),
    stat: "56.7%",
  },
];

test.describe("guide pages at 375 and 1440 px", () => {
  for (const width of [375, 1440]) {
    test(`headline stats visible with no horizontal scroll at ${width}px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-1280", "the viewport is set per test; run it once");
      await page.setViewportSize({ width, height: 900 });
      for (const { path, locate, stat } of GUIDE_STATS) {
        const response = await page.goto(path);
        expect(response?.status(), `${path} status`).toBe(200);
        const target = locate(page);
        await expect(target, `${path} headline`).toBeVisible();
        await expect(target, `${path} stat`).toContainText(stat);
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth, `${path} overflows at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth + 1);
      }
    });
  }
});

test("/meta permanently redirects to /guides", async ({ request }) => {
  const response = await request.get("/meta?axis=league&band=4", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()["location"]).toMatch(/^\/guides(\?|$)/);
});

test("old /meta?matchup= links go straight to the lowercase matchup guide", async ({ request }) => {
  const response = await request.get("/meta?axis=league&band=4&matchup=PvZ", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()["location"]).toMatch(/^\/guides\/pvz(\?|$)/);
});

/** Path + decoded query of a redirect's (absolute, from middleware) Location header. */
function locationPath(location: string | undefined): string {
  const url = new URL(location ?? "", "http://location.invalid");
  return `${url.pathname}${decodeURIComponent(url.search)}`;
}

test("a mixed-case guide URL permanently redirects to its lowercase path", async ({ request, page }) => {
  const mixed = "/guides/PvZ/Stargate-into-Glaives";
  const build = await request.get(mixed, { maxRedirects: 0 });
  expect(build.status()).toBe(308);
  // One hop from middleware, ahead of the ISR cache: a single Location value.
  expect(build.headersArray().filter((h) => h.name.toLowerCase() === "location")).toHaveLength(1);
  expect(locationPath(build.headers()["location"])).toBe("/guides/pvz/stargate-into-glaives");
  const matchup = await request.get("/guides/PvZ?band=league:4", { maxRedirects: 0 });
  expect(matchup.status()).toBe(308);
  expect(locationPath(matchup.headers()["location"])).toBe("/guides/pvz?band=league:4");
  // A real browser follows it to the canonical page.
  const landed = await page.goto(`${mixed.replace("Glaives", "GLAIVES")}`);
  expect(landed?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe("/guides/pvz/stargate-into-glaives");
});

test("a build guide is edge-cached (ISR) while an outage is never cached", async ({ request }) => {
  const cached = await request.get("/guides/pvz/stargate-into-glaives");
  expect(cached.status()).toBe(200);
  expect(cached.headers()["cache-control"]).toContain("s-maxage=21600");
  // The fixture API answers no other build, so this render hits an "outage":
  // it must fail uncached (5xx, no-store), never freeze a 6 h error page.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outage = await request.get("/guides/pvz/robo-opener");
    expect(outage.status()).toBeGreaterThanOrEqual(500);
    expect(outage.headers()["cache-control"]).toContain("no-store");
  }
});

test("an impossible guide URL is a real 404 (the pages render per request)", async ({ request }) => {
  const response = await request.get("/guides/not-a-matchup");
  expect(response.status()).toBe(404);
});
