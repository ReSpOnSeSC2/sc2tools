import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { COPY_FIXTURE_ORIGIN, COPY_FIXTURE_PATH, openCopyConsumersFixture } from "./copy-consumers-fixture.mjs";

type FixtureWindow = typeof window & {
  fixtureCopyPath: (value: string) => void;
  fixtureCopyMode: (mode: "denied" | "held" | "success") => void;
  fixtureCopySettle: (outcome: "resolve" | "reject") => void;
  fixtureCopyState: { writes: string[]; pending: unknown[]; promptCalls: number; execCalls: number };
};

async function selectedReadonly(input: Locator, value: string) {
  await expect(input).toHaveValue(value);
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toBeFocused();
  expect(await input.evaluate(node => {
    const field = node as HTMLInputElement;
    return [field.selectionStart, field.selectionEnd];
  })).toEqual([0, value.length]);
}

async function dismissToasts(page: Page) {
  const dismiss = page.getByRole("region", { name: "Notifications", exact: true }).getByRole("button", { name: "Dismiss notification" });
  while (await dismiss.count()) await dismiss.first().click();
}

async function screenshot(target: Locator | Page, info: TestInfo, label: string) {
  const file = `${info.project.name}-${label}.png`;
  const output = process.env.COPY_CONSUMERS_SHOTS_DIR ? path.join(path.resolve(process.env.COPY_CONSUMERS_SHOTS_DIR), file) : info.outputPath(file);
  await mkdir(path.dirname(output), { recursive: true });
  await target.screenshot({ path: output });
}

