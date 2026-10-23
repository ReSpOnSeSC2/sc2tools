import { expect, test } from "@playwright/test";
import { openCommunityInteractiveFixture } from "./community-interactive-fixture.mjs";

test("creator goes from Mine to a filtered picker, retries publishing and consumes the entry URL", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openCommunityInteractiveFixture(page, request, { kind: "creator", initialPath: "/community?mine=1", failPublishOnce: true });
  const list = page.getByRole("list", { name: "My published builds", exact: true }); await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByText("Anonymous", { exact: true })).toBeVisible(); await expect(list.getByText("Removed by a moderator", { exact: true })).toBeVisible();
  await expect(list.getByText("12 games · 8–4 · 67%", { exact: true }).first()).toBeVisible();
  const disclosure = page.getByRole("button", { name: "How publishing works" }); await disclosure.click(); await expect(disclosure).toHaveAttribute("aria-expanded", "true"); await disclosure.click();
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.screenshot({ path: testInfo.outputPath("community-mine-375.png") }); }
  await page.getByRole("link", { name: "Publish a build", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pick a build to publish" })).toBeVisible();
  await expect(page).toHaveURL(/\/builds$/); const search = page.getByRole("searchbox", { name: "Filter by build name" }); await expect(search).toBeFocused();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile-360") await page.screenshot({ path: testInfo.outputPath("community-publish-picker-375.png") });
  await search.fill("Variant"); await expect(page.getByRole("list", { name: "Saved builds to publish" }).getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "Publish Variant pressure", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Publish to community", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /^Post anonymously/ }).check(); await page.getByRole("checkbox", { name: /^Public data acknowledged/ }).check();
  const publish = page.getByRole("button", { name: "Publish…", exact: true }); await publish.click();
  await expect(page.getByRole("alert")).toHaveText("Fixture publication unavailable"); await expect(page.getByRole("textbox", { name: "Public title" })).toHaveValue("Variant pressure");
  await publish.click(); await expect(page.getByText("Published successfully.", { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === "POST" && call.pathname === "/v1/community/builds")).toHaveLength(2);
  expect(calls.filter((call) => call.method === "POST").at(-1)?.body).toMatchObject({ slug: "private-build-beta", publishAnonymously: true });
  await page.getByRole("dialog").getByRole("contentinfo").getByRole("button", { name: "Close", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test("source links open an existing publication update without depending on the visible library page", async ({ page, request }, testInfo) => {
  const calls = await openCommunityInteractiveFixture(page, request, { kind: "creator", initialPath: "/builds?publish=private-build-alpha" });
  await expect(page.getByRole("heading", { name: "Update your Community listing" })).toBeVisible(); await expect(page).toHaveURL(/\/builds$/);
  await expect(page.getByRole("textbox", { name: "Public title" })).toHaveValue("Safe opening");
  await page.getByRole("checkbox", { name: /^Public data acknowledged/ }).check();
  const update = page.getByRole("button", { name: "Update listing", exact: true }); await expect(update).toBeEnabled();
  await update.scrollIntoViewIfNeeded(); const box = await update.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await page.screenshot({ path: testInfo.outputPath("community-publish-update-375.png") }); }
  await update.click(); await expect(page.getByText("Published successfully.", { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1); expect(calls.find((call) => call.method === "POST")?.body.slug).toBe("private-build-alpha");
});

test("an empty library launches creation and a failed library read offers retry", async ({ page, request }) => {
  await openCommunityInteractiveFixture(page, request, { kind: "creator", initialPath: "/builds?publish=1", emptyLibrary: true, failListOnce: true });
  await expect(page.getByRole("heading", { name: "Your build library is temporarily unavailable" })).toBeVisible(); await expect(page.getByText("You don't have any saved builds yet.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.getByText("You don't have any saved builds yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Learn how", exact: true })).toHaveAttribute("href", "/help/custom-builds");
  await page.getByRole("button", { name: "Create a build", exact: true }).click(); await expect(page.getByText("Editor requested", { exact: true })).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("signed-out Mine explains the private view and keeps the return destination", async ({ page, request }) => {
  const calls = await openCommunityInteractiveFixture(page, request, { kind: "creator", signedIn: false, initialPath: "/community?mine=1" });
  await expect(page.getByText("Sign in to see your published builds", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in?redirect_url=%2Fcommunity%3Fmine%3D1");
  await expect(page.getByRole("link", { name: "Sign in to publish", exact: true })).toHaveAttribute("href", "/sign-in?redirect_url=%2Fbuilds%3Fpublish%3D1");
  expect(calls.some((call) => call.pathname.startsWith("/v1/"))).toBe(false);
});
