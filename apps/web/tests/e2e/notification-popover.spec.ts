import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { openNotificationPopoverFixture } from "./notification-popover-fixture.mjs";

type FixtureWindow = typeof window & {
  fixtureRefreshNotifications: () => void;
  fixtureOpenLaterNotificationDialog: () => void;
};

async function fitsViewport(page: Page, panel: Locator) {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(15);
  expect(box!.y).toBeGreaterThanOrEqual(15);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 15);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function assertEvidence(evidence: Awaited<ReturnType<typeof openNotificationPopoverFixture>>, info: TestInfo) {
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.rejectedWrites).toEqual([]);
  expect(evidence.externalAttempts).toEqual([]);
  await info.attach("notification-proof", { body: JSON.stringify({ buildId: evidence.buildId, cssNames: evidence.cssNames,
    getRequests: evidence.getRequests, syntheticReadWrites: evidence.readWrites, externalAttempts: evidence.externalAttempts,
    rejectedWrites: evidence.rejectedWrites }), contentType: "application/json" });
}

for (const theme of ["light", "dark"] as const) {
  test(`notification popover ${theme}: fresh focus, nonmodal keyboard and top layer`, async ({ page }, info) => {
    const evidence = await openNotificationPopoverFixture(page, theme, { holdLists: true });
    const bell = page.getByRole("button", { name: "Notifications, 2 unread", exact: true });
    await expect(bell).toBeVisible();
    expect(evidence.getRequests.some(url => url.startsWith("/v1/me/notifications?"))).toBe(false);
    await bell.click();
    const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(panel).toBeVisible();
    await expect.poll(evidence.heldListCount).toBeGreaterThan(0);
    await expect(bell).toBeFocused();
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    await expect(bell).toHaveAttribute("aria-controls", await panel.getAttribute("id") as string);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    expect(evidence.readWrites).toEqual([]);
    evidence.releaseLists();
    const row = panel.getByRole("link", { name: /Fixture update 01/ });
    await expect(row).toBeFocused();
    await expect.poll(() => evidence.readWrites.length).toBe(1);
    expect(evidence.readWrites).toEqual([{ ids: ["fixture-01", "fixture-00"] }]);
    await expect(row.getByText("New", { exact: true })).toBeVisible();
    const all = panel.getByRole("button", { name: "All notifications", exact: true });
    await all.focus();
    await page.evaluate(() => (window as FixtureWindow).fixtureRefreshNotifications());
    await expect(all).toBeFocused();
    await fitsViewport(page, panel);
    await checkAccessibility(page, info, "/notification-popover/ready", theme);

    await page.evaluate(() => (window as FixtureWindow).fixtureOpenLaterNotificationDialog());
    const later = page.getByRole("dialog", { name: "Later notification dialog", exact: true });
    await expect(later).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(later).toHaveCount(0); await expect(panel).toBeVisible(); await expect(all).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    const readBell = page.getByRole("button", { name: "Notifications", exact: true });
    await expect(readBell).toBeFocused();
    await readBell.click(); await expect(panel).toBeVisible(); await expect(row).toBeFocused();
    const last = panel.getByRole("link", { name: "See all notifications", exact: true });
    await last.focus(); await page.keyboard.press("Tab");
    expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(false);
    const outside = page.getByRole("button", { name: "Outside action", exact: true });
    await outside.click(); await expect(panel).toHaveCount(0); await expect(outside).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    expect(evidence.readWrites).toHaveLength(1);
    await assertEvidence(evidence, info);
  });

  test(`notification popover ${theme}: error and empty focus remain usable`, async ({ page }, info) => {
    const evidence = await openNotificationPopoverFixture(page, theme, { count: 0, failList: true, failUnread: true });
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
    const header = panel.getByRole("heading", { name: "Notifications", exact: true });
    await expect(header).toBeFocused();
    await expect(panel.getByText(/Couldn't load notifications/)).toBeVisible();
    const listError = panel.getByRole("alert").filter({ hasText: /^Could not load notifications\.\s*Try again$/ });
    await expect(listError).toBeVisible();
    await expect(listError.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await expect(header).toBeFocused();
    evidence.allowUnread(); await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(panel.getByText(/Couldn't load notifications/)).toHaveCount(0);
    evidence.allowList(); await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(panel.getByText("No notifications yet.", { exact: true })).toBeVisible();
    const all = panel.getByRole("button", { name: "All notifications", exact: true });
    await all.focus(); await page.evaluate(() => (window as FixtureWindow).fixtureRefreshNotifications());
    await expect(all).toBeFocused();
    await fitsViewport(page, panel);
    await checkAccessibility(page, info, "/notification-popover/empty", theme);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeFocused();
    expect(evidence.readWrites).toEqual([]);
    await assertEvidence(evidence, info);
  });

  test(`notification popover ${theme}: paging and mark all retain exact acknowledgement bodies`, async ({ page }, info) => {
    const evidence = await openNotificationPopoverFixture(page, theme, { count: 45 });
    await page.getByRole("button", { name: "Notifications, 45 unread", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(panel.getByRole("link", { name: /Fixture update 44/ })).toBeFocused();
    await expect.poll(() => evidence.readWrites.length).toBe(1);
    await panel.getByRole("button", { name: "Load more notifications", exact: true }).click();
    await expect(panel.getByRole("link", { name: /Fixture update 05/ })).toBeVisible();
    await expect.poll(() => evidence.readWrites.length).toBe(2);
    expect(evidence.readWrites).toEqual([
      { ids: Array.from({ length: 20 }, (_, index) => `fixture-${String(44 - index).padStart(2, "0")}`) },
      { ids: Array.from({ length: 20 }, (_, index) => `fixture-${String(24 - index).padStart(2, "0")}`) },
    ]);
    await expect(page.getByRole("button", { name: "Notifications, 5 unread", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Mark all read", exact: true }).click();
    await expect.poll(() => evidence.readWrites.length).toBe(3);
    expect(evidence.readWrites[2]).toEqual({ all: true });
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
    await expect(panel.locator("[data-notification-row]")).toHaveCount(40);
    await expect(panel.getByRole("link", { name: /Fixture update 44/ }).getByText("New", { exact: true })).toBeVisible();
    await fitsViewport(page, panel);
    await checkAccessibility(page, info, "/notification-popover/paged", theme);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeFocused();
    await assertEvidence(evidence, info);
  });
}
