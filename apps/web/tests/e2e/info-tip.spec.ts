import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { openInfoTipFixture } from "./info-tip-fixture.mjs";

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
async function proof(evidence: Awaited<ReturnType<typeof openInfoTipFixture>>, info: TestInfo) {
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
  await info.attach("info-tip-proof", { body: JSON.stringify({ buildId: evidence.buildId, cssNames: evidence.cssNames,
    definitionLoads: evidence.definitionLoads, rejectedWrites: evidence.rejectedWrites, externalAttempts: evidence.externalAttempts }), contentType: "application/json" });
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
    await page.evaluate(() => (window as TipWindow).fixtureTipNavigate("/example"));
    const helpSearch = page.getByRole("textbox", { name: "Search help", exact: true });
    await helpSearch.fill("look-alike characters");
    await expect(page.getByRole("region", { name: "Help search example", exact: true }).getByRole("link", { name: /^Glossary/ })).toBeVisible();
    await proof(evidence, info);
  });

  test(`InfoTip ${theme}: held import cannot reopen a retired ABA term`, async ({ page }, info) => {
    const evidence = await openInfoTipFixture(page, theme, { holdDefinitions: true });
    await page.getByRole("button", { name: "About Net MMR", exact: true }).click();
    await expect.poll(evidence.heldCount).toBe(1);
    await expect(page.getByRole("status")).toHaveText("Loading definition…");
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
    await checkAccessibility(page, info, "/info-tip/retired", theme); await proof(evidence, info);
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
    await proof(evidence, info);
  });
}
