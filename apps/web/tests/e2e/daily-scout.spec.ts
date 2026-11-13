import { expect, test, type Page } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const path = "/arcade/scout";

async function chooseByKeyboard(page: Page) {
  const choices = page.getByRole("group", { name: "Choose a strategy" }).getByRole("button");
  await expect(choices).toHaveCount(3);
  const choice = choices.first();
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Strategy revealed" })).toBeFocused();
  await expect(page.getByRole("region", { name: "Daily Scout game" }).locator("strong"))
    .toHaveText(/^(Protoss|Zerg|Terran|[PTZ]v[PTZ]) - /);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-01T12:00:00Z"));
});

test("finds Daily Scout in the public Arcade", async ({ page }) => {
  await page.goto("/arcade");
  const entry = page.getByRole("link", { name: /Play Daily Scout/ });
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("href", path);
});

test("plays keyboard-first in both themes without leaving the static site", async ({ page, context, baseURL }, info) => {
  const unexpected: string[] = [];
  const origin = new URL(baseURL!).origin;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    const permitted = url.pathname === path || /^\/_next\/static\//.test(url.pathname)
      || /^\/daily\/scout\/v1\/(?:index\.json|packs\/[a-f0-9]{64}\/pack\.json)$/.test(url.pathname)
      || /^\/icons\/pwa\//.test(url.pathname);
    if (url.origin === origin && permitted && route.request().method() === "GET") return route.continue();
    unexpected.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => { localStorage.setItem("sc2tools.analyticsConsent.v1", "granted"); });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Daily Scout" })).toBeVisible();
    await expect(page.getByText("Practice week · sample openings")).toBeVisible();
    await expect(page.getByText("Opening 1 of 5")).toBeVisible();
    const slider = page.getByRole("slider", { name: /Game time/ });
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", "0:00");
    await expect(page.getByText("Building timeline (1)")).toBeVisible();
    await page.keyboard.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", "6:00");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => document.documentElement.clientWidth),
    );
    await checkAccessibility(page, info, path, theme);
    await captureAccessibility(page, info, `daily-scout-${theme}`, true);
    await chooseByKeyboard(page);
    await captureAccessibility(page, info, `daily-scout-reveal-${theme}`, true);
  }

  for (let slot = 1; slot < 5; slot++) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Next opening" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "What was the opening?" })).toBeFocused();
    await chooseByKeyboard(page);
  }
  await page.getByRole("button", { name: "See results" }).click();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Copy spoiler-free result" })).toBeVisible();
  await expect(page.getByText(/Practice streak 1 day$/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("recovers from an unavailable schedule", async ({ page }) => {
  await page.route("**/daily/scout/v1/index.json", route => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto(path);
  await expect(page.getByRole("status")).toHaveText("The set could not load.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "What was the opening?" })).toBeVisible();
});
