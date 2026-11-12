import { expect, test, type Page } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { openPublicPlayerSettingsFixture } from "./public-player-settings-fixture.mjs";

const viewer = (mode: string) => `/p/fixture-viewer-${mode}-0123456789/live`;
const themes = ["light", "dark"] as const;

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

for (const theme of themes) {
  test(`signed-out delayed results fit in ${theme} theme`, async ({ page }, info) => {
    await page.addInitScript(value => localStorage.setItem("sc2tools.theme", value), theme);
    const response = await page.goto(viewer("ready"));
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("heading", { name: "Stream viewer", exact: true })).toBeVisible();
    await expect(page.getByText("Results appear at least 5 minutes after each game ends.")).toBeVisible();
    const games = page.getByRole("list", { name: "Newest completed games first" });
    await expect(games.getByRole("listitem")).toHaveCount(2);
    await expect(games.getByText("vs. Zerg")).toBeVisible();
    await expect(games.getByRole("link")).toHaveCount(0);
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    if (await reject.isVisible()) await reject.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await assertNoOverflow(page);
    await checkAccessibility(page, info, "/p/:handle/live", theme);
    await captureAccessibility(page, info, `stream-viewer-public-${theme}`, true);
  });

  test(`synthetic owner can share and revoke by keyboard in ${theme} theme`, async ({ page }, info) => {
    const fixture = await openPublicPlayerSettingsFixture(page, theme);
    const disclosure = page.getByText("Stream viewer page", { exact: true });
    await disclosure.focus();
    await page.keyboard.press("Enter");
    const toggle = page.getByRole("checkbox", { name: "Share my stream viewer page" });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Browser Source", { exact: true })).toHaveValue("1234567890abcdef01234567");
    const delay = page.getByRole("spinbutton", { name: "Results delay (minutes)" });
    await expect(delay).toHaveValue("5");
    await delay.fill("7");
    const save = page.getByRole("button", { name: "Save viewer page" });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "Open viewer page" })).toHaveAttribute("href", "/p/frontier-0123456789/live");
    await expect(page.getByRole("status").filter({ hasText: "Viewer page is shared." })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await assertNoOverflow(page);
    await checkAccessibility(page, info, "/settings?tab=profile", theme);
    await captureAccessibility(page, info, `stream-viewer-settings-${theme}`, true);
    const copy = page.getByRole("button", { name: "Copy viewer link" });
    await copy.focus();
    await page.keyboard.press("Enter");
    const manualCopy = page.getByRole("textbox", { name: "Copy viewer link" });
    await expect(manualCopy).toHaveValue("https://public-player-settings-fixture.local/p/frontier-0123456789/live");
    await manualCopy.press("Escape");
    await expect(copy).toBeFocused();
    await toggle.focus();
    await page.keyboard.press("Space");
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Viewer page is off." })).toBeVisible();
    expect(fixture.viewerWrites).toEqual([
      { owner: "owner-a", body: { tokenId: "1234567890abcdef01234567", delayMinutes: 7, revision: 0 } },
      { owner: "owner-a", body: { tokenId: null, delayMinutes: 7, revision: 1 } },
    ]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpectedRequests).toEqual([]);
  });
}

test("reports empty and 404, then clears visible results on a revoked poll", async ({ page, request }) => {
  expect((await request.get(viewer("off"))).status()).toBe(404);
  const failure = await page.goto(viewer("error"));
  expect(failure?.status()).toBe(500);
  await expect(page.getByRole("heading", { name: "Results unavailable" })).toBeVisible();
  await page.goto(viewer("empty"));
  await expect(page.getByText("No delayed results are available for this session yet.")).toBeVisible();
  await page.clock.install();
  const pattern = "**/v1/public/players/fixture-viewer-ready-0123456789/live";
  await page.route(pattern, async route => {
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, json: {} });
  });
  await page.goto(viewer("ready"));
  await expect(page.getByText("vs. Zerg")).toBeVisible();
  const poll = page.waitForResponse(pattern);
  await page.clock.fastForward(61_000);
  expect((await poll).status()).toBe(404);
  await expect(page.getByText("This page is no longer shared.")).toBeVisible();
  await expect(page.getByText("vs. Zerg")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Try again" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("This page is no longer shared.")).toBeVisible();
});
