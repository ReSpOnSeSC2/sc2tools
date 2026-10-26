import { expect, test } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { openMoreAppearanceFixture } from "./appearance-more-fixture.mjs";
import { openMobileNavFixture } from "./mobile-nav-fixture.mjs";
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
  const first = drawer.getByRole("button", { name: "Close", exact: true });
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

type MobileFixtureWindow = typeof window & {
  fixtureMobileNavigate: (href: string) => void;
  fixtureMobileAuth: (audience: "out" | "player" | "admin") => void;
  fixtureMobileOpenLater: () => void;
  fixtureMobileAddLock: () => void;
  fixtureMobileReleaseLock: () => void;
};

for (const theme of ["light", "dark"] as const) {
  test(`desktop Header action links preserve context, sizing and readable states (${theme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop-1280", "one actual-Header matrix includes all desktop widths");
    test.setTimeout(180_000);
    const evidence = await openMobileNavFixture(page, theme);
    const header = page.getByRole("banner");
    for (const width of [1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const audience of ["out", "player"] as const) {
        await page.evaluate(mode => (window as MobileFixtureWindow).fixtureMobileAuth(mode), audience);
        const names = audience === "out" ? ["Sign in", "Get started"] : ["Open app"];
        for (const name of names) {
          const link = header.getByRole("link", { name, exact: true });
          await expect(link).toBeVisible();
          await expect(link).toHaveAttribute("href", name === "Open app" ? "/app"
            : `/${name === "Sign in" ? "sign-in" : "sign-up"}?redirect_url=%2Fguides%2Fpvz`);
          const box = (await link.boundingBox())!;
          expect(box.height).toBe(36); expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.mouse.move(0, 899);
          const paint = await link.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius };
          });
          expect(parseFloat(paint.radius)).toBeGreaterThanOrEqual(box.height / 2);
          await checkAccessibility(page, info, `/header-cta/${width}/${audience}/${name}/rest`, theme);
          await link.hover();
          expect(await link.evaluate(node => getComputedStyle(node).color)).toBe(paint.color);
          expect(await link.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(paint.background);
          await checkAccessibility(page, info, `/header-cta/${width}/${audience}/${name}/hover`, theme);
          await link.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
          await expect(link).toBeFocused();
          expect(await link.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe(paint.shadow);
          expect(await link.evaluate(node => getComputedStyle(node).borderRadius)).toBe(paint.radius);
          await checkAccessibility(page, info, `/header-cta/${width}/${audience}/${name}/focus`, theme);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureAccessibility(page, info, `header-cta-${theme}-${width}-${audience}`);
      }
    }
    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileAuth("out"));
    await page.setViewportSize({ width: 1023, height: 900 });
    await expect(header.getByRole("link", { name: "Get started", exact: true })).toBeHidden();
    await expect(header.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(header.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Open menu", exact: true })).toBeHidden();
    expect(evidence.apiGets.every(row => row.audience === "player")).toBe(true);
    expect(evidence.apiGets.length).toBeGreaterThanOrEqual(1);
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
    await info.attach("header-cta-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`marketing navigation Sheet ${theme}: audiences, route, breakpoint and focus`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-360", "One explicit width matrix covers phone through the lg breakpoint.");
    test.setTimeout(90_000);
    const evidence = await openMobileNavFixture(page, theme);
    const originalViewport = page.viewportSize()!;
    const trigger = page.getByRole("button", { name: "Open menu", exact: true });
    const sheet = page.getByRole("dialog", { name: "Site navigation", exact: true });
    const close = sheet.getByRole("button", { name: "Close", exact: true });
    const home = sheet.getByRole("link", { name: "SC2 Tools — home", exact: true });
    const widthReceipts = [];
    for (const width of [320, 390, 768, 1023]) {
      await page.setViewportSize({ width, height: width < 400 ? 640 : 800 });
      await page.evaluate(() => { (window as MobileFixtureWindow).fixtureMobileAuth("out"); (window as MobileFixtureWindow).fixtureMobileNavigate("/guides/pvz"); });
      await trigger.focus(); await page.keyboard.press("Enter");
      await expect(sheet).toBeVisible(); await expect(close).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(trigger).toHaveAttribute("aria-controls", "mobile-nav-drawer");
      expect(await sheet.locator("#mobile-nav-drawer").count()).toBe(1);
      await expect(home).toHaveAttribute("href", "/");
      await expect(sheet.getByRole("link", { name: "Guides", exact: true })).toHaveAttribute("aria-current", "page");
      expect(await sheet.getByRole("navigation", { name: "Primary", exact: true }).locator("ul a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))))
        .toEqual(["/try", "/stream-studio", "/guides", "/community", "/reviews", "/help", "/download"]);
      await expect(sheet.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in?redirect_url=%2Fguides%2Fpvz");
      await expect(sheet.getByRole("link", { name: "Get started", exact: true })).toHaveAttribute("href", "/sign-up?redirect_url=%2Fguides%2Fpvz");
      await expect(sheet.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
      await expect(sheet.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
      const box = (await sheet.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.abs(box.x + box.width - width)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - Math.min(width, 448))).toBeLessThanOrEqual(1);
      expect(box.y).toBeGreaterThanOrEqual(-1); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const closeBox = (await close.boundingBox())!;
      expect(closeBox.width).toBeGreaterThanOrEqual(44); expect(closeBox.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      const selected = sheet.getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true });
      await selected.focus(); await page.keyboard.press("Tab"); await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(selected).toBeFocused();
      const footerBox = (await sheet.locator("footer").boundingBox())!;
      expect(footerBox.y).toBeGreaterThanOrEqual(box.y); expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewport.height + 1);
      if (width === 320) {
        expect(await sheet.locator("#mobile-nav-drawer").locator("..").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await sheet.getByRole("link", { name: "Download", exact: true }).scrollIntoViewIfNeeded();
        await expect(close).toBeInViewport(); await expect(selected).toBeInViewport();
      }
      await checkAccessibility(page, info, `/mobile-nav-sheet/${width}`, theme);
      widthReceipts.push({ width, box, footerBox });
      await captureAccessibility(page, info, `mobile-nav-${theme}-${width}`);
      await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    }

    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileAuth("player"));
    await expect.poll(() => evidence.apiGets.filter(row => row.audience === "player").length).toBe(1);
    await trigger.click(); await expect(close).toBeFocused();
    await expect(sheet.getByRole("link", { name: "Open app", exact: true })).toHaveAttribute("href", "/app");
    await expect(sheet.getByRole("link", { name: "Build library", exact: true })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileAuth("admin"));
    await expect.poll(() => evidence.apiGets.filter(row => row.audience === "admin").length).toBe(1);
    await trigger.click(); await expect(close).toBeFocused();
    await expect(sheet.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await checkAccessibility(page, info, "/mobile-nav-sheet/admin", theme);

    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileOpenLater());
    const later = page.getByRole("dialog", { name: "Later navigation dialog", exact: true });
    await expect(later).toBeVisible();
    await page.keyboard.press("Escape"); await expect(later).toHaveCount(0); await expect(sheet).toBeVisible(); await expect(close).toBeFocused();
    await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileAddLock());
    await trigger.click(); await close.click(); await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileReleaseLock());
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

    await trigger.click(); await sheet.getByRole("link", { name: "Help", exact: true }).click();
    await expect(sheet).toHaveCount(0); await expect(page).toHaveURL(/\/help$/);
    await trigger.click(); await home.click(); await expect(sheet).toHaveCount(0); await expect(page).toHaveURL(/\/$/);
    await trigger.click(); await page.evaluate(() => (window as MobileFixtureWindow).fixtureMobileNavigate("/guides/pvz"));
    await expect(sheet).toHaveCount(0);
    await page.setViewportSize({ width: 768, height: 800 }); await trigger.click();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click({ position: { x: 8, y: 8 } });
    await expect(sheet).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 1023, height: 800 }); await trigger.click(); await expect(sheet).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(sheet).toHaveCount(0); await expect(trigger).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await page.setViewportSize({ width: 390, height: 800 }); await expect(trigger).toBeVisible();
    await trigger.click(); await expect(close).toBeFocused(); await close.click(); await expect(trigger).toBeFocused();
    await page.setViewportSize(originalViewport);
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]);
    await info.attach("mobile-navigation-proof", { body: JSON.stringify({ buildId: evidence.buildId, cssNames: evidence.cssNames,
      widthReceipts, apiGets: evidence.apiGets, rejectedWrites: evidence.rejectedWrites, externalAttempts: evidence.externalAttempts }), contentType: "application/json" });
  });
}

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

type MoreFixtureWindow = typeof window & {
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

    const account = page.getByRole("button", { name: "Fixture account", exact: true });
    await account.click();
    await page.getByRole("list", { name: "Fixture account menu" }).getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(appearance).toBeVisible(); await expect(appearance.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(appearance).toBeHidden(); await expect(account).toBeFocused();

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
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "More", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => { (window as MoreFixtureWindow).fixtureNavigate("/community"); (window as MoreFixtureWindow).fixtureAuth(false); });
    await expect(page.getByRole("navigation", { name: "Quick sections" }).getByRole("link", { name: "Sign in", exact: true }))
      .toHaveAttribute("href", "/sign-in?redirect_url=%2Fcommunity");
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });
}
