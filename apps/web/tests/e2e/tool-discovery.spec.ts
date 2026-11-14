import { expect, test } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";

test("reaches the released tools from the site navigation and homepage", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  const homeTools = page.getByRole("navigation", { name: "More SC2 Tools" });
  await expect(homeTools.getByRole("link", { name: "Explore all tools" })).toHaveAttribute("href", "/tools");

  const mobile = page.viewportSize()!.width < 1024;
  if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
  const source = mobile ? page.getByRole("dialog", { name: "Site navigation" }) : page.getByRole("banner");
  await source.getByRole("link", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Explore SC2 Tools" })).toBeVisible();
  if (mobile) await expect(page.getByRole("dialog", { name: "Site navigation" })).toHaveCount(0);

  for (const [name, path] of [
    ["Daily Scout", "/arcade/scout"], ["Match Rooms", "/match"], ["Ladder Balance", "/balance"],
    ["Claim Builder", "/balance/claim"], ["Whine Permit", "/permit"], ["Download the Windows Agent", "/download"],
  ]) {
    const link = page.getByRole("main").getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", path);
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const court = page.getByRole("link", { name: "Replay verdict", exact: true });
  const career = page.getByRole("link", { name: "Replay Career", exact: true });
  if (process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all") {
    await expect(court).toHaveAttribute("href", "/try#balance-court");
    await expect(career).toHaveAttribute("href", "/career");
  } else {
    await expect(court).toHaveCount(0);
    await expect(career).toHaveCount(0);
  }

  await checkAccessibility(page, info, "/tools", "light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.getByRole("main").getByRole("link", { name: "Ladder Balance", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ladder Balance" })).toBeVisible();
  await page.getByRole("link", { name: "Explore all tools", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Explore SC2 Tools" })).toBeVisible();
});
