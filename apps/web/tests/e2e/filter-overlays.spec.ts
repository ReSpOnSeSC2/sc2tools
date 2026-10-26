import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openFilterOverlaysFixture } from "./filter-overlays-fixture.mjs";

async function fitsViewport(page: Page, panel: Locator) {
  const box = await panel.boundingBox(); expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}
function dateTrigger(page: Page) {
  return page.getByText("Date range", { exact: true }).first().locator("..").getByRole("button");
}
function lengthTrigger(page: Page) {
  return page.getByRole("group", { name: "Filter by game length" }).locator('button[aria-haspopup="dialog"]');
}
async function noSeriousAxe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.filter(row => row.impact === "serious" || row.impact === "critical")
    .map(row => ({ id: row.id, nodes: row.nodes.map(node => node.target) }))).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} date picker fits, preserves drafts and closes before its phone Sheet`, async ({ page }, info) => {
    const evidence = await openFilterOverlaysFixture(page, theme);
    const phone = page.viewportSize()!.width < 768;
    const filters = page.getByRole("button", { name: /^Filters/ });
    if (phone) await filters.click();
    const trigger = dateTrigger(page); await trigger.click();
    const picker = page.getByRole("dialog", { name: "Pick a date range", exact: true });
    await expect(picker).toBeVisible(); await expect(picker).not.toHaveAttribute("aria-modal");
    await expect(trigger).toHaveAttribute("aria-controls", await picker.getAttribute("id") as string);
    await fitsViewport(page, picker); await noSeriousAxe(page);
    await page.screenshot({ path: info.outputPath(`filters-${theme}-date.png`), fullPage: false });
    await picker.getByLabel("Start", { exact: true }).fill("2026-10-01");
    await picker.getByLabel("End", { exact: true }).fill("2026-10-07");
    await page.keyboard.press("Escape"); await expect(picker).toBeHidden(); await expect(trigger).toBeFocused();
    if (phone) await expect(page.getByRole("dialog", { name: "Filters", exact: true })).toBeVisible();
    await trigger.click(); await expect(picker.getByLabel("Start", { exact: true })).toHaveValue("2026-10-01");
    await picker.getByRole("button", { name: "Apply custom range", exact: true }).click();
    await expect(picker).toBeHidden(); await expect(trigger).toBeFocused();
    const wire = new URLSearchParams(await page.getByLabel("Wire filters").textContent() ?? "");
    expect(wire.get("since")).toContain("2026-10-01");
    expect(await page.evaluate(value => {
      const end = new Date(value ?? "");
      return [end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()];
    }, wire.get("until"))).toEqual([2026, 9, 7, 23, 59, 59, 999]);
    expect(wire.has("patch_era")).toBe(false);
    if (phone) {
      await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden(); await expect(filters).toBeFocused();
    } else {
      await trigger.click(); await page.mouse.move(4, 300); await page.mouse.wheel(0, 700);
      await expect.poll(async () => (await trigger.boundingBox())!.y).toBeLessThan(0);
      await fitsViewport(page, picker); await page.keyboard.press("Escape");
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });

  test(`${theme} nested length picker applies immediately, retains parent focus and releases on resize`, async ({ page }, info) => {
    const evidence = await openFilterOverlaysFixture(page, theme);
    const phone = page.viewportSize()!.width < 768;
    const filters = page.getByRole("button", { name: /^Filters/ }); await filters.click();
    const parent = page.getByRole("dialog", { name: phone ? "Filters" : "More filters", exact: true });
    const trigger = lengthTrigger(page); await trigger.click();
    const picker = page.getByRole("dialog", { name: "Custom game length", exact: true });
    await expect(picker).toBeVisible(); await expect(picker).not.toHaveAttribute("aria-modal");
    await fitsViewport(page, picker); await noSeriousAxe(page);
    await picker.getByRole("spinbutton", { name: "Min (min)" }).fill("31");
    await picker.getByRole("spinbutton", { name: "Max (min)" }).fill("9");
    await picker.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(picker).toBeHidden(); await expect(trigger).toBeFocused();
    await expect(page.getByLabel("Wire filters")).toContainText("min_minutes=9");
    await expect(page.getByLabel("Wire filters")).toContainText("max_minutes=31");
    await trigger.click(); await picker.getByRole("button", { name: "Clear", exact: true }).focus();
    if (phone) {
      await page.keyboard.press("Tab");
      expect(await parent.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape"); await expect(picker).toBeHidden(); await expect(parent).toBeVisible(); await expect(trigger).toBeFocused();
    await page.screenshot({ path: info.outputPath(`filters-${theme}-parent.png`), fullPage: false });
    if (!phone) {
      const outside = page.getByRole("button", { name: "Outside filter action", exact: true });
      await outside.click(); await expect(parent).toBeHidden(); await expect(outside).toBeFocused();
      await filters.click();
    }
    await trigger.click();
    await page.setViewportSize({ width: phone ? 1280 : 360, height: 800 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await expect(page.getByLabel("Wire filters")).toContainText("min_minutes=9");
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });
}
