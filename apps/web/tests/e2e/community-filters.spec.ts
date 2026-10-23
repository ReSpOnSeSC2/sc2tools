import { expect, test } from "@playwright/test";

test("community filters retain context, show pending results and keep search in sync with history", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const response = await page.goto("/community?race=Z&vs=T&skill=diamond&sort=updated&q=fixture"); expect(response?.status()).toBe(200);
  const search = page.getByRole("searchbox", { name: "Search community builds" }); await expect(search).toBeEnabled();
  const reject = page.locator("[data-cookie-banner]").getByRole("button", { name: "Reject" }); if (await reject.isVisible()) await reject.click();
  const pagination = page.getByRole("navigation", { name: "Pagination" });
  await expect(pagination.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Next →", exact: true }).click();
  await expect(page).toHaveURL(/race=Z&vs=T&skill=diamond&sort=updated&q=fixture&offset=24$/, { timeout: 20_000 });
  await expect(pagination.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "Next →", exact: true })).toHaveCount(0);
  await expect(pagination.getByText("Next →", { exact: true })).toHaveAttribute("aria-disabled", "true");

  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let held = false;
  await page.route(/\/community\?.*_rsc=/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("race") === "P") { held = true; await gate; }
    await route.continue();
  });
  await page.getByRole("radiogroup", { name: "My race", exact: true }).getByRole("radio", { name: "Protoss", exact: true }).click();
  try {
    await expect.poll(() => held, { timeout: 20_000 }).toBe(true);
    await expect(page.getByRole("region", { name: "Community build results" })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status", { name: "Updating community builds" })).toBeVisible();
  } finally { release(); }
  await expect(page).toHaveURL(/race=P&vs=T&skill=diamond&sort=updated&q=fixture$/, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Community build results" })).not.toHaveAttribute("aria-busy", "true");
  await page.unroute(/\/community\?.*_rsc=/);
  await search.focus(); await search.press("End"); await search.pressSequentially(" macro", { delay: 20 });
  await expect(page).toHaveURL(/q=fixture\+macro$/, { timeout: 20_000 }); await expect(search).toBeFocused();
  for (const name of ["My race", "vs"]) {
    const radios = page.getByRole("radiogroup", { name, exact: true }).getByRole("radio"); const boxes = await Promise.all((await radios.all()).map((radio) => radio.boundingBox()));
    expect(Math.max(...boxes.map((box) => box!.y)) - Math.min(...boxes.map((box) => box!.y))).toBeLessThanOrEqual(1);
    if ((page.viewportSize()?.width ?? 0) < 640) expect(boxes.every((box) => box!.height >= 44)).toBe(true);
  }
  if (testInfo.project.name === "mobile-360") {
    await page.setViewportSize({ width: 375, height: 900 }); await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("community-filters-375.png") });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.getByRole("link", { name: "Clear all", exact: true }).click();
  await expect(page).toHaveURL(/\/community\?sort=updated$/, { timeout: 20_000 }); await expect(search).toHaveValue("");
  await page.goBack(); await expect(search).toHaveValue("fixture macro");
  await page.goForward(); await expect(search).toHaveValue("");
});

test("community stale page links explain the end without pretending the community is empty", async ({ page }) => {
  await page.goto("/community?race=Z&vs=T&skill=diamond&sort=updated&q=fixture&offset=999");
  const results = page.getByRole("region", { name: "Community build results" });
  await expect(results.getByText("No more results", { exact: true })).toBeVisible();
  await expect(results.getByText("This page is past the end of the list.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to page 1", exact: true })).toHaveAttribute("href", "/community?race=Z&vs=T&skill=diamond&sort=updated&q=fixture");
  await expect(page.getByText("Be the first to publish a build to the community.", { exact: true })).toHaveCount(0);
});
