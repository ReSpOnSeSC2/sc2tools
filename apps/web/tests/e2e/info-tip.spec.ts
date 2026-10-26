import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { closeInfoTipFixtureServer, openInfoTipFixture } from "./info-tip-fixture.mjs";

test.afterAll(async ({ browserName }, info) => {
  const transport = await closeInfoTipFixtureServer();
  expect(transport.closed).toBe(true);
  await info.attach("info-tip-transport-cleanup", { body: JSON.stringify({ browserName, ...transport }), contentType: "application/json" });
});

type TipWindow = typeof window & {
  fixtureTipTerm: (id: string) => void;
  fixtureTipLater: () => void;
  fixtureTipNavigate: (path: string) => void;
  fixtureDefinitionFailure: boolean;
  fixtureDefinitionLookups: string[];
  fixtureGroupingWrites: boolean[];
};
async function fits(page: Page, panel: Locator) {
  const box = (await panel.boundingBox())!, viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(15); expect(box.y).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 15);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function proof(evidence: Awaited<ReturnType<typeof openInfoTipFixture>>, info: TestInfo, page: Page) {
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
  await info.attach("info-tip-proof", { body: JSON.stringify({ buildId: evidence.buildId, cssNames: evidence.cssNames,
    definitionLoads: evidence.definitionLoads, serverRequests: evidence.serverRequests, selectionWrites: await page.evaluate(() => (window as TipWindow).fixtureGroupingWrites), rejectedWrites: evidence.rejectedWrites, externalAttempts: evidence.externalAttempts }), contentType: "application/json" });
}

