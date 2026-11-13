import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { ScoutPack, ScoutPuzzle } from "../../lib/daily/scout";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const path = "/arcade/scout";
const scheduledDay = 20758;

function trackStaticRequests(page: Page, baseURL: string, extra?: (pathname: string) => string | undefined) {
  const unexpected: string[] = [];
  const origin = new URL(baseURL).origin;
  const routed = page.context().route("**/*", route => {
    const url = new URL(route.request().url());
    const permitted = url.pathname === path || /^\/_next\/static\//.test(url.pathname)
      || /^\/daily\/scout\/v1\/(?:index\.json|packs\/[a-f0-9]{64}\/pack\.json)$/.test(url.pathname)
      || /^\/icons\/pwa\//.test(url.pathname);
    if (url.origin === origin && permitted && route.request().method() === "GET") {
      const body = extra?.(url.pathname);
      return body === undefined ? route.continue() : route.fulfill({ contentType: "application/json", body });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  return { routed, unexpected };
}

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
  const { routed, unexpected } = trackStaticRequests(page, baseURL!);
  await routed;
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
    await expect(slider).toHaveAttribute("aria-valuetext", "7:30");
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

function scheduledFixture() {
  const puzzle: ScoutPuzzle = {
    strategy: "Zerg - 2 Base Nydus",
    width: 256,
    height: 240,
    buildings: [
      ["Hatchery", 0, 20, 19], ["Hatchery", 38.25, 120, 119],
      ["SpawningPool", 54, 122, 120], ["NydusNetwork", 390, 120, 119],
    ],
  };
  const pack: ScoutPack = { version: 1, puzzles: Array.from({ length: 5 }, (_, i) => ({
    ...puzzle, buildings: i ? puzzle.buildings.map(([kind, time, x, y]) => [kind, time, x + i, y]) : puzzle.buildings,
  })) };
  const packBody = JSON.stringify(pack);
  const digest = createHash("sha256").update(packBody).digest("hex");
  const index = JSON.stringify({ version: 1, days: { [scheduledDay]: digest }, practice: Array(7).fill("e".repeat(64)) });
  return { packBody, digest, index };
}

async function checkTrackerEvidence(page: Page) {
  const slider = page.getByRole("slider", { name: /Game time/ });
  await slider.focus();
  await page.keyboard.press("Home");
  for (let second = 0; second < 38; second++) await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Building timeline (1)")).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", "0:38");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "0:38.25");
  await expect(page.getByText("Building timeline (2)")).toBeVisible();
  await page.keyboard.press("End");
  const older = page.getByRole("button", { name: /0:38\.25\s*Hatchery/ });
  await older.focus();
  await expect(older).toHaveAttribute("aria-pressed", "true");
  await expect(older.getByText("120 from left · 119 from bottom")).toBeVisible();
  const top = page.locator("svg [data-marker]").last();
  await expect(top).toHaveAttribute("data-marker", "2");
  await expect(top).toHaveAttribute("transform", "translate(120 121)");
  await page.getByRole("button", { name: /6:30\s*Nydus Network/ }).click();
  await expect(top).toHaveAttribute("data-marker", "4");
  await expect(top).toHaveAttribute("transform", "translate(120 121)");
}

test("plays a scheduled Tracker set with private progress and exact, selectable evidence", async ({ page, context, baseURL }, info) => {
  const fixture = scheduledFixture();
  const { routed, unexpected } = trackStaticRequests(page, baseURL!, pathname => {
    if (pathname.endsWith("/index.json")) return fixture.index;
    if (pathname.includes(fixture.digest)) return fixture.packBody;
  });
  await routed;
  await context.addInitScript(day => {
    localStorage.setItem("sc2tools.analyticsConsent.v1", "granted");
    localStorage.setItem("sc2tools:daily:v1:scout:practice", JSON.stringify({ [day]: [false, false, false, false, false] }));
  }, scheduledDay);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(path);
    await expect(page.getByText("Daily set · Tracker openings")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What was the opening?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zerg - 2 Base Nydus" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Daily Scout game" }).locator("strong")).toHaveCount(0);
    await checkTrackerEvidence(page);
    await checkAccessibility(page, info, path, "tracker-" + theme);
    await captureAccessibility(page, info, "daily-scout-tracker-" + theme, true);
  }
  for (let i = 0; i < 5; i++) {
    await page.getByRole("button", { name: "Zerg - 2 Base Nydus" }).click();
    await expect(page.getByRole("heading", { name: "Strategy revealed" })).toBeFocused();
    await expect(page.getByText("Correct. Zerg - 2 Base Nydus")).toBeVisible();
    await page.getByRole("button", { name: i === 4 ? "See results" : "Next opening" }).click();
  }
  await expect(page.getByText("5 of 5 correct · Tracker streak 1 day")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeVisible();
  await expect(page.getByText("5 of 5 correct · Tracker streak 1 day")).toBeVisible();
  const recorded = await page.evaluate(() => localStorage.getItem("sc2tools:daily:v1:scout:recorded"));
  expect(JSON.parse(recorded ?? "{}")).toEqual({ [scheduledDay]: [true, true, true, true, true] });
  expect(unexpected).toEqual([]);
});

test("recovers from an unavailable schedule", async ({ page }) => {
  await page.route("**/daily/scout/v1/index.json", route => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto(path);
  await expect(page.getByRole("status")).toHaveText("The set could not load.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "What was the opening?" })).toBeVisible();
});
