import { expect, test, type Page } from "@playwright/test";
import { openChartKitFixture } from "./chart-kit-fixture.mjs";
import { checkAccessibility } from "./accessibility-check";

const widths = [320, 390, 768, 1440] as const;
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function globalColors(page: Page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement), rgb = (name: string) => `rgb(${css.getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
    return { low: rgb("--chart-low-sample"), amber: rgb("--chart-wr-mid"), surface: rgb("--bg-surface"), tooltip: rgb("--bg-elevated") };
  });
}
async function verifyGlobalColors(page: Page) {
  const colors = await globalColors(page);
  await expect(page.getByTestId("global-low-sample")).toHaveCSS("color", colors.low);
  // Chromium serializes color-mix as color(srgb ...), even at an exact stop.
  // Compare rendered channels with the theme token rather than CSS spellings.
  const amber = await page.getByTestId("global-amber").evaluate((element, expected) => {
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d"); if (!context) throw new Error("sRGB canvas unavailable");
    const channels = (color: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    return { actual: channels(getComputedStyle(element).color), expected: channels(expected) };
  }, colors.amber);
  expect(amber.actual).toEqual(amber.expected);
}
async function table(page: Page, title: string) {
  const frame = page.getByRole("region", { name: title, exact: true });
  await frame.getByRole("button", { name: `View as table · ${title}`, exact: true }).click();
  const scroller = frame.getByRole("region", { name: `${title} data table`, exact: true });
  await scroller.focus(); await expect(scroller).toBeFocused();
  if (await scroller.evaluate(element => element.scrollWidth > element.clientWidth + 1)) {
    await scroller.press("ArrowRight"); await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
  return { frame, table: frame.getByRole("table"), scroller, async back() { await frame.getByRole("button", { name: `Show chart · ${title}`, exact: true }).click(); await settled(page); } };
}
async function actualTicks(page: Page, group: string) {
  const ticks = group === "macro" ? page.locator('[data-testid="mechanics-trend-chart"] text') : page.locator(".recharts-cartesian-axis-tick-value");
  expect(await ticks.count()).toBeGreaterThan(0);
  expect(await ticks.evaluateAll(elements => elements.every(element => getComputedStyle(element).fontSize === "12px"))).toBe(true);
}
async function comparisonScaleGaps(page: Page, group: string) {
  const scales = page.getByTestId("comparison-scale");
  if (group === "mmr" || group === "macro") expect(await scales.count()).toBeGreaterThan(0);
  for (const scale of await scales.all()) {
    const labels = scale.locator("span");
    await expect(labels).toHaveText(["0%", "50%", "100%"]);
    for (const label of await labels.all()) await expect(label).toBeVisible();
    const bounds = await labels.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent, left: rect.left, right: rect.right };
    }));
    for (let index = 1; index < bounds.length; index++) {
      expect(bounds[index].left - bounds[index - 1].right, `${group} comparison labels ${bounds[index - 1].text} and ${bounds[index].text} must have a positive gap`).toBeGreaterThan(0);
    }
  }
}
async function lastAction(page: Page) { return JSON.parse((await page.getByLabel("Last fixture action").textContent()) || "null"); }
function onlyExplicitMatrix(project: string) { test.skip(["tablet-768", "desktop-1280"].includes(project), "The fixture covers all four explicit viewport widths once."); }

for (const group of ["mmr", "macro", "h2h"] as const) for (const theme of ["light", "dark"] as const) {
  test(`chart kit ${group} ${theme}: responsive data, real theme and table contracts`, async ({ page }, info) => {
    onlyExplicitMatrix(info.project.name);
    const evidence = await openChartKitFixture(page, group, { theme });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 950 }); await settled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await actualTicks(page, group); await verifyGlobalColors(page); await comparisonScaleGaps(page, group);
      await checkAccessibility(page, info, `/fixture/chart-kit/${group}/${width}`, theme);
      await page.screenshot({ path: info.outputPath(`chart-kit-${group}-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
    }
    await page.setViewportSize({ width: 390, height: 900 }); await settled(page);
    if (group === "mmr") {
      const bands = await table(page, "Win rate by MMR band");
      await expect(bands.table).toContainText("20%"); await expect(bands.table).toContainText("Below minimum"); await bands.back();
      const experience = await table(page, "Build experience curve");
      await expect(experience.table).toContainText("12W–12L"); await expect(experience.table).toContainText("24"); await experience.back();
      const progression = await table(page, "MMR progression by build"); await expect(progression.table).toContainText("4230"); await progression.back();
      const ratings = await table(page, "MMR progression"); await expect(ratings.table).toContainText("NA fixture 1 / P"); await expect(ratings.table).toContainText("KR fixture 9 / P"); await ratings.back();
      const plot = page.getByRole("region", { name: "MMR progression", exact: true });
      expect(await plot.locator(".recharts-line-curve[stroke-dasharray]").count()).toBeGreaterThan(0);
    } else if (group === "macro") {
      const trend = page.getByTestId("mechanics-trend-chart");
      await expect(trend.locator('circle[data-n="19"]')).toHaveAttribute("data-hollow", "true");
      await expect(trend.locator('circle[data-n="unknown"]')).toHaveAttribute("data-hollow", "true");
      await expect(trend.locator('circle[data-n="20"]')).toHaveAttribute("data-hollow", "false");
      const macro = await table(page, "Macro score over time"); await expect(macro.table).toContainText("61"); await expect(macro.table).toContainText("Unavailable"); await macro.back();
      await page.getByRole("button", { name: "Games with macro Below 60", exact: true }).click();
      expect(await lastAction(page)).toEqual({ kind: "drill", title: "Games with macro Below 60", params: { macro_max: 60 } });
      const scores = await table(page, "Macro score and results"); await expect(scores.table).toContainText("37%"); await scores.table.getByRole("button", { name: "80+", exact: true }).click();
      expect(await lastAction(page)).toEqual({ kind: "drill", title: "Games with macro 80+", params: { macro_min: 80 } }); await scores.back();
      const small = page.getByRole("region", { name: "Small recent form", exact: true }), established = page.getByRole("region", { name: "Established recent form", exact: true });
      expect(await small.locator('[data-hollow="true"]').count()).toBe(3); expect(await established.locator('[data-hollow="false"]').count()).toBe(20);
      const form = await table(page, "Small recent form"); expect(await form.table.getByRole("row").allTextContents()).toEqual(["Game, oldest firstResult", "1Loss", "2Loss", "3Win"]); await form.back();
    } else {
      const timeline = page.getByRole("figure", { name: "Match-by-match timeline", exact: true });
      const circles = timeline.locator(".recharts-line-dots circle"); expect(await circles.count()).toBeGreaterThanOrEqual(25);
      const colors = await globalColors(page);
      await expect(circles.first()).toHaveCSS("fill", colors.surface);
      expect(await circles.nth(19).evaluate(element => getComputedStyle(element).fill)).not.toBe(colors.surface);
      await circles.first().hover();
      const tooltip = page.getByRole("tooltip").filter({ hasText: "Cum. WR" }); await expect(tooltip).toBeVisible(); await expect(tooltip).toHaveCSS("background-color", colors.tooltip);
      await circles.first().click(); expect(await lastAction(page)).toEqual({ kind: "game", id: "fixture-game-1" });
      await timeline.focus(); await timeline.press("End"); await timeline.press("Enter"); expect(await lastAction(page)).toEqual({ kind: "game", id: "fixture-game-25" });
      const count = await page.getByLabel("Fixture action count").textContent();
      const periods = await table(page, "Games per day"); await expect(periods.table).toContainText("20"); expect(await page.getByLabel("Fixture action count").textContent()).toBe(count); await periods.back();
      const match = await table(page, "Match-by-match timeline"); await match.table.getByRole("button", { name: "Select #2", exact: true }).click(); expect(await lastAction(page)).toEqual({ kind: "game", id: "fixture-game-2" }); await match.back();
      const streak = page.getByRole("region", { name: "Streaks and momentum", exact: true }); await streak.locator("summary").click(); await streak.getByRole("button", { name: /W4/ }).first().click(); expect(await lastAction(page)).toEqual({ kind: "game", id: "fixture-game-1" });
      const streakTable = await table(page, "Streaks and momentum"); expect(await streakTable.table.getByRole("row").count()).toBe(26); await streakTable.back();
      expect(evidence.handledMapRequests.length).toBeGreaterThan(0);
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });
}