for (const theme of ["light", "dark"] as const) {
  test(`InfoTip ${theme}: keyboard, pointer, grouping, Help and glossary anchors`, async ({ page }, info) => {
    const evidence = await openInfoTipFixture(page, theme);
    const trigger = page.getByRole("button", { name: "About Net MMR", exact: true });
    expect(evidence.definitionLoads).toEqual([]);
    await trigger.focus(); await page.keyboard.press("Enter");
    const tip = page.getByRole("dialog", { name: "About Net MMR", exact: true });
    const more = tip.getByRole("link", { name: "Learn more", exact: true });
    await expect(more).toBeVisible(); expect(evidence.definitionLoads).toHaveLength(1);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute("aria-controls", (await tip.getAttribute("id"))!);
    const described = await trigger.getAttribute("aria-describedby"); expect(described).toBeTruthy();
    await expect(page.locator(`[id="${described}"]`)).toContainText("verified pairs");
    expect(await tip.evaluate(node => node.parentElement === document.body)).toBe(true);
    await expect(tip).not.toHaveAttribute("aria-modal", "true");
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    const target = (await trigger.boundingBox())!; expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
    await fits(page, tip); await checkAccessibility(page, info, "/info-tip/ready", theme);
    await captureAccessibility(page, info, `info-tip-${theme}-ready`);
    await page.keyboard.press("Escape"); await expect(tip).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.keyboard.press("Space"); await expect(more).toBeVisible();
    const outside = page.getByRole("button", { name: "Outside action", exact: true });
    await outside.click(); await expect(tip).toHaveCount(0); await expect(outside).toBeFocused();

    const group = page.getByRole("switch", { name: "Group same player", exact: true });
    await expect(group).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "About Group same player", exact: true }).click();
    const groupTip = page.getByRole("dialog", { name: "About Group same player", exact: true });
    await expect(groupTip.getByText(/Merges accounts/)).toBeVisible();
    await expect(group).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => (window as TipWindow).fixtureGroupingWrites)).toEqual([]);
    await page.keyboard.press("Escape"); await group.click(); await expect(group).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => (window as TipWindow).fixtureGroupingWrites)).toEqual([false]);

    const parentOpener = page.getByRole("button", { name: "Open tip parent", exact: true }); await parentOpener.click();
    const parent = page.getByRole("dialog", { name: "InfoTip parent", exact: true });
    const childTrigger = parent.getByRole("button", { name: "About Toon", exact: true }); await childTrigger.click();
    const child = page.getByRole("dialog", { name: "About Toon", exact: true });
    await expect(child.getByRole("link", { name: "Learn more", exact: true })).toBeVisible();
    expect(await child.evaluate(node => node.parentElement === document.body)).toBe(true);
    await page.evaluate(() => (window as TipWindow).fixtureTipLater());
    const later = page.getByRole("dialog", { name: "Later tip dialog", exact: true }); await expect(later).toBeVisible();
    await page.keyboard.press("Escape"); await expect(later).toHaveCount(0); await expect(child).toBeVisible();
    await page.keyboard.press("Escape"); await expect(child).toHaveCount(0); await expect(childTrigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape"); await expect(parent).toHaveCount(0); await expect(parentOpener).toBeFocused();

    await trigger.click(); await more.click(); await expect(page).toHaveURL(/\/help\/glossary#net-mmr$/);
    await expect(page.locator("#net-mmr")).toBeVisible(); await expect(page.getByRole("term")).toHaveCount(7);
    const search = page.getByRole("textbox", { name: "Search glossary", exact: true });
    await search.fill("look-alike"); await expect(page.getByRole("term")).toHaveText("Barcode");
    await expect(page.getByRole("status")).toHaveText("1 term");
    await page.getByRole("link", { name: "Group same player", exact: true }).click();
    await expect(page.locator("#group-same-player")).toBeFocused(); await expect(search).toHaveValue("");
    await expect(page.getByRole("term")).toHaveCount(7);
    await checkAccessibility(page, info, "/help/glossary", theme);
    await captureAccessibility(page, info, `glossary-${theme}-public`);
    await page.evaluate(() => (window as TipWindow).fixtureTipNavigate("/example"));
    const helpSearch = page.getByRole("searchbox", { name: "Search help", exact: true });
    await helpSearch.fill("look-alike characters");
    await expect(page.getByRole("region", { name: "Help search example", exact: true }).getByRole("link", { name: /^Glossary/ })).toBeVisible();
    await proof(evidence, info, page);
  });

  test(`InfoTip ${theme}: held import cannot reopen a retired ABA term`, async ({ page }, info) => {
    const evidence = await openInfoTipFixture(page, theme, { holdDefinitions: true });
    await page.getByRole("button", { name: "About Net MMR", exact: true }).click();
    await expect.poll(evidence.heldCount).toBe(1);
    await expect(page.getByRole("dialog", { name: "About Net MMR", exact: true }).getByRole("status")).toHaveText("Loading definition…");
    await page.evaluate(() => (window as TipWindow).fixtureTipTerm("pulse-id"));
    await expect(page.getByRole("button", { name: "About Pulse ID", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => (window as TipWindow).fixtureTipTerm("net-mmr"));
    const trigger = page.getByRole("button", { name: "About Net MMR", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
    evidence.releaseDefinitions();
    await expect.poll(() => page.evaluate(() => (window as TipWindow).fixtureDefinitionLookups.length)).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click(); const tip = page.getByRole("dialog", { name: "About Net MMR", exact: true });
    await expect(tip.getByRole("heading", { name: "Net MMR", exact: true })).toBeVisible();
    await expect(tip.getByRole("link", { name: "Learn more", exact: true })).toHaveAttribute("href", "/help/glossary#net-mmr");
    await checkAccessibility(page, info, "/info-tip/retired", theme); await proof(evidence, info, page);
  });

  test(`InfoTip ${theme}: held definitions time out and require explicit retry`, async ({ page }, info) => {
    test.setTimeout(25_000);
    const evidence = await openInfoTipFixture(page, theme, { holdDefinitions: true });
    await page.getByRole("button", { name: "About Net MMR", exact: true }).click();
    await expect.poll(evidence.heldCount).toBe(1);
    const tip = page.getByRole("dialog", { name: "About Net MMR", exact: true });
    await expect(tip.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await expect(tip.getByRole("link", { name: "Learn more", exact: true })).toHaveCount(0);
    evidence.releaseDefinitions();
    await expect.poll(() => page.evaluate(() => (window as TipWindow).fixtureDefinitionLookups.length)).toBe(1);
    await expect(tip.getByRole("alert")).toBeVisible();
    await tip.getByRole("button", { name: "Retry definition", exact: true }).click();
    await expect(tip.getByRole("link", { name: "Learn more", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => { (window as TipWindow).fixtureDefinitionFailure = true; });
    await page.getByRole("button", { name: "About Net MMR", exact: true }).click();
    await expect(tip.getByRole("alert")).toBeVisible();
    await page.evaluate(() => { (window as TipWindow).fixtureDefinitionFailure = false; });
    await tip.getByRole("button", { name: "Retry definition", exact: true }).click();
    await expect(tip.getByRole("link", { name: "Learn more", exact: true })).toBeVisible();
    await fits(page, tip); await checkAccessibility(page, info, "/info-tip/retry", theme);
    await captureAccessibility(page, info, `info-tip-${theme}-retry`);
    await proof(evidence, info, page);
  });

  test(`Glossary ${theme}: compact phone anchors, native new tab and held tip under a newer Modal`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-360", "One explicit 320/390 matrix supplements the original viewport flows.");
    test.setTimeout(60_000);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const evidence = await openInfoTipFixture(page, theme, { holdDefinitions: true });
      const trigger = page.getByRole("button", { name: "About Net MMR", exact: true });
      await trigger.click(); await expect.poll(evidence.heldCount).toBe(1);
      const tip = page.getByRole("dialog", { name: "About Net MMR", exact: true });
      await expect(tip.getByRole("status")).toHaveText("Loading definition…");
      await page.evaluate(() => (window as TipWindow).fixtureTipLater());
      const later = page.getByRole("dialog", { name: "Later tip dialog", exact: true });
      const laterClose = later.getByRole("button", { name: "Close", exact: true });
      await expect(laterClose).toBeFocused();
      evidence.releaseDefinitions();
      await expect(tip.getByRole("link", { name: "Learn more", exact: true })).toBeVisible();
      await expect(laterClose).toBeFocused();
      await checkAccessibility(page, info, `/info-tip/newer-modal-${width}`, theme);
      await captureAccessibility(page, info, `info-tip-${theme}-newer-modal-${width}`);
      await page.keyboard.press("Escape"); await expect(later).toHaveCount(0); await expect(tip).toBeVisible();
      await page.keyboard.press("Escape"); await expect(tip).toHaveCount(0); await expect(trigger).toBeFocused();

      await page.evaluate(() => (window as TipWindow).fixtureTipNavigate("/compact#host-state"));
      const compact = page.getByRole("region", { name: "Compact glossary one", exact: true });
      const second = page.getByRole("region", { name: "Compact glossary two", exact: true });
      const search = compact.getByRole("textbox", { name: "Search glossary", exact: true });
      await expect(compact.getByRole("term")).toHaveCount(7); await expect(second.getByRole("term")).toHaveCount(7);
      const inputs = await page.getByRole("textbox", { name: "Search glossary", exact: true }).evaluateAll(nodes => nodes.map(node => node.id));
      expect(new Set(inputs).size).toBe(2);
      const ids = await page.locator("[id]").evaluateAll(nodes => nodes.map(node => node.id));
      expect(new Set(ids).size).toBe(ids.length);
      await expect(page.locator('[id="net-mmr"], [id="glossary-letter-n"]')).toHaveCount(0);
      for (const href of await compact.getByRole("navigation", { name: "Glossary A to Z", exact: true }).locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")))) {
        expect(href).toMatch(/^\/help\/glossary#glossary-letter-/);
      }
      await search.fill("look-alike"); await expect(compact.getByRole("term")).toHaveText("Barcode");
      const related = compact.getByRole("link", { name: "Group same player", exact: true });
      await expect(related).toHaveAttribute("href", "/help/glossary#group-same-player");
      const hostUrl = page.url();
      const popupReady = page.context().waitForEvent("page");
      await related.click({ modifiers: ["Control"] });
      const popup = await popupReady;
      await expect(popup).toHaveURL(/\/help\/glossary#group-same-player$/);
      await expect(popup.getByRole("term")).toHaveCount(7);
      await popup.evaluate(() => document.fonts.ready);
      await popup.close(); await page.bringToFront();
      await expect(page).toHaveURL(hostUrl); await expect(search).toHaveValue("look-alike");
      await related.click();
      await expect(search).toHaveValue(""); await expect(compact.locator('[data-glossary-id="group-same-player"]')).toBeFocused();
      await expect(page).toHaveURL(hostUrl);
      await checkAccessibility(page, info, `/help/glossary/compact-${width}`, theme);
      await captureAccessibility(page, info, `glossary-${theme}-compact-${width}`);

      await page.evaluate(() => (window as TipWindow).fixtureTipNavigate("/help/glossary#net-mmr"));
      await expect(page.locator("#net-mmr")).toHaveCount(1); await expect(page.getByRole("term")).toHaveCount(7);
      const publicSearch = page.getByRole("textbox", { name: "Search glossary", exact: true });
      await publicSearch.fill("look-alike"); await expect(page.getByRole("term")).toHaveText("Barcode");
      await page.getByRole("link", { name: "Group same player", exact: true }).click();
      await expect(page.locator("#group-same-player")).toBeFocused(); await expect(page).toHaveURL(/#group-same-player$/);
      await checkAccessibility(page, info, `/help/glossary/public-${width}`, theme);
      await captureAccessibility(page, info, `glossary-${theme}-public-${width}`);
      expect(await page.evaluate(() => (window as TipWindow).fixtureGroupingWrites)).toEqual([]);
      await proof(evidence, info, page);
    }
  });
}
