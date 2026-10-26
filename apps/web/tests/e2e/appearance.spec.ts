import { expect, test } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { openMoreAppearanceFixture } from "./appearance-more-fixture.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("System follows device changes and updates browser chrome", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/legal/accessibility");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme-mode", "system");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.locator('meta[name="theme-color"]').evaluateAll(nodes => nodes.every(node => node.getAttribute("content") === "#f4f6fa"))).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sc2tools.theme"))).toBeNull();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.locator('meta[name="theme-color"]').evaluateAll(nodes => nodes.every(node => node.getAttribute("content") === "#06090e"))).toBe(true);
});

test("a saved palette stays fixed when the device changes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sc2tools.theme", "dark"));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/legal/accessibility");
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keyboard skip link reaches the page content", async ({ page }) => {
  await page.goto("/legal/accessibility");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("phone navigation traps focus, offers all themes and restores its trigger", async ({ page }, info) => {
  test.skip(info.project.name === "desktop-1280", "phone and tablet drawer");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/legal/accessibility");
  const trigger = page.getByRole("button", { name: "Open menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Site navigation", exact: true });
  await expect(drawer).toBeVisible();
  const first = drawer.getByRole("link", { name: "SC2 Tools — home", exact: true });
  await expect(first).toBeFocused();
  await captureAccessibility(page, info, "dark-menu");
  await page.keyboard.press("Shift+Tab");
  const system = drawer.getByRole("radio", { name: "System", exact: true });
  await expect(system).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await system.focus();
  await page.keyboard.press("Home");
  await expect(drawer.getByRole("radio", { name: "Light", exact: true })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "light");
  await captureAccessibility(page, info, "light-menu");
  await page.keyboard.press("End");
  await expect(system).toBeFocused();
  await expect(system).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("compact theme keyboard options restore focus after closing", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1280", "desktop compact control");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/legal/accessibility");
  const toggle = page.getByRole("button", { name: "Switch to light theme", exact: true });
  await toggle.focus();
  await page.keyboard.press("ArrowDown");
  const dialog = page.getByRole("dialog", { name: "Appearance", exact: true });
  await expect(dialog).toBeVisible();
  await captureAccessibility(page, info, "dark-appearance-dialog");
  const system = dialog.getByRole("radio", { name: "System", exact: true });
  await system.focus();
  await page.keyboard.press("Home");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("End");
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "system");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

type MoreFixtureWindow = Window & {
  fixtureAppearance: () => void;
  fixtureExtraLock: () => void;
  fixtureUnlock: () => void;
  fixtureNavigate: (href: string) => void;
  fixtureAuth: (signedIn: boolean) => void;
};

for (const theme of ["light", "dark"] as const) {
  test(`More bottom sheet ${theme}: keyboard, theme, report handoff and teardown`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-360", "More is a phone navigation surface; desktop teardown is exercised below");
    const evidence = await openMoreAppearanceFixture(page, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()))
      .toBe(theme === "light" ? "244 246 250" : "6 9 14");
    const more = page.getByRole("button", { name: "More", exact: true });
    await more.focus(); await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "More sections", exact: true });
    await expect(sheet).toBeVisible();
    const close = sheet.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();
    await sheet.evaluate(node => { node.dataset.fixtureMounted = "same-more"; });
    const selected = sheet.getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true });
    await selected.focus(); await page.keyboard.press("End");
    const system = sheet.getByRole("radio", { name: "System", exact: true });
    await expect(system).toBeFocused(); await expect(system).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Home"); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.keyboard.press("End"); await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(sheet).toHaveAttribute("data-fixture-mounted", "same-more");
    await page.keyboard.press("Tab"); await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(system).toBeFocused();
    const assertBottomBounds = async () => {
      const box = (await sheet.boundingBox())!, viewport = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(-1); expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(2);
      expect(box.height).toBeLessThanOrEqual(viewport.height * 0.9 + 1);
    };
    await assertBottomBounds();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await checkAccessibility(page, info, "/settings#more", theme);
    const shots = path.resolve(process.env.MORE_SHEET_SHOTS_DIR || "../../.cache/more-sheet-evidence");
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `more-${theme}-360.png`) });
    await info.attach("more-production-css", { body: JSON.stringify(evidence.cssNames), contentType: "application/json" });
    // More remains available below 768px. The old responsive Modal centered at
    // 640px; this consumer must remain a bottom sheet across that interval.
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(sheet).toBeVisible(); await expect(sheet).toHaveAttribute("data-fixture-mounted", "same-more");
    await assertBottomBounds(); await page.screenshot({ path: path.join(shots, `more-${theme}-700.png`) });
    await page.setViewportSize({ width: 360, height: 800 });

    // Concurrency boundary only: More has inline theme choices. Inject the
    // existing account action to prove ownership if both dialogs overlap.
    await page.evaluate(() => (window as MoreFixtureWindow).fixtureAppearance());
    const appearance = page.getByRole("dialog", { name: "Appearance", exact: true });
    await expect(appearance).toBeVisible();
    await expect(appearance.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(appearance).toBeHidden(); await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab"); await expect.poll(() => sheet.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape"); await expect(sheet).toBeHidden(); await expect(more).toBeFocused();

    await page.evaluate(() => (window as MoreFixtureWindow).fixtureExtraLock());
    await more.click(); await sheet.getByRole("button", { name: "Report a problem", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Local report form", exact: true });
    await expect(report).toBeVisible(); await expect(sheet).toBeHidden();
    await expect.poll(() => report.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape"); await expect(report).toBeHidden(); await expect(more).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await more.click(); await sheet.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(sheet).toBeHidden(); await expect(more).toBeFocused();
    await more.click(); await page.evaluate(() => (window as MoreFixtureWindow).fixtureNavigate("/app"));
    await expect(sheet).toBeHidden(); await expect(more).toBeFocused();
    await page.evaluate(() => (window as MoreFixtureWindow).fixtureUnlock());
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await more.click(); await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sheet).toBeHidden(); await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => { (window as MoreFixtureWindow).fixtureNavigate("/community"); (window as MoreFixtureWindow).fixtureAuth(false); });
    await expect(page.getByRole("navigation", { name: "Quick sections" }).getByRole("link", { name: "Sign in", exact: true }))
      .toHaveAttribute("href", "/sign-in?redirect_url=%2Fcommunity");
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });
}