test("chart colors and global low-sample/amber styles update on a live theme switch", async ({ page }, info) => {
  onlyExplicitMatrix(info.project.name); const evidence = await openChartKitFixture(page, "mmr", { theme: "dark" });
  const curve = page.getByRole("region", { name: "MMR progression", exact: true }).locator(".recharts-line-curve").first();
  const before = await curve.evaluate(element => getComputedStyle(element).stroke);
  await page.getByRole("button", { name: "Switch fixture theme" }).click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => curve.evaluate(element => getComputedStyle(element).stroke)).not.toBe(before); await verifyGlobalColors(page);
  const values = await table(page, "Win rate by MMR band"); await expect(values.table).toContainText("20%");
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});

test("reduced motion keeps charts static and streak selection works without its pulse", async ({ page }, info) => {
  onlyExplicitMatrix(info.project.name); const evidence = await openChartKitFixture(page, "h2h", { reducedMotion: true });
  await expect(page.getByTestId("chart-theme-key")).toHaveAttribute("data-reduced", "true");
  const paths = await page.locator(".recharts-line-curve").evaluateAll(elements => elements.map(element => element.getAttribute("d")));
  const streak = page.getByRole("region", { name: "Streaks and momentum", exact: true }); await streak.locator("summary").click(); await streak.getByRole("button", { name: /W4/ }).first().click();
  expect(await lastAction(page)).toEqual({ kind: "game", id: "fixture-game-1" }); expect(await page.locator('[class*="animate-pulse"]').count()).toBe(0);
  expect(await page.locator("svg animate,svg animateTransform").count()).toBe(0); await settled(page);
  expect(await page.locator(".recharts-line-curve").evaluateAll(elements => elements.map(element => element.getAttribute("d")))).toEqual(paths);
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});
