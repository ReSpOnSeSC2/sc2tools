import { expect, test } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { balanceEvidenceFixture, BALANCE_EVIDENCE_HEADERS as headers, BALANCE_EVIDENCE_ROUTE as api } from "./balance-evidence-fixture";

const today = "2026-11-13";
const previous = "2026-11-12";
const pinnedClaim = `/balance/claim#season=68&asOf=${previous}&matchup=pvt&tier=diamond-1&race=T&map=5`;

test("checks and downloads a claim with a pinned map receipt", async ({ page }, info) => {
  await page.route(api, route => route.fulfill({ json: balanceEvidenceFixture(), headers }));
  await page.goto("/balance/claim");
  await page.getByLabel("Race you think has the advantage").selectOption("T");
  await page.getByLabel("Map", { exact: true }).selectOption("5");
  await page.getByRole("button", { name: "Check claim" }).click();
  const receipt = page.getByRole("article", { name: "Opposite advantage supported" });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText("40.0%", { exact: true })).toBeVisible();
  await expect(receipt.getByText("500", { exact: true })).toBeVisible();
  await expect(receipt.getByText("99% Wilson interval")).toBeVisible();
  await expect(page).toHaveURL(`/balance/claim#season=68&asOf=${today}&matchup=pvt&tier=diamond-1&race=T&map=5`);
  const download = page.waitForEvent("download");
  await receipt.getByRole("button", { name: "Download PNG" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await checkAccessibility(page, info, "/balance/claim", theme);
    await captureAccessibility(page, info, `balance-claim-${theme}`, true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("retrieves the exact historical date and offers a separate latest action if it disappears", async ({ page }) => {
  let missing = false;
  const requested: string[] = [];
  await page.route(api, route => {
    const date = new URL(route.request().url()).searchParams.get("asOf");
    requested.push(date ?? "latest");
    if (date && missing) return route.fulfill({ status: 404, headers });
    return route.fulfill({ json: balanceEvidenceFixture(date ?? today), headers });
  });
  await page.goto(pinnedClaim);
  await expect(page.getByRole("article", { name: "Opposite advantage supported" }).getByText(previous)).toBeVisible();
  missing = true;
  await page.reload();
  await expect(page.getByText("This pinned snapshot is unavailable.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(requested).toEqual([previous, previous]);
  await page.getByRole("button", { name: "Use latest snapshot" }).click();
  await expect(page.getByRole("button", { name: "Check claim" })).toBeVisible();
  expect(requested).toEqual([previous, previous, "latest"]);
});

test("links matchup and league evidence to a pinned receipt", async ({ page }) => {
  await page.route(api, route => route.fulfill({ json: balanceEvidenceFixture(), headers }));
  await page.goto("/balance/pvt");
  await expect(page.getByRole("heading", { name: "Protoss vs Terran Ladder Balance" })).toBeVisible();
  await page.getByRole("link", { name: "Diamond", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Diamond Ladder Balance" })).toBeVisible();
  const first = page.getByRole("article").filter({ has: page.getByRole("link", { name: "Protoss vs Terran" }) });
  await expect(first.getByText("3,000", { exact: true })).toBeVisible();
  await first.getByRole("link", { name: "View Protoss vs Terran receipt for Diamond" }).click();
  await expect(page.getByRole("article", { name: "Advantage supported" })).toBeVisible();
  await expect(page).toHaveURL(`/balance/claim#season=68&asOf=${today}&matchup=pvt&tier=diamond&race=P`);
});
