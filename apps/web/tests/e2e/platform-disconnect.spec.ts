import { expect, test, type Locator, type Page } from "@playwright/test";
import { openPlatformDisconnectFixture } from "./platform-disconnect-fixture.mjs";
import { checkAccessibility } from "./accessibility-check";

declare global {
  interface Window {
    platformDisconnectFixture: {
      setOwner(owner: "owner-a" | "owner-b" | null, loaded?: boolean): void;
      setMounted(mounted: boolean): void;
      holdNextToken(): void;
      releaseTokens(): void;
      pendingTokens(): number;
      refresh(): Promise<unknown>;
      openLaterDialog(): void;
    };
    platformDisconnectForbidden: { popups: number; nativeConfirms: number };
  }
}
type Evidence = Awaited<ReturnType<typeof openPlatformDisconnectFixture>>;
const confirmation = (page: Page) => page.getByRole("dialog", { name: "Disconnect Twitch?", exact: true });
const twitch = (page: Page) => page.getByRole("group", { name: "Twitch account permissions", exact: true });
const disconnect = (page: Page) => twitch(page).getByRole("button", { name: "Disconnect", exact: true });
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function quiet(page: Page) { await page.waitForLoadState("networkidle"); await settled(page); }
async function clean(page: Page, evidence: Evidence) {
  expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  expect(evidence.externalAttempts).toEqual([]); expect(evidence.rejectedWrites).toEqual([]);
  expect(await page.evaluate(() => window.platformDisconnectForbidden)).toEqual({ popups: 0, nativeConfirms: 0 });
  expect(evidence.reads.every(row => row.method === "GET" && row.path === "/v1/me/integrations" && row.search === "" && row.body === null)).toBe(true);
}
async function bounds(page: Page, panel: Locator) {
  const box = await panel.boundingBox(), viewport = page.viewportSize()!;
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const button of await panel.getByRole("button").all()) {
    const target = await button.boundingBox(); expect(target).not.toBeNull();
    expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
  }
}
test.beforeEach(() => { expect(process.env.A11Y_COLLECT_ONLY, "Full AA checks must not run in diagnostic-only mode").not.toBe("1"); });

