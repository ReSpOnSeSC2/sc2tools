import { expect, test } from "@playwright/test";
import { openChartKitFixture } from "./chart-kit-fixture.mjs";
import { checkAccessibility } from "./accessibility-check";

for (const theme of ["light", "dark"] as const) {
  test(`matchup window inspection is visible and accessible in ${theme}`, async ({ page }, info) => {
    const evidence = await openChartKitFixture(page, "rating", { theme });
    const panel = page.getByRole("region", { name: "PvZ performance rating", exact: true });
    const select = panel.getByRole("combobox", { name: "PvZ rating window" });
    const status = panel.getByRole("status");
    const paths = () => panel.locator("svg path").evaluateAll(elements => elements.map(element => element.getAttribute("d")));
    const originalPaths = await paths();
    expect(originalPaths).toHaveLength(2);
    await expect(status).toContainText("Games 3–12");
    await expect(panel.locator("[data-rating-selection]")).toHaveCount(0);
    await expect(panel.locator("[data-rating-cursor]")).toHaveAttribute("x1", "235");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await select.selectOption("8");
      await expect(status).toContainText("Games 1–9");
      await expect(status).toContainText("4,200 performance rating");
      await expect(panel.locator('[data-rating-selection="8"]')).toBeVisible();
      const previousX = await panel.locator("[data-rating-selection]").getAttribute("cx");
      await select.focus();
      await select.press("ArrowDown");
      await expect(select).toHaveValue("9");
      await expect(status).toContainText("Games 1–10");
      await expect(status).toContainText("4,200 performance rating");
      expect(await panel.locator("[data-rating-selection]").getAttribute("cx")).not.toBe(previousX);
      await expect(select).toBeFocused();
      await select.selectOption("5");
      await expect(status).toContainText("Games 1–6");
      await expect(status).toContainText("No finite rating · 6/6 rated · 0 missing");
      await expect(panel.locator("[data-rating-selection]")).toHaveCount(0);
      const cursor = panel.locator('[data-rating-cursor="5"]');
      await expect(cursor).toHaveAttribute("x1", String(5 + 5 / 11 * 230));
      await expect(cursor).toHaveAttribute("x2", String(5 + 5 / 11 * 230));
      expect(await cursor.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(0);
      expect(await cursor.evaluate(element => getComputedStyle(element).stroke)).not.toBe("none");
      expect(await paths()).toEqual(originalPaths);
      await expect(panel.locator("strong")).toHaveText("4,100");
      await expect(panel.getByText("12-game estimate", { exact: true })).toBeVisible();
      const empty = page.getByRole("region", { name: "PvT performance rating", exact: true });
      await empty.getByRole("combobox").selectOption("0");
      await expect(empty.getByRole("status")).toContainText("Games 1–1");
      await expect(empty.getByRole("status")).toContainText("No finite rating · 1/1 rated · 0 missing");
      await expect(empty.locator("svg")).toHaveCount(0);
      await select.selectOption("9");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await checkAccessibility(page, info, `/fixture/rating/${width}`, theme);
      if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`rating-window-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
    }
    expect(evidence.errors).toEqual([]);
    expect(evidence.unexpectedRequests).toEqual([]);
  });
}
