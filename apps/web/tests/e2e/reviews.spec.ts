import { expect, test, type Page } from "@playwright/test";

/**
 * Replay Review Exchange, signed out, at every viewport project
 * (mobile-360, tablet-768, desktop-1280): the public board and a review
 * page render from the fixture API (tests/e2e/mock-review-api.mjs) with
 * no horizontal scroll, the replay visible and the comments readable.
 * Requires NEXT_PUBLIC_REVIEWS_ENABLED=on at build time.
 */

const REVIEW = "/reviews/e2eReviewFixture";

async function expectNoHorizontalScroll(page: Page, path: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${path} horizontally overflows: content ${overflow.scrollWidth}px > viewport ${overflow.clientWidth}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test("review board renders signed out without horizontal scroll", async ({ page }) => {
  const response = await page.goto("/reviews");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.locator("main").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Replay reviews" })).toBeVisible();
  const card = page.getByTestId("review-card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Why did my blink all-in fail");
  await expect(card).toContainText("3 reviews");
  await expectNoHorizontalScroll(page, "/reviews");
});

test("review page shows the replay and readable comments signed out", async ({ page }, testInfo) => {
  const response = await page.goto(REVIEW);
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("[PvZ] Why did my blink all-in fail");
  // The opponent is only ever named by the redacted label.
  await expect(page.locator("main")).toContainText("Opponent (Zerg, ~4,100 MMR)");

  const replay = page.getByTestId("replay-stage");
  await expect(replay).toBeVisible();
  await expect(page.getByLabel(/Map playback of/)).toBeVisible();

  const comments = page.getByTestId("review-comment");
  await expect(comments.first()).toBeVisible();
  await expect(comments.first()).toContainText("blink timing");
  await expect(page.getByText("Best review").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  // The consent banner (fixed to the bottom on phones) would sit over
  // the thread; a real visitor answers it first.
  const reject = page.locator("[data-cookie-banner]").getByRole("button", { name: "Reject" });
  if (await reject.isVisible()) await reject.click();

  // A time chip seeks the replay (and it stays on screen: pinned on
  // phones, beside the thread on desktop).
  await page.getByRole("button", { name: "Jump to 5:12–5:40 in the replay" }).click();
  await expect(page.getByTestId("replay-transport")).toContainText("5:12 / 10:00");

  // Scroll the thread: the last comment and the replay are both on
  // screen together.
  const last = comments.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  if ((testInfo.project.use.viewport?.width ?? 1280) < 1280) {
    await expect(page.getByLabel(/Map playback of/)).toBeInViewport();
  }
  const fontSize = await comments.first().evaluate((el) => Number.parseFloat(getComputedStyle(el.querySelector("p") ?? el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(14);

  await expectNoHorizontalScroll(page, REVIEW);
});

test("a missing review is a real 404", async ({ page }) => {
  // A well-formed id the API 404s, and a malformed one rejected before
  // any fetch: both must be a real 404 status, not a streamed soft-404.
  for (const path of ["/reviews/doesNotExist0000", "/reviews/not-a-review"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByText("Review not found")).toBeVisible();
  }
});
