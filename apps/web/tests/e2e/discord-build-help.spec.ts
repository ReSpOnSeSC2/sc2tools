import { expect, test } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const path = "/help/discord-build-command";

for (const theme of ["light", "dark"] as const) {
  test(`signed-out Discord build help fits in ${theme} theme`, async ({ page }, info) => {
    const discordRequests: string[] = [];
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")) discordRequests.push(url.pathname);
      return url.hostname === "127.0.0.1" || url.hostname === "localhost" ? route.continue() : route.abort();
    });
    await page.addInitScript(value => localStorage.setItem("sc2tools.theme", value), theme);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Add the SC2 Tools build command to Discord" })).toBeVisible();
    await expect(page.getByText("Discord installation is currently unavailable.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add to Discord" })).toHaveCount(0);
    await expect(page.getByRole("article").getByRole("link", { name: "build guides", exact: true })).toHaveAttribute("href", "/guides");
    await expect(page.getByRole("article").getByRole("link", { name: "privacy policy", exact: true })).toHaveAttribute("href", "/legal/privacy#discord-build-command");
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    if (await reject.isVisible()) await reject.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await checkAccessibility(page, info, path, theme);
    expect(discordRequests).toEqual([]);
    await captureAccessibility(page, info, `discord-build-help-${theme}`, true);
  });
}
