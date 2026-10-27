import { expect, test as base, type Page } from "@playwright/test";
import { closeReviewLifecycleDownloadServer, openReviewLifecycleFixture } from "./review-lifecycle-fixture.mjs";

// Trust only the public local-test key before Chromium's first TLS probe.
// Preserve the caller's pinned executable, proxy arguments and other options.
const REVIEW_TLS_SPKI = "wJUMA7xGnryPZb2+HIZAP695jfsS0WzvSmbrkFM5TsU=";
const test = base.extend({
  launchOptions: async ({ launchOptions }, provideOptions) => {
    await provideOptions({ ...launchOptions, args: [...(launchOptions.args ?? []), `--ignore-certificate-errors-spki-list=${REVIEW_TLS_SPKI}`] });
  },
});
test.afterAll(async ({ browserName }, info) => {
  const receipt = await closeReviewLifecycleDownloadServer();
  await info.attach("review-loopback-download-cleanup", { contentType: "application/json", body: JSON.stringify({ browserName, ...receipt }) });
  expect(receipt.closed).toBe(true); expect(receipt.listening).toBe(false); expect(receipt.openSockets).toBe(0);
  expect(receipt.activeDownload).toBe(false); expect(receipt.errors).toEqual([]); expect(receipt.rejected).toEqual([]);
  expect(receipt.requests.every(request => request.status === 200 && request.filename === "sc2tools-review-fixtureReview001.SC2Replay")).toBe(true);
});

