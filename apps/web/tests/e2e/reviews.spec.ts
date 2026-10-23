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
  // The asker shared the replay file: signed-out visitors are sent to sign in.
  await expect(page.getByRole("link", { name: /^Sign in to download replay: \[PvZ\]/ }).first()).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Sign in to download replay", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();

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

test("review share menu works with a keyboard and keeps a clipboard fallback inside the viewport", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Synthetic clipboard denial"); } } });
  });
  const response = await page.goto(REVIEW); expect(response?.status()).toBe(200);
  const share = page.getByRole("button", { name: "Share this review" }); await expect(share).toBeEnabled();
  await share.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Share this review" });
  const reddit = menu.getByRole("menuitem", { name: "Post to Reddit" }); await expect(reddit).toBeFocused();
  await expect(reddit).toHaveAttribute("href", /^https:\/\/www\.reddit\.com\/submit\?/);
  await expect(reddit).toHaveAttribute("target", "_blank"); await expect(reddit).toHaveAttribute("rel", "noopener noreferrer");
  await expect.poll(async () => { const box = await menu.boundingBox(); return !!box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0); }).toBe(true);
  for (const item of await menu.getByRole("menuitem").all()) expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  await menu.getByRole("menuitem", { name: "Copy link" }).click();
  const fallback = menu.getByRole("textbox", { name: "Copy this text" }); await expect(fallback).toBeFocused();
  await expect(fallback).toHaveAttribute("readonly", ""); await expect(fallback).toHaveValue(new RegExp(`${REVIEW}$`));
  await expect.poll(() => fallback.evaluate((element) => { const input = element as HTMLInputElement; return input.selectionStart === 0 && input.selectionEnd === input.value.length; })).toBe(true);
  if (testInfo.project.name === "mobile-360") await page.screenshot({ path: testInfo.outputPath("review-share-menu-360.png") });
  await fallback.press("Escape"); await expect(menu).toHaveCount(0); await expect(share).toBeFocused();
  await expectNoHorizontalScroll(page, REVIEW);
});

test("my reviews asks signed-out visitors to sign in", async ({ page }) => {
  const response = await page.goto("/reviews/mine");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByText("Sign in to see your reviews")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expectNoHorizontalScroll(page, "/reviews/mine");
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
