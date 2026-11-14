import { expect, test } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { balanceEvidenceFixture, BALANCE_EVIDENCE_HEADERS as headers, BALANCE_EVIDENCE_ROUTE as api } from "./balance-evidence-fixture";

test("issues an exportable permit with local-only record entry", async ({ page }, info) => {
  const submittedRequests: string[] = [];
  const requests: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && request.method() !== "OPTIONS") submittedRequests.push(request.url());
  });
  await page.route(api, route => {
    requests.push(new URL(route.request().url()).search);
    return route.fulfill({ json: balanceEvidenceFixture(), headers });
  });
  await page.goto("/balance");
  await page.getByRole("link", { name: "Whine Permit" }).click();
  await expect(page.getByRole("heading", { name: "Whine Permit", exact: true })).toBeVisible();
  await page.getByLabel("Your race").selectOption("T");
  await page.getByLabel("Ladder tier or league").selectOption("diamond");
  const versusProtoss = page.getByRole("group", { name: "vs Protoss" });
  await page.getByRole("button", { name: "Issue permit" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a win or loss against at least one race.");
  await versusProtoss.getByLabel("Wins").fill("417");
  await versusProtoss.getByLabel("Losses").fill("583");
  await page.getByRole("button", { name: "Issue permit" }).click();
  await expect(page.getByRole("heading", { name: "Licensed to whine" })).toBeVisible();
  await expect(page.getByText("417W–583L · 41.7%", { exact: true })).toBeVisible();
  await expect(page.getByText("3 percentage points", { exact: true })).toBeVisible();
  await expect(page.getByText("5.3 percentage points", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data from SC2Pulse" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG" }).click();
  expect((await download).suggestedFilename()).toBe("sc2tools-permit.png");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await checkAccessibility(page, info, "/permit", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  expect(new URL(page.url()).search + new URL(page.url()).hash).toBe("");
  expect(requests).toEqual([""]);
  expect(submittedRequests).toEqual([]);
  await versusProtoss.getByLabel("Losses").fill("0");
  await expect(page.getByRole("heading", { name: "Your permit results" })).toHaveCount(0);
});
