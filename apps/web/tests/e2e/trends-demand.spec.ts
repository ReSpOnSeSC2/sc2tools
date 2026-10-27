import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { closeTrendsDemandFixtureServer, openTrendsDemandFixture } from "./trends-demand-fixture.mjs";

type TrendsWindow = typeof window & {
  trendsSetFilters: (patch: Record<string, string>) => void;
  trendsSetOwner: (owner: string) => void;
  trendsSetCohort: (cohort: Record<string, string[]>) => void;
  trendsBumpRevision: () => void;
  trendsHoldTokens: () => void;
  trendsReleaseTokens: () => void;
  trendsNavigation: unknown[];
};
const shots = path.resolve(process.env.TRENDS_DEMAND_SHOTS_DIR ?? path.join("../../.cache", `trends-demand-browser-${Date.now()}`));
const nav = (page: Page, label: string) => page.getByRole("navigation", { name: "Trend sections" }).getByRole("button", { name: label, exact: true });
const settle = async (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function passiveSection(page: Page, id: string) {
  await page.locator(`#trends-${id}`).evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 100));
  await settle(page);
}
async function choosePeriods(page: Page) {
  const compact = page.getByRole("combobox", { name: "Choose performance analysis" });
  if (await compact.isVisible()) await compact.selectOption("periods");
  else await page.getByRole("button", { name: "Compare periods", exact: true }).click();
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

test.afterEach(async ({}, info) => {
  const receipt = await closeTrendsDemandFixtureServer();
  expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false);
  await info.attach("trends-loopback-cleanup", { contentType: "application/json", body: JSON.stringify(receipt) });
});

