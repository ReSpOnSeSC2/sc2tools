import { expect, test, type Page } from "@playwright/test";
import { openMyReviewsFixture } from "./my-reviews-fixture.mjs";

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("My reviews tabs, page recovery and written sorting work with the real hooks", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openMyReviewsFixture(page, { failPage: true });
  await expect(page.getByRole("tab", { name: "Needs your response (2)" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("How should I defend the third base in needs-1?", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review board", exact: true })).toHaveAttribute("href", "/reviews");
  await expect(page.getByRole("button", { name: "Ask about one of your games" })).toBeVisible();
  await page.getByRole("button", { name: "Load more requests" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("How should I defend the third base in needs-1?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("How should I defend the third base in needs-older?", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your review requests" }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("tab", { name: "Waiting for reviews (1)" }).click();
  await expect(page).toHaveURL(/tab=waiting/);
  await expect(page.getByText("How should I defend the third base in waiting-1?", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Answered (0)" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Closed (0)" })).toBeFocused();
  await expect(page.getByText("No closed requests", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Most upvoted" }).click();
  await expect(page.getByText("Scout the third base before moving out: most-upvoted.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more written reviews" }).click();
  await expect(page.getByText("Scout the third base before moving out: written-older.", { exact: true })).toBeVisible();
  expect(calls.some((call) => call.query.includes("section=answered&sort=top"))).toBe(true);
  await noOverflow(page); expect(errors).toEqual([]);
  if (info.project.name === "mobile-360") await page.screenshot({ path: info.outputPath("my-reviews-tabs-phone.png"), fullPage: true });
});

test("Reviewer profile has accessible stats, preference rollback and digest saving", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openMyReviewsFixture(page, { tab: "closed" });
  const profile = page.getByRole("region", { name: "Your reviewer profile" });
  await expect(profile.getByText("Fixture Reviewer", { exact: true })).toBeVisible();
  await expect(profile.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "14");
  await expect(profile.getByRole("link", { name: "Get the desktop app" })).toHaveAttribute("href", "/download");
  await expect(profile.getByText("First Review", { exact: true })).toBeVisible();
  await profile.getByRole("switch", { name: "Show my name on the weekly leaderboard" }).click();
  await expect(profile.getByRole("alert")).toHaveText("Couldn't save that setting. Try again.");
  await expect(profile.getByRole("switch", { name: "Show my name on the weekly leaderboard" })).toHaveAttribute("aria-checked", "false");
  await profile.getByRole("switch", { name: "Weekly digest of open requests in my matchups" }).click();
  await expect(profile.getByRole("alert")).toHaveCount(0);
  await expect(profile.getByRole("switch", { name: "Weekly digest of open requests in my matchups" })).toBeEnabled();
  await expect(profile.getByRole("switch", { name: "Weekly digest of open requests in my matchups" })).toHaveAttribute("aria-checked", "false");
  expect(calls.filter((call) => call.body).map((call) => call.body)).toEqual([{ leaderboardOptIn: true }, { weeklyDigest: false }]);
  await page.evaluate(() => { location.hash = "reviewer-profile"; });
  await expect(profile).toBeFocused(); await noOverflow(page); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("my-reviewer-profile.png"), fullPage: true });
});
