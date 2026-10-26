import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { checkAccessibility } from "./accessibility-check";
import { openSettingsRegistryFixture } from "./settings-registry-fixture.mjs";

type SettingsFixtureWindow = typeof window & { settingsFixtureNavigate: (href: string) => void };
const shots = path.resolve(process.env.SETTINGS_SHOTS_DIR ?? path.join("../../.cache", `settings-registry-browser-${Date.now()}`));

for (const theme of ["light", "dark"] as const) {
  test(`Settings groups ${theme}: aliases, keyboard, draft guard and active panels`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const evidence = await openSettingsRegistryFixture(page, theme);
    const mobile = page.viewportSize()!.width < 1024;
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().replace(/\s+/g, " ")))
      .toBe(theme === "light" ? "244 246 250" : "6 9 14");
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("SettingsHanken");
    const list = page.getByRole("tablist", { name: "Settings sections", exact: true });
    const panel = page.getByRole("tabpanel");
    await expect(list).toHaveCount(1);
    await expect(list).toHaveAttribute("aria-orientation", mobile ? "horizontal" : "vertical");
    expect(await list.getByRole("tab").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-value"))))
      .toEqual(["account", "profile", "backups", "checkin", "randomizer", "import", "overlay", "voice", "preferences", "help"]);
    expect(evidence.panelReads).toEqual(["preferences"]);
    if (!mobile) {
      const sidebar = page.getByRole("navigation", { name: "Settings navigation", exact: true });
      await expect(sidebar.getByRole("heading", { name: "Gameplay", exact: true })).toBeVisible();
      const devices = sidebar.getByRole("link", { name: "Devices", exact: true });
      await expect(devices).toHaveAttribute("href", "/devices");
      await expect(devices).toHaveAttribute("data-settings-group", "account");
      await expect(list.getByRole("tab", { name: "Overlay", exact: true })).toHaveAccessibleDescription("Streaming OBS URLs, scenes, theme, chat");
      expect(await list.evaluate(node => getComputedStyle(node).display)).toBe("contents");
      expect(await list.evaluate(node => Array.from(node.children).every(child => child.getAttribute("role") === "tab"))).toBe(true);
      const account = (await list.getByRole("tab", { name: "Account", exact: true }).boundingBox())!;
      const backups = (await list.getByRole("tab", { name: "Backups & data", exact: true }).boundingBox())!;
      const deviceBox = (await devices.boundingBox())!;
      const gameplay = (await sidebar.getByRole("heading", { name: "Gameplay", exact: true }).boundingBox())!;
      expect(account.y).toBeLessThan(backups.y); expect(backups.y + backups.height).toBeLessThanOrEqual(deviceBox.y + 1);
      expect(deviceBox.y + deviceBox.height).toBeLessThanOrEqual(gameplay.y + 1);
      await list.getByRole("tab", { name: "Preferences", exact: true }).focus();
      await page.keyboard.press("Shift+Tab"); await expect(devices).toBeFocused();
      await page.keyboard.press("Tab"); await expect(list.getByRole("tab", { name: "Preferences", exact: true })).toBeFocused();
    } else {
      await list.getByRole("tab", { name: "Preferences", exact: true }).focus();
      await page.keyboard.press("Tab"); await expect(panel).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(list.getByRole("tab", { name: "Preferences", exact: true })).toBeFocused();
    }
    await mkdir(shots, { recursive: true });
    await checkAccessibility(page, info, "/settings-registry-initial", theme);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-preferences.png`), fullPage: true });

    await panel.getByLabel("Local draft", { exact: true }).fill("Keep this unsaved choice");
    await expect(list.getByRole("img", { name: "Unsaved changes", exact: true })).toHaveCount(1);
    // External navigation resolves the old name, then enters the real guard.
    await page.evaluate(() => (window as SettingsFixtureWindow).settingsFixtureNavigate("/settings?tab=foundation&ref=legacy"));
    const dialog = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
    await expect(dialog).toBeVisible();
    await expect(panel.getByLabel("Local draft", { exact: true })).toHaveValue("Keep this unsaved choice");
    expect(evidence.panelReads).toEqual(["preferences"]);
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const discard = dialog.getByRole("button", { name: "Discard & switch", exact: true });
    await discard.focus(); await page.keyboard.press("Tab"); await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(discard).toBeFocused();
    await checkAccessibility(page, info, "/settings-registry-draft-guard", theme);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-${theme}-guard.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByLabel("Local draft", { exact: true })).toHaveValue("Keep this unsaved choice");
    await expect(page).toHaveURL(/\/settings\?tab=preferences&ref=legacy$/);
    await list.getByRole("tab", { name: "Account", exact: true }).click();
    await expect(dialog).toBeVisible();
    await discard.click();
    await expect(panel.getByRole("heading", { name: "Account panel", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?tab=account&ref=legacy$/);
    expect(evidence.panelReads).toEqual(["preferences", "account"]);

    await page.evaluate(() => (window as SettingsFixtureWindow).settingsFixtureNavigate("/settings?tab=streaming#platform-connections"));
    await expect(panel.getByRole("heading", { name: "Overlay panel", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\?tab=streaming#platform-connections$/);
    await expect(panel.locator("#platform-connections")).toHaveAttribute("data-section-flash", /.+/);
    await list.getByRole("tab", { name: "Backups & data", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Backups & data panel", exact: true })).toBeVisible();
    const backups = list.getByRole("tab", { name: "Backups & data", exact: true });
    await backups.focus(); await page.keyboard.press(mobile ? "ArrowRight" : "ArrowDown");
    await expect(list.getByRole("tab", { name: "Build check-in", exact: true })).toBeFocused();
    await expect(panel.getByRole("heading", { name: "Build check-in panel", exact: true })).toBeVisible();
    await page.keyboard.press("Home");
    await expect(panel.getByRole("heading", { name: "Account panel", exact: true })).toBeVisible();
    await page.keyboard.press("End");
    await expect(list.getByRole("tab", { name: "Help", exact: true })).toBeFocused();
    await expect(panel.getByRole("heading", { name: "Help panel", exact: true })).toBeVisible();
    await list.getByRole("tab", { name: "Preferences", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Preferences panel", exact: true })).toBeVisible();
    await expect(panel.getByLabel("Local draft", { exact: true })).toHaveValue("");
    expect(evidence.panelReads).toEqual(["preferences", "account", "overlay", "backups", "checkin", "account", "help", "preferences"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const selected = list.getByRole("tab", { name: "Preferences", exact: true });
    await expect(selected).toBeInViewport();
    const buttonBox = (await selected.boundingBox())!;
    expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    await checkAccessibility(page, info, "/settings-registry-final", theme);
    expect(evidence.errors).toEqual([]);
    expect(evidence.unexpectedRequests).toEqual([]);
    await info.attach("settings-fixture-transport", { contentType: "application/json", body: JSON.stringify({ panelReads: evidence.panelReads, unexpectedRequests: evidence.unexpectedRequests, cssNames: evidence.cssNames, actualAccountWrites: 0 }) });
  });
}
