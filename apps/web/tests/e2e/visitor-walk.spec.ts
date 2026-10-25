import { expect, test, type Page } from "@playwright/test";

/**
 * A signed-out visitor's walk through the pages the site links to.
 * None of them may bounce to /sign-in or sit on a loading skeleton
 * forever. The harness has no API and a dummy Clerk key (Clerk never
 * loads), which is the worst case for both: client pages that wait on
 * auth, and server pages that wait on the API.
 *
 * Viewport doesn't matter here, so it runs once (desktop project).
 */

/** No loading placeholder is left inside <main> once the page settles. */
async function expectNoEndlessSkeleton(page: Page): Promise<void> {
  const main = page.locator("main").first();
  await expect(main).toBeVisible();
  await expect(main.locator('.animate-pulse, [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

function expectNotSignIn(page: Page): void {
  expect(new URL(page.url()).pathname).not.toMatch(/^\/sign-(in|up)/);
}

test.describe("signed-out visitor walk", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1280", "the viewport doesn't matter here; run it once");
  });

  test("/ renders for a visitor", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBeLessThan(400);
    expectNotSignIn(page);
    await expectNoEndlessSkeleton(page);
  });

  test("/builds never redirects to sign-in or loads forever", async ({ page }) => {
    const response = await page.goto("/builds");
    expect(response?.status()).toBeLessThan(400);
    expectNotSignIn(page);
    await expectNoEndlessSkeleton(page);
    await expect(page.getByRole("heading", { name: "Your own build library" })).toBeVisible();
    // Auth return context is restricted to public pages; private library URLs
    // deliberately use the normal safe post-sign-in destination.
    await expect(page.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute("href", "/sign-up");
    await expect(page.getByRole("link", { name: "Browse community builds" })).toHaveAttribute("href", "/community");
  });

  test("/builds/<slug> never redirects to sign-in or loads forever", async ({ page }) => {
    const response = await page.goto("/builds/some-private-build");
    expect(response?.status()).toBeLessThan(400);
    expectNotSignIn(page);
    await expectNoEndlessSkeleton(page);
    const main = page.locator("main").first();
    await expect(main.getByRole("heading", { name: "Sign in to open this build" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in");
  });

  test("/community says the API is down instead of 'no builds yet'", async ({ page }) => {
    const response = await page.goto("/community");
    expect(response?.status()).toBeLessThan(400);
    expectNotSignIn(page);
    await expectNoEndlessSkeleton(page);
    await expect(page.getByRole("heading", { name: "Community builds are temporarily unavailable" })).toBeVisible();
    await expect(page.getByText("Be the first to publish a build to the community.")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  });

  test("a community build is unavailable during an outage, never a 404", async ({ page }) => {
    const response = await page.goto("/community/builds/build-0123456789abcdef0123456789abcdef");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "This build is temporarily unavailable" })).toBeVisible();
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  });

  test("a missing page is a real 404 with a way out that needs no account", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    expectNotSignIn(page);
    await expectNoEndlessSkeleton(page);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    await expect(main.getByRole("link", { name: "Community builds" })).toHaveAttribute("href", "/community");
    await expect(main.locator('a[href^="/app"]')).toHaveCount(0);
  });
});
