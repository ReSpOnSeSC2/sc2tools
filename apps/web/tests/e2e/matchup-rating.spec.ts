import { expect, test, type Locator, type Page } from "@playwright/test";
import { openChartKitFixture } from "./chart-kit-fixture.mjs";
import { checkAccessibility } from "./accessibility-check";

const widths = [320, 390, 768, 1440] as const;
const panelFor = (page: Page, matchup: string) => page.getByRole("region", { name: `${matchup} performance rating`, exact: true });
const sliderFor = (panel: Locator, matchup: string) => panel.getByRole("slider", { name: `${matchup} rating chart, select a game window`, exact: true });
const windowFor = (panel: Locator, matchup: string) => panel.getByRole("combobox", { name: `${matchup} rating window`, exact: true });

function onlyExplicitMatrix(project: string) {
  test.skip(["tablet-768", "desktop-1280"].includes(project), "The rating fixture covers its explicit viewport matrix once.");
}

async function expectSelection(panel: Locator, matchup: string, index: number, finite = true) {
  await expect(windowFor(panel, matchup)).toHaveValue(String(index));
  await expect(sliderFor(panel, matchup)).toHaveAttribute("aria-valuenow", String(index + 1));
  await expect(panel.locator(`[data-rating-cursor="${index}"]`)).toHaveCount(1);
  await expect(panel.locator("[data-rating-selection]")).toHaveCount(finite ? 1 : 0);
  if (finite) await expect(panel.locator(`[data-rating-selection="${index}"]`)).toBeVisible();
  else await expect(panel.getByRole("status")).toContainText("No finite rating");
}

async function pointCenter(panel: Locator, index: number) {
  const point = panel.locator(`[data-rating-point="${index}"]`);
  await point.scrollIntoViewIfNeeded();
  const bounds = await point.boundingBox();
  if (!bounds) throw new Error(`Rating point ${index} has no rendered bounds`);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function assertVerticalScale(panel: Locator) {
  const high = panel.locator("[data-rating-tick]").filter({ hasText: "5,632" });
  const low = panel.locator("[data-rating-tick]").filter({ hasText: "5,373" });
  await expect(high).toBeVisible(); await expect(low).toBeVisible();
  const highBounds = await high.boundingBox(), lowBounds = await low.boundingBox();
  expect(highBounds!.y).toBeLessThan(lowBounds!.y);
  expect(Math.abs(highBounds!.x + highBounds!.width - lowBounds!.x - lowBounds!.width)).toBeLessThanOrEqual(1);
  const peak = await panel.locator('[data-rating-point="3"]').boundingBox();
  const trough = await panel.locator('[data-rating-point="9"]').boundingBox();
  expect(peak!.y).toBeLessThan(trough!.y);
  // Labels sit beside the plot, rather than suggesting ratings are game positions.
  expect(highBounds!.x + highBounds!.width).toBeLessThanOrEqual(peak!.x + 1);
  await expect(panel.getByText("Game 1", { exact: true })).toBeVisible();
  await expect(panel.getByText("Game 11", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Game order\s*→/)).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`Matchup rating ${theme}: vertical scale and mouse/keyboard inspection at every width`, async ({ page }, info) => {
    onlyExplicitMatrix(info.project.name);
    test.setTimeout(90_000);
    const evidence = await openChartKitFixture(page, "rating", { theme });
    const panel = panelFor(page, "PvZ"), slider = sliderFor(panel, "PvZ");
    const paths = () => panel.locator("svg path").evaluateAll(elements => elements.map(element => element.getAttribute("d")));
    const originalPaths = await paths();
    expect(originalPaths).toHaveLength(2);
    await expect(slider).toHaveAttribute("aria-valuemax", "12");
    await expectSelection(panel, "PvZ", 11, false);
    await expect(panel.locator("strong")).toHaveText("4,100");

    for (const width of widths) {
      await page.setViewportSize({ width, height: 950 });
      await assertVerticalScale(panelFor(page, "PvP"));
      await page.mouse.click(...Object.values(await pointCenter(panel, 4)) as [number, number]);
      await expectSelection(panel, "PvZ", 4);
      await expect(panel.getByRole("status")).toContainText("Games 1–5");
      await expect(panel.getByRole("status")).toContainText("4,200 performance rating");
      await slider.press("ArrowRight");
      await expectSelection(panel, "PvZ", 5, false);
      await slider.press("ArrowRight");
      await expectSelection(panel, "PvZ", 6);
      await slider.press("Home"); await expectSelection(panel, "PvZ", 0);
      await slider.press("End"); await expectSelection(panel, "PvZ", 11, false);
      await slider.press("ArrowLeft"); await expectSelection(panel, "PvZ", 10);
      await slider.press("PageUp"); await expectSelection(panel, "PvZ", 11, false);
      await slider.press("PageDown");
      expect(Number(await slider.getAttribute("aria-valuenow"))).toBeLessThan(12);
      const pageIndex = Number(await slider.getAttribute("aria-valuenow")) - 1;
      await expect(windowFor(panel, "PvZ")).toHaveValue(String(pageIndex));
      await windowFor(panel, "PvZ").selectOption("8");
      await expectSelection(panel, "PvZ", 8);
      const selectionBefore = await panel.locator("[data-rating-selection]").getAttribute("style");
      await page.mouse.click(...Object.values(await pointCenter(panel, 10)) as [number, number]);
      await expectSelection(panel, "PvZ", 10);
      expect(await panel.locator("[data-rating-selection]").getAttribute("style")).not.toBe(selectionBefore);
      expect(await paths()).toEqual(originalPaths);
      await expect(panel.locator("strong")).toHaveText("4,100");
      await expect(panel.getByText("12-game estimate", { exact: true })).toBeVisible();
      await expect(panelFor(page, "PvT").getByText(/No finite window estimate yet/)).toBeVisible();
      await expect(panelFor(page, "PvT").getByRole("slider")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await checkAccessibility(page, info, `/fixture/matchup-rating/${width}`, theme);
      await page.screenshot({ path: info.outputPath(`matchup-rating-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });

  test(`Matchup rating ${theme}: real touch taps select dense and separated points`, async ({ browser }, info) => {
    onlyExplicitMatrix(info.project.name);
    test.setTimeout(60_000);
    const context = await browser.newContext({ viewport: { width: 320, height: 950 }, hasTouch: true, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage(), evidence = await openChartKitFixture(page, "rating", { theme });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 950 });
        const sparse = panelFor(page, "PvP");
        const peak = await pointCenter(sparse, 3);
        await page.touchscreen.tap(peak.x, peak.y);
        await expectSelection(sparse, "PvP", 3);
        await expect(sparse.getByRole("status")).toContainText("5,632 performance rating");
        await expect(sparse.locator("strong")).toHaveText("5,393");
        const dense = panelFor(page, "ZvZ");
        await expect(sliderFor(dense, "ZvZ")).toHaveAttribute("aria-valuemax", "50");
        for (const index of [1, 24, 25, 49]) {
          const point = await pointCenter(dense, index);
          await page.touchscreen.tap(point.x, point.y);
          await expectSelection(dense, "ZvZ", index);
        }
        await expect(dense.locator("strong")).toHaveText("3,550");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      }
      expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    } finally { await context.close(); }
  });
}
