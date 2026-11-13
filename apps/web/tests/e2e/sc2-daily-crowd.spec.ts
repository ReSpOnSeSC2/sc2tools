import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const DATE = new Date("2026-11-01T12:00:00Z");
const DAY = Math.floor(DATE.getTime() / 86_400_000);
const SYNTHETIC_RECORDED = "e".repeat(64);
const CALL_PATH = "**/v1/daily/calls";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type",
  "access-control-allow-methods": "POST",
};

async function useSyntheticSchedule(page: Page) {
  // The committed practice clip is synthetic. Only the intercepted schedule
  // presents it under a recorded slot, with a distinct fixture digest.
  const index = JSON.parse(await readFile("public/daily/v1/index.json", "utf8"));
  await page.route("**/daily/v1/index.json", route =>
    route.fulfill({ json: { ...index, days: { [DAY]: SYNTHETIC_RECORDED, [DAY - 1]: SYNTHETIC_RECORDED } } }));
  await page.route("**/daily/v1/packs/" + SYNTHETIC_RECORDED + "/*", route =>
    route.continue({ url: route.request().url().replace(SYNTHETIC_RECORDED, index.practice[0]) }));
}

async function completeDaily(page: Page) {
  for (let slot = 0; slot < 5; slot++) {
    const choice = page.getByRole("button", { name: "Even trade" });
    await choice.focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("heading", { name: "Trade result" })).toBeFocused();
    await page.getByRole("button", { name: slot < 4 ? "Next fight" : "See results" }).click();
  }
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeFocused();
}

async function verifySharedFight(page: Page) {
  const crowd = page.getByRole("region", { name: "Crowd split" });
  const copy = page.getByRole("button", { name: "Copy fight 3 link" });
  const expectedLink = `/arcade#fight=${DAY}-3`;
  await page.evaluate(() => {
    const record = (value: string) => {
      document.documentElement.dataset.copiedFight = value;
      return Promise.resolve();
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: record } });
  });
  await copy.click();
  await expect(page.locator("html")).toHaveAttribute("data-copied-fight", "https://sc2tools.com" + expectedLink);
  const link = crowd.getByRole("link", { name: "Play fight 3" });
  await expect(link).toHaveAttribute("href", expectedLink);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fight 3 of 5")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Call the fight" })).toBeFocused();
  await expect(page.getByText("Resources lost:", { exact: false })).toHaveCount(0);
  await expect(crowd).toHaveCount(0);
  await expect(page.getByText("Streak:", { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Fight 3 of 5")).toBeVisible();
  await page.getByRole("button", { name: "Even trade" }).click();
  await expect(page.getByRole("heading", { name: "Trade result" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Next fight" })).toHaveCount(0);
  await page.getByRole("link", { name: "Play today's set" }).click();
  await expect(page.getByRole("heading", { name: "Set complete" })).toBeVisible();
  await expect(page.getByText("Streak: 1 day")).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`shares a synthetic recorded set and shows real-count states in ${theme}`, async ({ page }, info) => {
    await page.clock.setFixedTime(DATE);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await useSyntheticSchedule(page);
    const received: unknown[] = [];
    await page.route(CALL_PATH, route => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().cookie).toBeUndefined();
      received.push(route.request().postDataJSON());
      if (received.length === 1) return route.fulfill({ status: 503, headers: CORS, body: "" });
      const result = received.length === 2 ? { state: "waiting" } : {
        state: "ready", total: 20, fights: Array.from({ length: 5 }, () => [1, 2, 12, 4, 1]),
      };
      return route.fulfill({ headers: CORS, json: result });
    });

    await page.goto("/arcade");
    await expect(page.getByText("Today\u2019s recorded fights")).toBeVisible();
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    if (await reject.isVisible()) await reject.click();
    const crowd = page.getByRole("region", { name: "Crowd split" });
    await expect(crowd).toHaveCount(0);
    await completeDaily(page);
    expect(received).toEqual([]);
    const submit = crowd.getByRole("button", { name: "See crowd split" });
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(crowd.getByRole("alert")).toContainText("retry without adding another vote");
    await crowd.getByRole("button", { name: "Retry crowd split" }).click();
    await expect(crowd.getByRole("status")).toContainText("after 20 votes");
    await expect(crowd.getByText("%", { exact: false })).toHaveCount(0);
    await captureAccessibility(page, info, "sc2-daily-crowd-waiting-" + theme, true);
    await crowd.getByRole("button", { name: "Check crowd split" }).click();
    await expect(crowd.getByRole("status")).toHaveText("20 votes for this set.");
    await expect(crowd.getByRole("status")).toBeFocused();
    await expect(crowd.getByText("60%", { exact: true })).toHaveCount(5);
    await expect(crowd.getByRole("link", { name: /Play fight/ })).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => document.documentElement.clientWidth),
    );
    await checkAccessibility(page, info, "/arcade#crowd", theme);
    await captureAccessibility(page, info, "sc2-daily-crowd-ready-" + theme, true);

    await verifySharedFight(page);
    expect(received).toHaveLength(3);
    await crowd.getByRole("button", { name: "See crowd split" }).click();
    await expect(crowd.getByRole("status")).toHaveText("20 votes for this set.");
    expect(received).toEqual(Array(4).fill(received[0]));
    expect(received[0]).toEqual({
      day: DAY, pack: SYNTHETIC_RECORDED, answers: [2, 2, 2, 2, 2], attempt: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    await page.goto(`/arcade#fight=${DAY - 1}-1`);
    await expect(page.getByRole("heading", { name: "Call the fight" })).toBeFocused();
    await expect(page.getByText("Fight 1 of 5")).toBeVisible();
    await expect(crowd).toHaveCount(0);
    expect(received).toHaveLength(4);
  });
}