for (const theme of ["light", "dark"] as const) {
  test(`Trends ${theme}: demand, native navigation, filters and retained controls`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const evidence = await openTrendsDemandFixture(page, { theme });
    await expect(page.getByText("320", { exact: true }).first()).toBeVisible();
    await settle(page);
    await expect.poll(() => evidence.reads.every(row => row.settled)).toBe(true);
    const cold = evidence.summary();
    expect(evidence.reads.filter(row => row.path === "/v1/timeseries")).toHaveLength(2);
    expect(evidence.reads.every(row => ["/v1/timeseries", "/v1/timeseries/matchups"].includes(row.path))).toBe(true);
    expect(evidence.reads.some(row => row.path === "/v1/momentum")).toBe(false);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("TrendsHanken");
    await noOverflow(page); await checkAccessibility(page, info, "/trends-demand-initial", theme);
    await mkdir(shots, { recursive: true });
    if (info.project.name === "desktop-1280" && theme === "light") await page.screenshot({ path: path.join(shots, "trends-demand-light-1280.png") });
    if (info.project.name === "mobile-360" && theme === "light") await page.screenshot({ path: path.join(shots, "trends-demand-light-360.png") });

    evidence.phase("filter-before-lower-charts");
    await page.evaluate(() => (window as TrendsWindow).trendsSetFilters({ map: "Changed map", build: "Synthetic opening" }));
    await expect.poll(() => evidence.reads.filter(row => row.phase === "filter-before-lower-charts" && row.path === "/v1/timeseries").length).toBe(2);
    expect(evidence.reads.some(row => row.path === "/v1/length-buckets")).toBe(false);
    const filterValue = await page.getByLabel("Fixture filter state").textContent();
    const href = page.url(), draft = page.getByRole("textbox", { name: "Unrelated fixture draft" });
    await draft.focus();
    evidence.phase("passive-approach");
    await passiveSection(page, "performance");
    // The first gesture admits the above Matchup card. Continue reading after its real height is rendered.
    await expect(page.getByRole("combobox", { name: "PvZ rating window" })).toBeVisible();
    await expect(page.getByText("16-game estimate", { exact: true })).toHaveCount(1);
    await expect.poll(() => evidence.reads.every(row => row.settled)).toBe(true);
    await settle(page);
    await passiveSection(page, "performance");
    await expect(nav(page, "Performance & MMR")).toHaveAttribute("aria-current", "location");
    await expect(draft).toBeFocused(); expect(page.url()).toBe(href);
    expect(await page.getByLabel("Fixture filter state").textContent()).toBe(filterValue);
    expect(await page.evaluate(() => (window as TrendsWindow).trendsNavigation)).toEqual([]);
    await expect(page.getByRole("heading", { name: "MMR progression", exact: true })).toBeVisible();
    const mmr = evidence.reads.filter(row => row.path === "/v1/timeseries/mmr");
    expect(mmr.length).toBeGreaterThan(0);
    expect(new URLSearchParams(mmr.at(-1)!.search).get("map")).toBe("Changed map");
    expect(new URLSearchParams(mmr.at(-1)!.search).get("build")).toBe("Synthetic opening");

    evidence.phase("explicit-time-jump");
    await nav(page, "Time & activity").click();
    const timeHeading = page.getByRole("heading", { name: "Time & activity", exact: true });
    await expect(timeHeading).toBeFocused();
    await expect(page.getByRole("combobox", { name: "Time format" })).toBeVisible();
    expect(evidence.reads.filter(row => row.path === "/v1/length-buckets")).toHaveLength(1);
    const headingBounds = await timeHeading.boundingBox(), navBounds = await page.getByRole("navigation", { name: "Trend sections" }).boundingBox();
    expect(headingBounds!.y).toBeGreaterThanOrEqual(navBounds!.y + navBounds!.height);
    await noOverflow(page); await checkAccessibility(page, info, "/trends-demand-time", theme);
    if (info.project.name === "tablet-768") await page.screenshot({ path: path.join(shots, `trends-demand-${theme}-768.png`) });

    await nav(page, "Overview").click();
    const inspect = page.getByRole("combobox", { name: "PvZ rating window" });
    await expect(inspect).toBeVisible(); await inspect.selectOption("7");
    await inspect.evaluate(element => element.setAttribute("data-retention-proof", "original-inspect"));
    const matchupRequests = evidence.reads.filter(row => row.path === "/v1/timeseries/matchups").length;
    await passiveSection(page, "performance");
    await page.evaluate(() => window.scrollTo(0, 0)); await settle(page);
    await expect(inspect).toHaveValue("7"); await expect(inspect).toHaveAttribute("data-retention-proof", "original-inspect");
    expect(evidence.reads.filter(row => row.path === "/v1/timeseries/matchups")).toHaveLength(matchupRequests);
    await expect(page.getByText("16-game estimate", { exact: true })).toHaveCount(1);

    await nav(page, "Explorer").click(); await choosePeriods(page);
    const period = page.getByLabel("Period A start", { exact: true });
    await period.fill("2026-09-02"); await expect(page.getByText("Unapplied changes", { exact: true })).toBeVisible();
    const explorerRequests = evidence.reads.filter(row => row.path.includes("/trends/explorer/")).length;
    await passiveSection(page, "performance"); await passiveSection(page, "explorer");
    await expect(period).toHaveValue("2026-09-02");
    expect(evidence.reads.filter(row => row.path.includes("/trends/explorer/"))).toHaveLength(explorerRequests);
    await checkAccessibility(page, info, "/trends-demand-explorer", theme); await noOverflow(page);
    if (theme === "dark" && info.project.name !== "tablet-768") await page.screenshot({ path: path.join(shots, `trends-demand-dark-${info.project.name === "mobile-360" ? "360" : "1280"}.png`) });
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
    await info.attach("actual-trends-get-ledger", { contentType: "application/json", body: JSON.stringify({ cold, final: evidence.summary(), reads: evidence.reads, metadata: evidence.metadata }) });
  });

  test(`Global Trends ${theme}: current cohort, collapsed activation and independent reads`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const evidence = await openTrendsDemandFixture(page, { theme, mode: "global" });
    await expect(page.getByText("320", { exact: true }).first()).toBeVisible();
    expect(await nav(page, "Fingerprint").count()).toBe(0);
    const performance = page.getByRole("heading", { name: "Performance & MMR", exact: true });
    await performance.getByRole("button").click();
    await expect(performance.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await nav(page, "Performance & MMR").click();
    await expect(performance).toBeFocused(); await expect(performance.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("heading", { name: "Average MMR over time", exact: true })).toBeVisible();
    evidence.phase("cohort-change");
    await page.evaluate(() => (window as TrendsWindow).trendsSetCohort({ excluded_players: ["new-exclusion"], included_players: ["synthetic-player"] }));
    await expect.poll(() => evidence.reads.filter(row => row.phase === "cohort-change" && row.path.endsWith("/momentum")).length).toBe(1);
    for (const row of evidence.reads.filter(row => row.phase === "cohort-change")) {
      expect(row.path.startsWith("/v1/admin/global-trends/")).toBe(true);
      expect(new URLSearchParams(row.search).get("excluded_players")).toBe("new-exclusion");
      expect(new URLSearchParams(row.search).get("included_players")).toBe("synthetic-player");
    }
    expect(evidence.reads.some(row => row.path.includes("fingerprint"))).toBe(false);
    await noOverflow(page); await checkAccessibility(page, info, "/trends-demand-global", theme);
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
    await info.attach("global-trends-get-ledger", { contentType: "application/json", body: JSON.stringify({ summary: evidence.summary(), reads: evidence.reads }) });
  });
}

