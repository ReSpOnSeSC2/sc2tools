import { expect, test } from "@playwright/test";
import { openCommunityInteractiveFixture } from "./community-interactive-fixture.mjs";

test("actual Community components save, synchronize votes and retain owner/report keyboard flows", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openCommunityInteractiveFixture(page, request);
  expect(errors).toEqual([]);
  const actions = page.getByRole("region", { name: "Build actions" });
  // The desktop test widens later, after checking the same responsive action row.
  await page.setViewportSize({ width: testInfo.project.name === "desktop-1280" ? 1023 : page.viewportSize()!.width, height: 900 });
  const save = actions.getByRole("button", { name: "Save to my library", exact: true }); await expect(save).toBeEnabled();
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await actions.getByRole("button", { name: "Upvote", exact: true }).click();
  await expect(page.getByLabel("Net score +4")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Desktop vote fixture" }).getByRole("button", { name: "Upvote", exact: true })).toHaveAttribute("aria-pressed", "true");
  await save.click(); await expect(actions.getByRole("link", { name: "In your library — Open" })).toBeVisible();
  expect(calls.filter((call: { method: string }) => call.method === "PUT")).toHaveLength(1);
  const author = page.getByRole("link", { name: /^A{80}$/ }); expect(await author.getAttribute("title")).toBe("A".repeat(80));
  expect((await author.boundingBox())!.width).toBeLessThan((await author.locator("../..").boundingBox())!.width * 0.51);
  const owner = page.getByRole("button", { name: "Your build options", exact: true }).last();
  await owner.focus(); await page.keyboard.press("Space");
  await expect(page.getByRole("menuitem", { name: "Edit in library", exact: true })).toBeFocused();
  await page.keyboard.press("End"); await expect(page.getByRole("menuitem", { name: "Remove from Community…" })).toBeFocused();
  const menu = await page.getByRole("menu").boundingBox(); expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x + menu!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape"); await expect(owner).toBeFocused();
  await page.keyboard.press("Enter"); await page.getByRole("menuitem", { name: "Remove from Community…" }).click();
  await expect(page.getByRole("heading", { name: "Remove “Fixture safe opening” from Community?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click(); await expect(page.getByRole("checkbox")).toBeFocused();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Remove from Community", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Go back", exact: true }).click(); await page.getByRole("button", { name: "Keep published", exact: true }).click(); await expect(owner).toBeFocused();
  expect(calls.some((call: { method: string }) => call.method === "DELETE")).toBe(false);
  await page.getByRole("button", { name: "Report", exact: true }).click(); await page.getByRole("radio", { name: "Copied without credit", exact: true }).check();
  await page.getByRole("button", { name: "Submit report", exact: true }).click(); await expect(page.getByText("Thanks — a moderator will review this build.", { exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (testInfo.project.name === "desktop-1280") { await page.setViewportSize({ width: 1280, height: 900 }); await expect(actions).toBeHidden(); await expect(page.getByRole("region", { name: "Desktop vote fixture" })).toBeVisible(); }
  if (testInfo.project.name === "mobile-360") { await page.setViewportSize({ width: 375, height: 900 }); await actions.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("community-interactive-375.png") }); }
});