for (const theme of ["light", "dark"] as const) {
  test(`platform disconnect ${theme}: safe dismissal, nested focus, geometry and full AA`, async ({ page }, info) => {
    const evidence = await openPlatformDisconnectFixture(page, theme);
    expect(evidence.reads).toHaveLength(1);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 }); await settled(page);
      const opener = disconnect(page); await opener.click(); const dialog = confirmation(page);
      await expect(dialog).toContainText("Disconnect your Twitch account? This stops its notifications and stream controls.");
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
      const approve = dialog.getByRole("button", { name: "Disconnect Twitch", exact: true });
      await expect(cancel).toBeFocused(); await bounds(page, dialog);
      await approve.focus(); await approve.press("Tab"); await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await checkAccessibility(page, info, "/fixture/platform-disconnect", theme);
      await page.screenshot({ path: info.outputPath(`platform-disconnect-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      await cancel.click(); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
      await opener.click(); await confirmation(page).getByRole("button", { name: "Cancel", exact: true }).press("Escape");
      await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
      await opener.click(); await page.getByRole("button", { name: "Close dialog", exact: true }).click({ position: { x: 2, y: 2 } });
      await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    }
    const originalOverflow = await page.evaluate(() => document.body.style.overflow);
    await disconnect(page).click(); const parent = confirmation(page), safe = parent.getByRole("button", { name: "Cancel", exact: true });
    await page.evaluate(() => window.platformDisconnectFixture.openLaterDialog());
    const child = page.getByRole("dialog", { name: "Later local dialog", exact: true });
    await expect(child).toBeVisible(); await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await child.getByRole("button", { name: "Close", exact: true }).press("Escape");
    await expect(child).toBeHidden(); await expect(parent).toBeVisible(); await expect(safe).toBeFocused();
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await safe.press("Escape"); await expect(parent).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(originalOverflow);
    await quiet(page); expect(evidence.writes).toEqual([]); expect(evidence.reads).toHaveLength(1); await clean(page, evidence);
  });
}

test("pending decisions retire on unmount, account ABA and connection revision without DELETE", async ({ page }) => {
  const evidence = await openPlatformDisconnectFixture(page);
  await disconnect(page).click(); await page.evaluate(() => window.platformDisconnectFixture.setMounted(false));
  await expect(confirmation(page)).toBeHidden(); await page.evaluate(() => window.platformDisconnectFixture.setMounted(true));
  await disconnect(page).waitFor(); await disconnect(page).click();
  await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-b"));
  await expect(confirmation(page)).toBeHidden(); await expect(twitch(page)).toContainText("Fixture B account");
  await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-a")); await expect(twitch(page)).toContainText("Fixture A account");
  await expect(confirmation(page)).toBeHidden(); await disconnect(page).click();
  await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-a", false));
  await expect(confirmation(page)).toBeHidden();
  await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-a", true)); await disconnect(page).waitFor();
  await disconnect(page).click();
  await evidence.replaceRevision(); await expect(confirmation(page)).toBeHidden();
  await quiet(page); expect(evidence.writes).toEqual([]);
  expect(evidence.reads.some(row => row.owner === "owner-b")).toBe(true); await clean(page, evidence);
});

for (const boundary of ["unmount", "owner ABA", "connection revision"] as const) {
  test(`approved disconnect cannot use a held JWT after ${boundary}`, async ({ page }) => {
    const evidence = await openPlatformDisconnectFixture(page);
    await page.evaluate(() => window.platformDisconnectFixture.holdNextToken());
    await disconnect(page).click(); await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.platformDisconnectFixture.pendingTokens())).toBe(1);
    if (boundary === "unmount") await page.evaluate(() => window.platformDisconnectFixture.setMounted(false));
    else if (boundary === "owner ABA") {
      await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-b")); await settled(page);
      await page.evaluate(() => window.platformDisconnectFixture.setOwner("owner-a")); await settled(page);
    } else await evidence.replaceRevision();
    await page.evaluate(() => window.platformDisconnectFixture.releaseTokens()); await quiet(page);
    expect(evidence.writes).toEqual([]); await clean(page, evidence);
  });
}

test("same-owner approval performs exactly one typed DELETE and one integrations refresh", async ({ page }) => {
  const evidence = await openPlatformDisconnectFixture(page); expect(evidence.reads).toHaveLength(1);
  await disconnect(page).click(); evidence.approveDelete();
  await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
  await expect(twitch(page).getByText("Notifications not connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Notifications", exact: true })).toContainText("Twitch disconnected");
  await quiet(page); expect(evidence.reads).toHaveLength(2);
  expect(evidence.writes).toEqual([{ method: "DELETE", path: "/v1/me/integrations/twitch", search: "", owner: "owner-a",
    authorization: "Bearer synthetic-platform-owner-a", contentType: "application/json", body: null }]);
  await clean(page, evidence);
});

test("failed disconnect requires new explicit consent before retrying its DELETE", async ({ page }) => {
  const evidence = await openPlatformDisconnectFixture(page);
  await disconnect(page).click(); evidence.approveDelete("owner-a", "error");
  await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
  await expect(page.getByRole("region", { name: "Notifications", exact: true })).toContainText("Could not confirm Twitch disconnection");
  await expect(disconnect(page)).toBeEnabled(); await quiet(page);
  expect(evidence.writes).toHaveLength(1); expect(evidence.reads).toHaveLength(1); await expect(confirmation(page)).toBeHidden();
  await disconnect(page).click(); await confirmation(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await quiet(page); expect(evidence.writes).toHaveLength(1);
  await disconnect(page).click(); evidence.approveDelete();
  await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
  await expect(twitch(page).getByText("Notifications not connected", { exact: true })).toBeVisible(); await quiet(page);
  expect(evidence.writes).toHaveLength(2); expect(evidence.reads).toHaveLength(2); await clean(page, evidence);
});

test("a failed refresh after DELETE does not repeat the mutation without another approval", async ({ page }) => {
  const evidence = await openPlatformDisconnectFixture(page);
  await disconnect(page).click(); evidence.approveDelete(); evidence.failNextStatusRead();
  await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
  await expect(page.getByRole("region", { name: "Notifications", exact: true })).toContainText("Could not confirm Twitch disconnection");
  await expect(disconnect(page)).toBeEnabled(); await quiet(page);
  expect(evidence.writes).toHaveLength(1); expect(evidence.reads).toHaveLength(2);
  await disconnect(page).click(); await confirmation(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await quiet(page); expect(evidence.writes).toHaveLength(1);
  await disconnect(page).click(); evidence.approveDelete();
  await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
  await expect(twitch(page).getByText("Notifications not connected", { exact: true })).toBeVisible(); await quiet(page);
  expect(evidence.writes).toHaveLength(2); expect(evidence.reads).toHaveLength(3); await clean(page, evidence);
});

for (const variant of ["stillConnected", "missingTwitch", "invalidTwitch"] as const) {
  test(`unconfirmed post-delete status ${variant} cannot publish success or replace the confirmed connection`, async ({ page }) => {
    const evidence = await openPlatformDisconnectFixture(page);
    await disconnect(page).click(); evidence.approveDelete(); evidence.nextPostDeleteStatus(variant);
    await confirmation(page).getByRole("button", { name: "Disconnect Twitch", exact: true }).click();
    const notifications = page.getByRole("region", { name: "Notifications", exact: true });
    await expect(notifications).toContainText("Could not confirm Twitch disconnection");
    await expect(notifications).toContainText("Check this account's status before trying again.");
    await expect(notifications.getByText("Twitch disconnected", { exact: true })).toHaveCount(0);
    await expect(twitch(page)).toContainText("Fixture A account");
    await expect(twitch(page)).not.toContainText("Unconfirmed post-delete status");
    await expect(twitch(page).getByText("Notifications ready", { exact: true })).toBeVisible();
    await expect(twitch(page).getByText("Notifications not connected", { exact: true })).toHaveCount(0);
    await expect(disconnect(page)).toBeEnabled(); await quiet(page);
    expect(evidence.writes).toHaveLength(1); expect(evidence.reads).toHaveLength(2);
    expect(evidence.writes[0]).toEqual({ method: "DELETE", path: "/v1/me/integrations/twitch", search: "", owner: "owner-a",
      authorization: "Bearer synthetic-platform-owner-a", contentType: "application/json", body: null });
    await disconnect(page).click(); await confirmation(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await quiet(page); expect(evidence.writes).toHaveLength(1); expect(evidence.reads).toHaveLength(2);
    await clean(page, evidence);
  });
}