test("Trends fallback remains usable and held owner tokens/bodies cannot publish", async ({ page }, info) => {
  test.setTimeout(120_000);
  const evidence = await openTrendsDemandFixture(page, { observer: false });
  await expect(page.getByRole("combobox", { name: "PvZ rating window" })).toBeVisible();
  await expect.poll(() => evidence.reads.some(row => row.path === "/v1/me/fingerprint")).toBe(true);
  await page.evaluate(() => { const fixture = window as TrendsWindow; fixture.trendsHoldTokens(); fixture.trendsSetOwner("owner-b"); });
  await settle(page);
  expect(evidence.reads.some(row => row.owner === "owner-b")).toBe(false);
  await page.evaluate(() => { const fixture = window as TrendsWindow; fixture.trendsSetOwner("owner-a"); fixture.trendsReleaseTokens(); });
  await settle(page);
  expect(evidence.reads.some(row => row.owner === "owner-b")).toBe(false);

  evidence.holdNext((row: { owner: string; path: string }) => row.owner === "owner-a" && row.path === "/v1/timeseries/matchups", (value: { ratingSeries: Array<{ perfRating: number | null }> }) => ({ ...value, ratingSeries: value.ratingSeries.map(row => ({ ...row, perfRating: 9876 })) }));
  await page.evaluate(() => (window as TrendsWindow).trendsBumpRevision());
  await expect.poll(() => evidence.reads.some(row => row.owner === "owner-a" && row.path === "/v1/timeseries/matchups" && !row.settled)).toBe(true);
  await page.evaluate(() => (window as TrendsWindow).trendsSetOwner("owner-b"));
  await expect(page.getByText("4,321", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as TrendsWindow).trendsSetOwner("owner-a"));
  await evidence.releaseAll(); await settle(page);
  await expect(page.getByText("9,876", { exact: true })).toHaveCount(0);
  await noOverflow(page); await checkAccessibility(page, info, "/trends-demand-fallback-owner", "dark");
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
  await info.attach("owner-trends-get-ledger", { contentType: "application/json", body: JSON.stringify({ reads: evidence.reads, summary: evidence.summary() }) });
});

test("Trends retries only the failed independent analysis with filters retained", async ({ page }, info) => {
  const evidence = await openTrendsDemandFixture(page);
  evidence.failNext((row: { path: string }) => row.path === "/v1/momentum");
  await nav(page, "Performance & MMR").click();
  const section = page.locator('[data-deferred-chart="Session patterns"]');
  await expect(section.getByRole("alert")).toBeVisible();
  const href = page.url(), before = evidence.reads.filter(row => row.path === "/v1/momentum").length;
  await section.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(section.getByRole("alert")).toHaveCount(0);
  expect(evidence.reads.filter(row => row.path === "/v1/momentum")).toHaveLength(before + 1);
  expect(page.url()).toBe(href);
  expect(new URLSearchParams(evidence.reads.filter(row => row.path === "/v1/momentum").at(-1)!.search).get("race")).toBe("P");
  await checkAccessibility(page, info, "/trends-demand-retry", "dark");
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
});
