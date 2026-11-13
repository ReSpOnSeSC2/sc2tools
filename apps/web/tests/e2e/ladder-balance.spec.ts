import { expect, test } from "@playwright/test";
import { balanceBundleFixture } from "../../lib/balance/fixture.test-data";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const ROUTE = "/balance";
const SNAPSHOT = "**/v1/ladder/balance";
const API_HEADERS = { "access-control-allow-origin": "*" };

test("links to Ladder Balance from the home page", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("navigation", { name: "More SC2 Tools" }).getByRole("link", { name: "Ladder Balance" });
  await expect(link).toHaveAttribute("href", ROUTE);
  expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

test("reads the tracked snapshot, filters tiers, and keeps cross-tier data separate", async ({ page }, info) => {
  const data = balanceBundleFixture();
  await page.route(SNAPSHOT, route => route.fulfill({ json: data, headers: API_HEADERS }));
  await page.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(ROUTE);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByRole("heading", { name: "Ladder Balance", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "SC2Pulse API" })).toHaveAttribute("href", "https://sc2pulse.nephest.com/sc2/");
    await expect(page.getByText("Season 68", { exact: true })).toBeVisible();
    await expect(page.getByText("November 12, 2026 UTC")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Diamond 1 same-tier matchups" })).toBeVisible();
    const first = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Protoss vs Terran" }) });
    await expect(first.getByText("51.5%", { exact: true })).toBeVisible();
    await expect(first.getByText("1,000", { exact: true })).toBeVisible();
    await expect(first.getByText("40.5%", { exact: true })).toBeHidden();
    await first.getByText("Cross-tier games", { exact: true }).press("Enter");
    await expect(first.getByText("40.5%", { exact: true })).toBeVisible();
    await expect(first.getByText("200", { exact: true })).toBeVisible();
    await expect(first.getByText("51.5%", { exact: true })).toBeVisible();
    await checkAccessibility(page, info, ROUTE, theme);
    await captureAccessibility(page, info, `ladder-balance-${theme}`, true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Ladder tier" }).selectOption("grandmaster");
    await expect(page.getByRole("heading", { name: "Grandmaster same-tier matchups" })).toBeVisible();
    await expect(page.getByText("No same-tier games in this snapshot.")).toHaveCount(3);
  }
});

test("retries an unavailable snapshot without showing invented counts", async ({ page }) => {
  await page.route(SNAPSHOT, route => route.fulfill({ json: balanceBundleFixture(), headers: API_HEADERS }));
  await page.route(SNAPSHOT, route => route.fulfill({ status: 503, headers: API_HEADERS }), { times: 1 });
  await page.clock.setFixedTime(new Date("2026-11-15T12:00:00Z"));
  await page.goto(ROUTE);
  await expect(page.getByText("The ladder balance snapshot is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Ladder tier" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry snapshot" }).click();
  await expect(page.getByRole("heading", { name: "Diamond 1 same-tier matchups" })).toBeVisible();
  await expect(page.getByText("Showing the last complete snapshot.")).toBeVisible();
});
