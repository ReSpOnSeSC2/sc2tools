import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openFilterOverlaysFixture } from "./filter-overlays-fixture.mjs";

async function fitsViewport(page: Page, panel: Locator) {
  await expect(async () => {
    const box = await panel.boundingBox(); expect(box).not.toBeNull();
    const viewport = await page.evaluate(() => ({
      x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0,
      width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight,
    }));
    expect(box!.x).toBeGreaterThanOrEqual(viewport.x); expect(box!.y).toBeGreaterThanOrEqual(viewport.y);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5000 });
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

async function controlsFitHorizontally(panel: Locator) {
  expect(await panel.evaluate(node => {
    const panel = node.getBoundingClientRect();
    return [...node.querySelectorAll("button,input,select,summary,a,[role='radiogroup']")]
      .filter(control => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && (rect.left < panel.left - 1 || rect.right > panel.right + 1);
      }).map(control => control.getAttribute("aria-label") || control.textContent?.trim());
  })).toEqual([]);
}

const populatedApiData = {
  "/v1/random-summary": { perRace: { Protoss: { games: 8 }, Terran: { games: 4 } } },
  "/v1/game-accounts": { items: [
    { handle: "1-S2-1-123456", label: "Filter fixture NA", region: "NA", leagueId: 4, mmr: 4200 },
    { handle: "2-S2-1-654321", label: "Filter fixture EU", region: "EU", leagueId: 3, mmr: 3900 },
  ] },
};

for (const theme of ["light", "dark"] as const) {
  test(`${theme} phone filters fit without zoom and scroll through populated controls`, async ({ browser, browserName }, info) => {
    test.skip(browserName !== "chromium" || (info.project.use.viewport?.width ?? 360) >= 768,
      "Run mobile emulation once in the phone Chromium project.");
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 664 }]) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        const evidence = await openFilterOverlaysFixture(page, theme, { apiData: populatedApiData });
        await page.getByRole("button", { name: /^Filters/ }).click();
        const sheet = page.getByRole("dialog", { name: "Filters", exact: true });
        const done = sheet.getByRole("button", { name: "Done", exact: true });
        await fitsViewport(page, sheet); await controlsFitHorizontally(sheet);
        expect(await page.evaluate(() => window.visualViewport?.scale)).toBeCloseTo(1);
        await expect(done).toBeInViewport({ ratio: 1 });
        await sheet.getByLabel("My race", { exact: true }).selectOption("P");
        await expect(page.getByLabel("Wire filters")).toContainText("race=P");

        await sheet.getByText("Account · All accounts", { exact: true }).click();
        const accounts = sheet.getByRole("group", { name: "Your accounts", exact: true });
        await expect(accounts.getByRole("checkbox")).toHaveCount(2);
        await accounts.getByRole("checkbox").first().check();
        await expect(page.getByLabel("Wire filters")).toContainText("accounts=1-S2-1-123456");
        await controlsFitHorizontally(sheet);

        await dateTrigger(page).click();
        const dates = page.getByRole("dialog", { name: "Pick a date range", exact: true });
        await fitsViewport(page, dates);
        await page.keyboard.press("Escape"); await expect(dates).toBeHidden(); await expect(sheet).toBeVisible();
        await lengthTrigger(page).click();
        const length = page.getByRole("dialog", { name: "Custom game length", exact: true });
        await fitsViewport(page, length);
        await page.keyboard.press("Escape"); await expect(length).toBeHidden();

        const content = sheet.locator(":scope > div");
        const bodyBox = (await content.boundingBox())!;
        await page.mouse.move(bodyBox.x + bodyBox.width - 8, bodyBox.y + bodyBox.height / 2);
        await page.mouse.wheel(0, 2000);
        const help = sheet.getByRole("link", { name: "How filters work", exact: true });
        await expect(help).toBeInViewport({ ratio: 1 });
        expect(await content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        const checkbox = sheet.getByRole("checkbox", { name: "Hide games under 45 seconds", exact: true });
        await expect(checkbox).toBeInViewport({ ratio: 1 });
        await checkbox.uncheck(); await expect(checkbox).not.toBeChecked();
        await expect(done).toBeInViewport({ ratio: 1 });
        const helpBox = (await help.boundingBox())!, footerBox = (await sheet.locator("footer").boundingBox())!;
        expect(helpBox.y + helpBox.height).toBeLessThanOrEqual(footerBox.y + 1);
        await fitsViewport(page, sheet); await controlsFitHorizontally(sheet); await noSeriousAxe(page);
        await page.screenshot({ path: info.outputPath(`filters-${theme}-${viewport.width}-scroll.png`), fullPage: false });
        await done.click(); await expect(sheet).toBeHidden();
        expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  test(`${theme} phone filters and nested pickers follow pinch zoom while open`, async ({ browser, browserName }, info) => {
    test.skip(browserName !== "chromium" || (info.project.use.viewport?.width ?? 360) >= 768,
      "Pinch zoom emulation runs once in the phone Chromium project.");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const evidence = await openFilterOverlaysFixture(page, theme, { apiData: populatedApiData });
      const cdp = await context.newCDPSession(page);
      await page.getByRole("button", { name: /^Filters/ }).click();
      const sheet = page.getByRole("dialog", { name: "Filters", exact: true });
      const done = sheet.getByRole("button", { name: "Done", exact: true });
      await fitsViewport(page, sheet); await fitsViewport(page, done);
      await dateTrigger(page).click();
      const dates = page.getByRole("dialog", { name: "Pick a date range", exact: true });
      await fitsViewport(page, dates);

      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
      await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBeCloseTo(1.5);
      await fitsViewport(page, sheet); await fitsViewport(page, done); await fitsViewport(page, dates);
      await page.screenshot({ path: info.outputPath(`filters-${theme}-zoom-date.png`), fullPage: false });
      await page.keyboard.press("Escape"); await expect(dates).toBeHidden();
      await controlsFitHorizontally(sheet);
      await lengthTrigger(page).click();
      const length = page.getByRole("dialog", { name: "Custom game length", exact: true });
      await fitsViewport(page, length); await fitsViewport(page, done);
      await page.screenshot({ path: info.outputPath(`filters-${theme}-zoom-length.png`), fullPage: false });

      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBeCloseTo(1);
      await fitsViewport(page, sheet); await fitsViewport(page, done); await fitsViewport(page, length);
      await page.keyboard.press("Escape"); await expect(length).toBeHidden();
      await done.click(); await expect(sheet).toBeHidden();
      expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    } finally {
      await context.close();
    }
  });

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