for (const theme of ["light", "dark"] as const) {
  test(`copy consumers ${theme}: visible recovery, focus and retired results`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const evidence = await openCopyConsumersFixture(page, theme);
    const publicUrl = `${COPY_FIXTURE_ORIGIN}${COPY_FIXTURE_PATH}`;
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))
      .toBe(theme === "light" ? "244 246 250" : "6 9 14");
    expect(await page.getByRole("main").evaluate(node => getComputedStyle(node).fontFamily)).toContain("CopyHanken");
    await expect(page.getByRole("link", { name: /^(?:Learn how|Help)$/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as FixtureWindow).fixtureCopyState.writes)).toEqual([]);
    const community = page.getByRole("region", { name: "Community copy example", exact: true });
    const trigger = community.getByRole("button").first();
    const manualDialog = page.getByRole("dialog", { name: "Copy link manually", exact: true });
    const shareInput = manualDialog.getByRole("textbox", { name: "Copy link manually", exact: true });
    const manualDone = manualDialog.getByRole("button", { name: "Done", exact: true });
    const manualClose = manualDialog.getByRole("button", { name: "Close", exact: true });
    const notifications = page.getByRole("region", { name: "Notifications", exact: true });
    const search = page.getByRole("textbox", { name: "Search builds and strategies", exact: true });

    await page.evaluate(() => (window as FixtureWindow).fixtureCopyMode("success"));
    await trigger.click(); await expect(trigger).toHaveText("Copied!");
    expect(await page.evaluate(() => (window as FixtureWindow).fixtureCopyState.writes)).toEqual([publicUrl]);
    await dismissToasts(page);
    await page.evaluate(() => (window as FixtureWindow).fixtureCopyMode("denied"));
    await trigger.click();
    await selectedReadonly(shareInput, publicUrl);
    await expect(community.getByRole("dialog")).toHaveCount(0);
    await expect(notifications.getByRole("status")).toHaveCount(0);
    await manualDone.click();
    await expect(manualDialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await selectedReadonly(shareInput, publicUrl);
    await manualClose.click(); await expect(manualDialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await selectedReadonly(shareInput, publicUrl);
    await page.keyboard.press("Escape"); await expect(manualDialog).toHaveCount(0); await expect(trigger).toBeFocused();

    const openModal = community.getByRole("button", { name: "Open shared link modal", exact: true });
    await openModal.click();
    const modal = page.getByRole("dialog", { name: "Public link example", exact: true });
    await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    const modalCopy = modal.getByRole("button", { name: "Copy modal build link", exact: true });
    await modalCopy.click();
    await selectedReadonly(shareInput, publicUrl);
    await expect(modal.getByRole("dialog")).toHaveCount(0);
    await expect(notifications.getByRole("status")).toHaveCount(0);
    // The manual-copy portal owns Tab and Escape until it closes; the outer
    // dialog keeps its scroll lock and takes over containment afterward.
    await page.keyboard.press("Tab"); await expect(manualDone).toBeFocused();
    await page.keyboard.press("Tab"); await expect(manualClose).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(manualDone).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(shareInput).toBeFocused();
    await page.keyboard.press("Escape"); await expect(manualDialog).toHaveCount(0);
    await expect(modal).toBeVisible(); await expect(modalCopy).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Tab"); await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(modalCopy).toBeFocused();
    await modalCopy.click(); await selectedReadonly(shareInput, publicUrl);
    await checkAccessibility(page, info, "/community/builds/synthetic-stargate#copy", theme);
    await screenshot(page, info, `community-copy-${theme}`);
    await manualDone.click(); await expect(manualDialog).toHaveCount(0); await expect(modalCopy).toBeFocused();
    await modalCopy.click(); await selectedReadonly(shareInput, publicUrl);
    await manualClose.click(); await expect(manualDialog).toHaveCount(0); await expect(modalCopy).toBeFocused();
    await expect(modal).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape"); await expect(modal).toHaveCount(0); await expect(openModal).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await expect(notifications.getByRole("status")).toHaveCount(0);

    // Use the actual phone ActionsBar, including its real vote score and export
    // disclosure. Only the copy action is activated; mutation callbacks throw.
    const originalViewport = page.viewportSize()!;
    const compactBar = page.getByRole("region", { name: "Build actions", exact: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: originalViewport.height });
      await compactBar.evaluate(node => node.scrollIntoView({ block: "start" }));
      await expect(compactBar).toBeVisible();
      const compactShare = compactBar.getByRole("button", { name: "Share", exact: true });
      const up = compactBar.getByRole("button", { name: "Upvote", exact: true });
      const down = compactBar.getByRole("button", { name: "Downvote", exact: true });
      const exportSummary = compactBar.getByLabel("Build actions for Synthetic Stargate", { exact: true });
      const controls = [
        ["save", compactBar.getByRole("button", { name: "Save to my library", exact: true })],
        ["upvote", up], ["downvote", down], ["share", compactShare], ["export", exportSummary],
      ] as const;
      const targetBounds = [];
      for (const [name, control] of controls) {
        await expect(control).toBeVisible();
        const box = (await control.boundingBox())!;
        expect(box.width, `${name} width at ${width}px`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${name} height at ${width}px`).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        targetBounds.push({ name, ...box });
      }
      for (let i = 0; i < targetBounds.length; i++) for (let j = i + 1; j < targetBounds.length; j++) {
        const a = targetBounds[i], b = targetBounds[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX > 1 && overlapY > 1, `${a.name}/${b.name} overlap at ${width}px`).toBe(false);
      }
      await expect(compactBar.getByLabel("Net score +17", { exact: true })).toBeVisible();
      const compactRow = compactBar.locator(".justify-between");
      const rowBefore = (await compactRow.boundingBox())!;
      const barBefore = (await compactBar.boundingBox())!;
      const voteBounds = (await up.locator("..").boundingBox())!;
      const exportBounds = (await exportSummary.boundingBox())!;
      await compactShare.click();
      await selectedReadonly(shareInput, publicUrl);
      await expect(compactBar.getByRole("dialog")).toHaveCount(0);
      await expect(notifications.getByRole("status")).toHaveCount(0);
      const dialogBounds = (await manualDialog.boundingBox())!;
      const inputBounds = (await shareInput.boundingBox())!;
      const rowAfter = (await compactRow.boundingBox())!;
      const barAfter = (await compactBar.boundingBox())!;
      for (const dimension of ["width", "height"] as const) {
        expect(Math.abs(rowAfter[dimension] - rowBefore[dimension]), `row ${dimension} changed at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(barAfter[dimension] - barBefore[dimension]), `bar ${dimension} changed at ${width}px`).toBeLessThanOrEqual(1);
      }
      expect(dialogBounds.x).toBeGreaterThanOrEqual(-1); expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(width + 1);
      expect(dialogBounds.y).toBeGreaterThanOrEqual(-1);
      expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(originalViewport.height + 1);
      expect(inputBounds.x).toBeGreaterThanOrEqual(-1); expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(width + 1);
      expect(inputBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
      expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
      expect(inputBounds.y).toBeGreaterThanOrEqual(dialogBounds.y);
      expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
      expect(inputBounds.width).toBeGreaterThanOrEqual(dialogBounds.width - 48);
      expect(inputBounds.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach(`compact-copy-${theme}-${width}`, { body: JSON.stringify({
        viewport: page.viewportSize(), barBefore, barAfter, rowBefore, rowAfter,
        controls: targetBounds, dialog: dialogBounds, input: inputBounds, votes: voteBounds, export: exportBounds,
      }), contentType: "application/json" });
      await checkAccessibility(page, info, `/community/builds/synthetic-stargate#compact-copy-${width}`, theme);
      await screenshot(page, info, `compact-copy-${theme}-${width}`);
      await manualDone.click();
      await expect(manualDialog).toHaveCount(0); await expect(compactShare).toBeFocused();
      await compactShare.click(); await selectedReadonly(shareInput, publicUrl);
      await manualClose.click(); await expect(manualDialog).toHaveCount(0); await expect(compactShare).toBeFocused();
      await compactShare.click(); await selectedReadonly(shareInput, publicUrl);
      await page.keyboard.press("Escape"); await expect(manualDialog).toHaveCount(0); await expect(compactShare).toBeFocused();
      await expect(notifications.getByRole("status")).toHaveCount(0);
    }
    await page.setViewportSize(originalViewport);

    const definition = page.locator("#pvz-stargate-into-glaives");
    const definitionCopy = definition.getByRole("button", { name: "Copy link to PvZ - Stargate into Glaives", exact: true });
    await definitionCopy.scrollIntoViewIfNeeded();
    const target = (await definitionCopy.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
    await definitionCopy.click();
    const definitionUrl = `${COPY_FIXTURE_ORIGIN}/definitions#pvz-stargate-into-glaives`;
    const definitionInput = definition.getByRole("textbox", { name: "Copy definition link manually", exact: true });
    await selectedReadonly(definitionInput, definitionUrl);
    const grid = (await definition.locator("h4").locator("..").boundingBox())!;
    const fallback = (await definitionInput.locator("..").boundingBox())!;
    expect(Math.abs(fallback.x - grid.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(fallback.width - grid.width)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await checkAccessibility(page, info, "/definitions#copy", theme);
    await screenshot(definition, info, `definition-copy-${theme}`);
    await page.keyboard.press("Escape"); await expect(definitionInput).toHaveCount(0); await expect(definitionCopy).toBeFocused();
    await dismissToasts(page);

    // A blocked permission settles through the real shared five-second timer.
    await page.evaluate(() => (window as FixtureWindow).fixtureCopyMode("held"));
    await trigger.click(); await expect(trigger).toBeDisabled();
    await search.focus(); await expect(search).toBeFocused();
    await expect(manualDialog).toBeVisible({ timeout: 7000 });
    await selectedReadonly(shareInput, publicUrl); await expect(trigger).toBeEnabled();
    await expect(notifications.getByRole("status")).toHaveCount(0);
    await manualDone.click(); await expect(manualDialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.evaluate(() => (window as FixtureWindow).fixtureCopyMode("success"));
    await trigger.click(); await expect(trigger).toHaveText("Copied!"); await expect(manualDialog).toHaveCount(0);
    await dismissToasts(page);
    await search.focus();
    await page.evaluate(() => (window as FixtureWindow).fixtureCopySettle("resolve"));
    await expect(trigger).toHaveText("Copied!"); await expect(search).toBeFocused();
    await expect(manualDialog).toHaveCount(0); await expect(notifications.getByRole("status")).toHaveCount(0);

    // Two committed resource changes exercise A→B→A rather than React batching.
    await page.evaluate(() => (window as FixtureWindow).fixtureCopyMode("held"));
    await trigger.click();
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).fixtureCopyState.pending.length)).toBe(1);
    await page.evaluate(() => (window as FixtureWindow).fixtureCopyPath("/community/builds/synthetic-pool"));
    await expect(community.getByRole("status", { name: "Current public copy path", exact: true })).toHaveText("/community/builds/synthetic-pool");
    await page.evaluate(value => (window as FixtureWindow).fixtureCopyPath(value), COPY_FIXTURE_PATH);
    await expect(community.getByRole("status", { name: "Current public copy path", exact: true })).toHaveText(COPY_FIXTURE_PATH);
    await search.focus(); await page.evaluate(() => (window as FixtureWindow).fixtureCopySettle("resolve"));
    await expect(search).toBeFocused(); await expect(manualDialog).toHaveCount(0); await expect(trigger).toHaveText("Share build link");
    await expect(notifications.getByRole("status")).toHaveCount(0);

    await definitionCopy.click();
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).fixtureCopyState.pending.length)).toBe(1);
    await search.fill("no synthetic definition matches this phrase"); await expect(definition).toHaveCount(0); await search.focus();
    await page.evaluate(() => (window as FixtureWindow).fixtureCopySettle("reject"));
    await expect(search).toBeFocused(); await expect(page.getByRole("textbox", { name: "Copy definition link manually", exact: true })).toHaveCount(0);
    await search.fill(""); await expect(definitionCopy).toBeEnabled();
    await expect(notifications.getByRole("status")).toHaveCount(0);
    expect(await page.evaluate(() => ({ prompt: (window as FixtureWindow).fixtureCopyState.promptCalls, exec: (window as FixtureWindow).fixtureCopyState.execCalls }))).toEqual({ prompt: 0, exec: 0 });
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    await info.attach("copy-production-assets", { body: JSON.stringify({ buildId: evidence.buildId, cssNames: evidence.cssNames }), contentType: "application/json" });
  });
}
