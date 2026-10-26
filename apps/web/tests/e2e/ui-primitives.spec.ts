import { expect, test, type Locator, type Page } from "@playwright/test";
import { openUiPrimitivesFixture } from "./ui-primitives-fixture.mjs";

async function fitsViewport(page: Page, panel: Locator) {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  return box!;
}

test("native closed-details summary participates in modal Tab wrap and local confirmation stays controlled", async ({ page }) => {
  const evidence = await openUiPrimitivesFixture(page, "keyboard");
  const opener = page.getByRole("button", { name: "Open keyboard dialog", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Keyboard dialog", exact: true });
  const summary = dialog.locator("summary");
  const first = dialog.getByRole("button", { name: "First action", exact: true });
  const last = dialog.getByRole("button", { name: "Last action", exact: true });
  await expect(summary).toBeFocused();
  await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
  await expect(dialog.getByText("Hidden details action", { exact: true })).toBeHidden();
  await summary.press("Tab"); await expect(last).toBeFocused();
  await last.press("Tab"); await expect(first).toBeFocused();
  await first.press("Shift+Tab"); await expect(last).toBeFocused();
  await last.press("Shift+Tab"); await expect(summary).toBeFocused();
  await fitsViewport(page, dialog);
  await summary.press("Escape"); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();

  const confirmOpener = page.getByRole("button", { name: "Confirm local choice", exact: true });
  await confirmOpener.click();
  const confirmation = page.getByRole("dialog", { name: "Confirm local choice", exact: true });
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Local choice")).toHaveText("Cancelled");
  await expect(confirmOpener).toBeFocused();
  await confirmOpener.click();
  await confirmation.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByLabel("Local choice")).toHaveText("Accepted");
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});

test("custom-portal popover remains in the parent Tab domain and nested dismissal restores the external opener", async ({ page }, info) => {
  const evidence = await openUiPrimitivesFixture(page, "layers");
  const opener = page.getByRole("button", { name: "Open layered dialog", exact: true });
  await opener.click();
  const parent = page.getByRole("dialog", { name: "Parent modal", exact: true });
  const trigger = parent.getByRole("button", { name: "Open popup", exact: true });
  const iconBounds = await trigger.boundingBox();
  expect(iconBounds!.width).toBeGreaterThanOrEqual(44); expect(iconBounds!.height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Layered popup", exact: true });
  await expect(page.locator("#custom-popover-root").getByRole("dialog", { name: "Layered popup" })).toBeVisible();
  await expect(parent.getByRole("dialog", { name: "Layered popup" })).toHaveCount(0);
  expect(await parent.evaluate(element => {
    const host = document.getElementById("custom-popover-root")!;
    const between = document.getElementById("portal-between")!;
    return Boolean(host.compareDocumentPosition(between) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(between.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  const firstPopup = popup.getByRole("button", { name: "First popup action", exact: true });
  await expect(firstPopup).toBeFocused();
  const lastPopup = popup.getByRole("button", { name: "Unmount dialog tree", exact: true });
  const lastParent = parent.getByRole("button", { name: "Last parent action", exact: true });
  await lastParent.focus(); await lastParent.press("Tab"); await expect(firstPopup).toBeFocused();
  await firstPopup.press("Shift+Tab"); await expect(lastParent).toBeFocused();
  await lastPopup.focus(); await lastPopup.press("Tab");
  const firstParent = parent.getByRole("button", { name: "First parent action", exact: true });
  await expect(firstParent).toBeFocused();
  await firstParent.press("Shift+Tab"); await expect(lastPopup).toBeFocused();

  const balanced = parent.getByRole("radio", { name: "Balanced", exact: true });
  const aggressive = parent.getByRole("radio", { name: "Aggressive", exact: true });
  await firstParent.focus(); await firstParent.press("Tab"); await expect(balanced).toBeFocused();
  await balanced.press("Tab"); await expect(trigger).toBeFocused();
  await trigger.press("Shift+Tab"); await expect(balanced).toBeFocused();
  await balanced.press("ArrowRight"); await expect(aggressive).toBeFocused(); await expect(aggressive).toBeChecked();
  await aggressive.press("Tab"); await expect(trigger).toBeFocused();
  await trigger.press("Shift+Tab"); await expect(aggressive).toBeFocused();
  await aggressive.press("Shift+Tab"); await expect(firstParent).toBeFocused();
  await expect(parent.getByRole("radio", { name: "Safe", exact: true })).not.toBeFocused();

  await fitsViewport(page, parent); await fitsViewport(page, popup);
  await page.screenshot({ path: info.outputPath("ui-primitives-custom-portal.png"), fullPage: true });
  await popup.getByRole("button", { name: "Open popup modal", exact: true }).click();
  const child = page.getByRole("dialog", { name: "Popup child modal", exact: true });
  const childAction = child.getByRole("button", { name: "Run child action", exact: true });
  await expect(child).toBeVisible();
  expect(await childAction.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  const popupLayer = await popup.evaluate(element => Number(getComputedStyle(element).zIndex));
  const childLayer = await child.evaluate(element => Number(getComputedStyle(element.parentElement!).zIndex));
  expect(childLayer).toBeGreaterThan(popupLayer); expect(childLayer).toBeLessThan(60);
  await childAction.click(); await expect(child.getByLabel("Child result")).toHaveText("Child action completed");
  const notifications = page.getByRole("region", { name: "Notifications", exact: true });
  await expect(notifications).toContainText("Local child action completed");
  expect(await notifications.evaluate(element => Number(getComputedStyle(element).zIndex))).toBe(60);
  await notifications.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await child.getByRole("button", { name: "Close", exact: true }).click();
  await expect(child).toBeHidden(); await expect(popup).toBeVisible();
  await lastPopup.focus();
  await lastPopup.press("Escape"); await expect(popup).toBeHidden(); await expect(parent).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Escape"); await expect(parent).toBeHidden(); await expect(opener).toBeFocused();

  await opener.click(); await trigger.click();
  await popup.getByRole("button", { name: "Unmount dialog tree", exact: true }).click();
  await expect(parent).toBeHidden(); await expect(popup).toBeHidden(); await expect(opener).toBeFocused();
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});

test("native outside-pointer focus is retained or restored and outer scrolling keeps a large popup on screen", async ({ page }) => {
  const evidence = await openUiPrimitivesFixture(page, "pointer");
  await page.getByRole("button", { name: "Open layered dialog", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Parent modal", exact: true });
  const trigger = parent.getByRole("button", { name: "Open popup", exact: true });
  const popup = page.getByRole("dialog", { name: "Layered popup", exact: true });
  await trigger.click();
  await parent.getByText("Plain parent text", { exact: true }).click();
  await expect(popup).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.click();
  const outsideButton = parent.getByRole("button", { name: "Last parent action", exact: true });
  await outsideButton.click(); await expect(popup).toBeHidden(); await expect(outsideButton).toBeFocused();
  await trigger.click();
  const outsideInput = parent.getByRole("textbox", { name: "Outside text input", exact: true });
  await outsideInput.click(); await expect(popup).toBeHidden(); await expect(outsideInput).toBeFocused();
  await trigger.click();
  // The busy parent disables scrim dismissal. Use a real pointer/mousedown,
  // including the browser's default focus behavior, instead of dispatchEvent.
  await page.getByRole("button", { name: "Close dialog", exact: true }).click({ position: { x: 4, y: 4 } });
  await expect(popup).toBeHidden(); await expect(parent).toBeVisible(); await expect(trigger).toBeFocused();
  await trigger.press("Escape"); await expect(parent).toBeHidden();

  const viewportTrigger = page.getByRole("button", { name: "Open viewport popup", exact: true });
  await viewportTrigger.click();
  const viewportPopup = page.getByRole("dialog", { name: "Viewport popup", exact: true });
  await expect(viewportPopup).toBeVisible(); await fitsViewport(page, viewportPopup);
  await page.mouse.move(4, 200); await page.mouse.wheel(0, 700);
  await expect.poll(async () => (await viewportTrigger.boundingBox())!.y).toBeLessThan(0);
  await expect.poll(async () => {
    const box = (await viewportPopup.boundingBox())!;
    return box.y >= -1 && box.y + box.height <= page.viewportSize()!.height + 1;
  }).toBe(true);
  await fitsViewport(page, viewportPopup);
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});

test("right and bottom sheets fit the viewport and denied clipboard offers a visible selected fallback", async ({ page }, info) => {
  const evidence = await openUiPrimitivesFixture(page, "sheets");
  for (const side of ["right", "bottom"] as const) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, side === "right" ? "dark" : "light");
    const opener = page.getByRole("button", { name: `Open ${side} sheet`, exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: side === "right" ? "Right sheet" : "Bottom sheet", exact: true });
    const box = await fitsViewport(page, dialog);
    const viewport = page.viewportSize()!;
    expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(1);
    if (side === "right") {
      expect(Math.abs(box.x + box.width - viewport.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(1);
    } else expect(box.height).toBeLessThanOrEqual(viewport.height * 0.9 + 1);
    await fitsViewport(page, dialog.locator("footer"));
    await expect(dialog.getByRole("status").filter({ hasText: "Loading fixture chart" })).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByRole("status").filter({ hasText: "Loading fixture statistics" })).toHaveAttribute("aria-busy", "true");
    await dialog.getByRole("button", { name: "Copy fixture text", exact: true }).click();
    const fallback = dialog.getByRole("textbox", { name: "Fixture text", exact: true });
    await expect(fallback).toBeVisible(); await expect(fallback).toBeFocused(); await expect(fallback).toHaveValue("Fixture replay notes");
    expect(await fallback.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, "Fixture replay notes".length]);
    await fitsViewport(page, fallback);
    await page.screenshot({ path: info.outputPath(`ui-primitives-${side}-sheet.png`), fullPage: true });
    await fallback.press("Escape"); await expect(fallback).toBeHidden(); await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Copy fixture text", exact: true }).press("Escape");
    await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
  }
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
});
