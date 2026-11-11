import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { decodeReportComparison, encodeReportCard, reportCardLink } from "../../lib/instant/reportCardLink";
import { REPORT_CARD_PATH, REPORT_COMPARE_PATH, reportCardPreviewPath } from "../../lib/instant/reportCardRoute";
import { contrastRatio } from "../../scripts/contrast-tokens.mjs";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const fragment = encodeReportCard({
  totals: { games: 10, wins: 7, losses: 2 },
  matchups: [{ label: "vs P", wins: 3, losses: 1 }, { label: "vs Z", wins: 4, losses: 1 }],
  opener: { name: "TvT - Proxy Marauder", games: 4, wins: 3, losses: 1 },
  macro: { score: 72, games: 9 },
});
const ESCAPED_CARD_PATH = "/card/r%65port/%73ummary";
const SHARE_FIXTURE = path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay");

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

test("shows a noindex, self-reported card with accessible text", async ({ page }, info) => {
  if (!fragment) throw new Error("Invalid report card fixture");
  const requests: string[] = [];
  const site = new URL(String(info.project.use.baseURL)).origin;
  await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
  page.on("request", request => { requests.push(request.url()); });
  for (const theme of ["light", "dark"] as const) {
    await page.goto("about:blank");
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const cardPath = theme === "light" ? REPORT_CARD_PATH : ESCAPED_CARD_PATH;
    const response = await page.goto(`${cardPath}#${fragment}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByText(/numbers are self-reported/)).toBeVisible();
    await expect(page.getByText(/10 games, 7-2/)).toBeVisible();
    await expect(page.getByText("These numbers cover the games selected by the sharer.")).toBeVisible();
    const preview = page.getByRole("region", { name: "Shared replay report" });
    await expect(preview.locator("canvas")).toBeVisible();
    await expect.poll(() => preview.locator("canvas").evaluate((element: HTMLCanvasElement) =>
      element.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] ?? 0)).toBeGreaterThan(0);
    const action = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all" ? { name: "Make yours", href: "/try" } : { name: "Explore SC2 Tools", href: "/" };
    const makeYours = page.getByRole("link", { name: action.name });
    await expect(makeYours).toHaveAttribute("href", action.href);
    expect((await makeYours.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await assertNoOverflow(page);
    await checkAccessibility(page, info, REPORT_CARD_PATH, theme);
    await captureAccessibility(page, info, `report-card-${theme}`, true);
  }
  expect(requests.some(url => url.includes(fragment))).toBe(false);
  expect(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== site)).toEqual([]);
});

test("offers manual card-link copy when the browser denies clipboard access", { tag: "@slow" }, async ({ page }, info) => {
  test.skip(process.env.NEXT_PUBLIC_INSTANT_IMPORT !== "all", "the report requires public Instant Analysis");
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/try");
  await page.getByLabel("Replay files").setInputFiles(SHARE_FIXTURE);
  await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: /ReSpOnSe/ }).first().click();
  await expect(page.getByRole("heading", { name: "Your instant report" })).toBeVisible({ timeout: 120_000 });
  const share = page.getByRole("button", { name: "Share report", exact: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await share.click();
    const dialog = page.getByRole("dialog", { name: "Share your report" });
    const copy = dialog.getByRole("button", { name: "Copy card link", exact: true });
    await copy.scrollIntoViewIfNeeded();
    await captureAccessibility(page, info, `report-card-share-${theme}`);
    await copy.click();
    const field = dialog.getByRole("textbox", { name: "Copy card link manually" });
    await expect(field).toBeFocused();
    const link = new URL(await field.inputValue());
    expect(link.pathname).toBe(REPORT_CARD_PATH);
    expect(link.search).toBe("");
    expect(link.hash).toMatch(/^#[A-Za-z0-9_-]{1,59}$/);
    await assertNoOverflow(page);
    await dialog.getByRole("button", { name: "Done" }).scrollIntoViewIfNeeded();
    await expect(field).toBeFocused();
    await captureAccessibility(page, info, `report-card-copy-fallback-${theme}`);
    await field.press("Escape");
    await expect(copy).toBeFocused();
    await copy.press("Escape");
    await expect(share).toBeFocused();
  }
});

test("renders neutral missing, forged and oversized states", async ({ page }, info) => {
  for (const theme of ["light", "dark"] as const) {
    await page.goto("about:blank");
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(REPORT_CARD_PATH);
    await expect(page.getByText("No report card in this link")).toBeVisible();
    await captureAccessibility(page, info, `report-card-empty-${theme}`, true);
    for (const forged of ["<Private Name>", "AQEBAAICAQ", "X".repeat(400)]) {
      await page.evaluate(value => { window.location.hash = value; }, forged);
      await expect(page.getByText("This report card link is invalid")).toBeVisible();
      await expect(page.getByText(forged)).toHaveCount(0);
      await expect(page.locator("canvas")).toHaveCount(0);
      await assertNoOverflow(page);
    }
    await captureAccessibility(page, info, `report-card-invalid-${theme}`, true);
  }
  expect((await page.goto("/card/report/not-a-class"))?.status()).toBe(404);
});

async function buildComparison(page: Page, info: TestInfo, own: string, theme: "light" | "dark") {
  const field = page.getByRole("textbox", { name: "Your replay report link" });
  const form = page.locator("form").filter({ has: field });
  await field.fill("PrivateFixture");
  await field.press("Enter");
  await expect(form.getByRole("alert")).toHaveText("Paste a replay report card link that includes game totals.");
  await expect(field).toBeFocused();
  await captureAccessibility(page, info, `report-comparison-invalid-${theme}`, true);
  await field.fill(own);
  await field.press("Enter");
  const comparison = page.getByRole("region", { name: "Replay report comparison" });
  await expect(comparison).toBeFocused();
  await expect(comparison.getByRole("heading", { name: "You versus them" })).toBeVisible();
  await expect(comparison.getByText("4W 3L")).toBeVisible();
  await expect(comparison.getByText("7W 2L")).toBeVisible();
  await assertNoOverflow(page);
  await checkAccessibility(page, info, REPORT_CARD_PATH, theme);
  await captureAccessibility(page, info, `report-comparison-result-${theme}`, true);
  const copy = comparison.getByRole("button", { name: "Copy comparison link", exact: true });
  expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await copy.click();
  const manual = page.getByRole("dialog", { name: "Copy comparison link manually" }).getByRole("textbox", { name: "Comparison link" });
  await expect(manual).toBeFocused();
  const selection = await manual.evaluate(element => {
    const { color, backgroundColor } = getComputedStyle(element, "::selection");
    return [color, backgroundColor].map(paint => (paint.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number));
  });
  expect(contrastRatio(selection[0], selection[1]), `Selected link contrast in ${theme} mode`).toBeGreaterThanOrEqual(4.5);
  const link = new URL(await manual.inputValue());
  expect(link.pathname).toBe(REPORT_COMPARE_PATH);
  expect(link.search).toBe("");
  expect(decodeReportComparison(link.hash.slice(1))).toEqual({
    first: { games: 8, wins: 4, losses: 3 }, second: { games: 10, wins: 7, losses: 2 },
  });
  await assertNoOverflow(page);
  await captureAccessibility(page, info, `report-comparison-fallback-${theme}`);
  await manual.press("Escape");
  await expect(copy).toBeFocused();
  return link;
}

test("compares two selected reports locally and shares neutral results", async ({ page }, info) => {
  const own = reportCardLink({ totals: { games: 8, wins: 4, losses: 3 }, matchups: [], opener: null, macro: null });
  const withoutTotals = encodeReportCard({ totals: null, matchups: [], opener: null, macro: { score: 72, games: 9 } });
  if (!fragment || !own || !withoutTotals) throw new Error("Invalid comparison fixture");
  const requests: { url: string; method: string; body: string | null }[] = [];
  const site = new URL(String(info.project.use.baseURL)).origin;
  await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  page.on("request", request => { requests.push({ url: request.url(), method: request.method(), body: request.postData() }); });
  for (const theme of ["light", "dark"] as const) {
    await page.goto("about:blank");
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(`${REPORT_CARD_PATH}#${withoutTotals}`);
    await expect(page.getByText("A comparison needs game totals in both links.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare reports" })).toHaveCount(0);
    await assertNoOverflow(page);
    await captureAccessibility(page, info, `report-comparison-unavailable-${theme}`, true);
    await page.goto(`${REPORT_CARD_PATH}#${fragment}`);
    const link = await buildComparison(page, info, own, theme);
    const comparePath = theme === "light" ? REPORT_COMPARE_PATH : "/card/r%65port/c%6Fmpare";
    expect((await page.goto(`${comparePath}${link.hash}`))?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("heading", { name: "Report A" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Report B" })).toBeVisible();
    await assertNoOverflow(page);
    await checkAccessibility(page, info, REPORT_COMPARE_PATH, theme);
    await captureAccessibility(page, info, `report-comparison-${theme}`, true);
    await page.evaluate(value => { window.location.hash = value; }, fragment);
    await expect(page.getByText("This report card link is invalid")).toBeVisible();
    expect(requests.some(({ url }) => url.includes(link.hash.slice(1)))).toBe(false);
  }
  const ownFragment = new URL(own).hash.slice(1);
  expect(requests.some(({ url }) =>
    [fragment, ownFragment, withoutTotals, "PrivateFixture"].some(value => url.includes(value))
  )).toBe(false);
  expect(requests.filter(({ url, method, body }) => /^https?:/.test(url) && (
    new URL(url).origin !== site || method !== "GET" || body !== null
  ))).toEqual([]);
});

test("serves distinct fixed preview images for the two static classes", async ({ page }) => {
  const images: Buffer[] = [];
  for (const cardClass of ["summary", "compare"] as const) {
    await page.goto(cardClass === "summary" ? REPORT_CARD_PATH : REPORT_COMPARE_PATH);
    const imagePath = reportCardPreviewPath(cardClass);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", new RegExp(`${imagePath}$`));
    const response = await page.request.get(imagePath);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\/png/);
    const png = await response.body();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(await (await page.request.get(`${imagePath}?name=PrivateFixture`)).body()).toEqual(png);
    images.push(png);
  }
  expect(images[0].equals(images[1])).toBe(false);
  expect((await page.request.get("/card/report/not-a-class/opengraph-image")).status()).toBe(404);
});
