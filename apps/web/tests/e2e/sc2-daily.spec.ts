import { expect, test, type Page } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-01T12:00:00Z"));
});

async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "SC2 Daily" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Call the fight" })).toBeVisible();
  await expect(page.getByText("Fight 1 of 5")).toBeVisible();
  const canvas = page.getByRole("region", { name: "Fight 1" }).locator("canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => {
    const surface = node as HTMLCanvasElement;
    const ctx = surface.getContext("2d");
    const pixels = ctx?.getImageData(0, 0, surface.width, surface.height).data;
    return pixels?.some((red, i) => i % 4 === 0 && pixels[i + 3] > 80 && Math.abs(red - pixels[i + 1]) > 60);
  })).toBe(true);
}

test("plays a signed-out practice set with accessible, responsive controls", async ({ page }, info) => {
  const unexpected: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/^\/(v1|sprites|replay-attacks)\//.test(path)) unexpected.push(path);
  });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const response = await page.goto("/arcade");
    expect(response?.status()).toBe(200);
    await ready(page);
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    if (await reject.isVisible()) await reject.click();
    await expect(page.getByText("Practice week \u00b7 sample fights")).toBeVisible();
    await expect(page.getByText("Resources lost:", { exact: false })).toHaveCount(0);
    const call = page.getByRole("button", { name: "Even trade" });
    const choices = page.getByRole("group", { name: "Your call" }).getByRole("button");
    expect(await choices.evaluateAll(buttons => buttons.every(button => {
      const bounds = button.getBoundingClientRect();
      const label = button.querySelector("span")?.getBoundingClientRect();
      return label && bounds.height >= 44 && label.top >= bounds.top && label.bottom <= bounds.bottom;
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => document.documentElement.clientWidth),
    );
    await checkAccessibility(page, info, "/arcade", theme);
    await captureAccessibility(page, info, "sc2-daily-" + theme, true);
    await call.focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("heading", { name: "Trade result" })).toBeFocused();
    await expect(page.getByText("Resources lost:", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip to result" })).toHaveCount(0);
    await captureAccessibility(page, info, "sc2-daily-result-" + theme, true);
  }

  for (let slot = 1; slot < 5; slot++) {
    await page.getByRole("button", { name: "Next fight" }).click();
    await expect(page.getByRole("heading", { name: "Call the fight" })).toBeFocused();
    await page.getByRole("button", { name: "Even trade" }).click();
  }
  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Copy spoiler-free result" })).toBeVisible();
  await expect(page.getByText("Streak: 1 day")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeVisible();
  expect((await page.request.get("/arcade/icons/stock-market.png")).status()).toBe(200);
  expect(unexpected).toEqual([]);
});

test("retries a failed schedule and lets Escape finish a playing clip", async ({ page }) => {
  let loads = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/daily/v1/index.json", route => {
    loads += 1;
    return loads === 1 ? route.fulfill({ status: 503, body: "" }) : route.continue();
  });
  await page.goto("/arcade");
  await expect(page.getByRole("region", { name: "Daily unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await ready(page);
  await page.getByRole("button", { name: "Blue wins big" }).click();
  await expect(page.getByRole("button", { name: "Skip to result" })).toBeFocused();
  await expect(page.getByText("Resources lost:", { exact: false })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Trade result" })).toBeFocused();
});