const QUESTION = "How should I defend this attack at the third base?";
async function createRequest(page: Page) {
  await page.getByRole("button", { name: "Ask for a review", exact: true }).click();
  await page.getByRole("textbox", { name: "Your question" }).fill(QUESTION);
  await page.getByRole("button", { name: "Post request", exact: true }).click();
  await expect(page).toHaveURL(/\/reviews\/fixtureReview001$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(QUESTION);
  await expect(page.getByTestId("review-timeline-fallback")).toBeVisible();
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("authenticated Review lifecycle saves once, recovers refresh, edits/replies/marks and closes the grant", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await openReviewLifecycleFixture(page, { failAfterComment: true, failAfterClose: true });
  await createRequest(page);
  const creation = fixture.calls.filter(call => call.method === "POST" && call.path === "/v1/reviews");
  expect(creation).toHaveLength(1); expect(creation[0].body).toMatchObject({ gameId: "private-fixture-game", askerDisplay: "anonymous", shareReplay: false });
  await page.getByRole("button", { name: "Use reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Comment at 0:00", exact: true }).click();
  const form = page.getByRole("form", { name: "Write a review comment" });
  await form.getByRole("textbox", { name: "Comment", exact: true }).fill("Scout the third base before moving out at 5:12.");
  await form.getByRole("button", { name: "Comment at 0:00", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved changes won't be submitted again");
  expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/comments"))).toHaveLength(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const review = page.getByRole("article", { name: "Comment by Fixture Reviewer", exact: true });
  await expect(review).toContainText("Scout the third base before moving out at 5:12.");
  expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/comments"))).toHaveLength(1);
  await review.getByRole("button", { name: "Edit", exact: true }).click();
  await review.getByRole("textbox", { name: "Edit comment", exact: true }).fill("Scout the natural and third base before moving out at 5:12.");
  await review.getByRole("button", { name: "Save", exact: true }).click();
  await expect(review.getByRole("textbox")).toHaveCount(0);
  await expect(review).toContainText("Scout the natural and third base");

  await page.getByRole("button", { name: "Use asker", exact: true }).click();
  await review.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(review.getByRole("button", { name: "Unmark helpful", exact: true })).toHaveAttribute("aria-pressed", "true");
  await review.getByRole("button", { name: "Best review", exact: true }).click();
  await expect(page.getByText("Answered", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Unmark best", exact: true })).toHaveAttribute("aria-pressed", "true");
  await review.getByRole("button", { name: /Upvote/, exact: false }).click();
  await expect(review.getByRole("button", { name: /Remove upvote/ })).toHaveAttribute("aria-pressed", "true");
  await review.getByRole("button", { name: "Reply", exact: true }).click();
  const replyForm = review.getByRole("form", { name: "Reply", exact: true });
  await replyForm.getByRole("textbox", { name: "Comment", exact: true }).fill("Thank you, I will scout both bases before the next attack.");
  await replyForm.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = page.getByRole("article", { name: "Comment by Anonymous Protoss", exact: true });
  await expect(reply).toContainText("Thank you, I will scout both bases");
  await reply.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete this comment?" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(reply).toHaveCount(0);
  expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/comments"))).toHaveLength(2);

  await page.getByText("Asker tools", { exact: true }).click();
  const sharing = page.getByRole("switch", { name: "Let reviewers download my replay file", exact: true });
  await sharing.click(); await expect(sharing).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Download replay", exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download replay", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("sc2tools-review-fixtureReview001.SC2Replay");
  expect(download.url()).toBe(fixture.downloadUrl);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream(); expect(stream).not.toBeNull();
  let downloaded = ""; if (stream) for await (const chunk of stream) downloaded += chunk.toString();
  expect(downloaded).toBe("SC2TOOLS_SYNTHETIC_REVIEW_FIXTURE_NO_GAME_DATA\n");
  expect(fixture.downloads).toHaveLength(1);
  expect(fixture.attachmentRequests).toHaveLength(1);
  expect(fixture.attachmentRequests[0]).toMatchObject({ method: "GET", status: 200, filename: "sc2tools-review-fixtureReview001.SC2Replay" });
  await expect(page).toHaveURL(/\/reviews\/fixtureReview001$/);
  expect(fixture.calls.filter(call => call.method === "GET" && call.path.endsWith("/replay"))).toHaveLength(1);
  await sharing.click(); await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Download replay", exact: true })).toHaveCount(0);
  await sharing.click(); await expect(sharing).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Download replay", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add a note at 0:00", exact: true }).click();
  await page.getByRole("button", { name: "Close request", exact: true }).click();
  await page.getByRole("dialog", { name: "Close this request?" }).getByRole("button", { name: "Close request", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved changes won't be submitted again");
  await expect(page.getByTestId("review-timeline-fallback")).toHaveCount(0);
  await expect(page.getByText("This request is closed, so its replay is no longer shared. The review thread is still available.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download replay", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/close"))).toHaveLength(1);
  await page.reload(); await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("review-timeline-fallback")).toHaveCount(0);
  await expect(review).toContainText("Scout the natural and third base");
  expect(fixture.state().request.status).toBe("closed");
  expect(fixture.state().request.replay).toMatchObject({ shared: false, available: false, optedIn: true });
  expect(errors).toEqual([]); expect(fixture.external).toEqual([]); expect(fixture.unexpected).toEqual([]);
  await assertNoOverflow(page);
  if (info.project.name === "mobile-360") await page.screenshot({ path: info.outputPath("review-lifecycle-closed-phone.png"), fullPage: true });
});

test("Review permission gates and private drafts follow the signed-in account", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await openReviewLifecycleFixture(page); await createRequest(page);
  await page.getByRole("button", { name: "Use signed-out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Use new-reviewer", exact: true }).click();
  await expect(page.getByText("Sync at least 20 games with the desktop app to review replays (you have 2).")).toBeVisible();
  await page.getByRole("button", { name: "Use reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Comment at 0:00", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Private unfinished advice from the reviewer account.");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sc2tools:review-draft:v2:reviewer:fixtureReview001:root"))).toContain("Private unfinished advice from the reviewer account.");
  await page.getByRole("button", { name: "Use asker", exact: true }).click();
  await page.getByRole("button", { name: "Add a note at 0:00", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("A separate private note from the asker account.");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sc2tools:review-draft:v2:asker:fixtureReview001:root"))).toContain("A separate private note from the asker account.");
  await page.getByRole("button", { name: "Use reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Comment at 0:00", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("Private unfinished advice from the reviewer account.");
  expect(fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/comments"))).toHaveLength(0);
  expect(errors).toEqual([]); expect(fixture.external).toEqual([]); expect(fixture.unexpected).toEqual([]);
  await assertNoOverflow(page);
});
