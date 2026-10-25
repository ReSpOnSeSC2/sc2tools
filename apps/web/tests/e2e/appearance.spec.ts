import { expect, test } from "@playwright/test";

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
  await page.keyboard.press("Shift+Tab");
  const system = drawer.getByRole("radio", { name: "System", exact: true });
  await expect(system).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await system.focus();
  await page.keyboard.press("Home");
  await expect(drawer.getByRole("radio", { name: "Light", exact: true })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "light");
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
