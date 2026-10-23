import { expect, test, type Page } from "@playwright/test";
import { openCoachingFormsFixture } from "./coaching-forms-fixture.mjs";

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("assignment validation, remembered zone and failed-save recovery work with the production form", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openCoachingFormsFixture(page, { failFirstSave: true });
  await page.getByRole("button", { name: "Assign games", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const footerBounds = await dialog.locator("footer").boundingBox();
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const build = dialog.getByRole("textbox", { name: "Exact detected style name" });
  const games = dialog.getByRole("spinbutton", { name: "Required games" });
  await expect(dialog.getByRole("combobox", { name: "Player's time zone" })).toHaveValue("Europe/Berlin");
  await expect(dialog.getByRole("button", { name: "Assign plan", exact: true })).toBeDisabled();
  await games.fill("0");
  await dialog.getByRole("button", { name: "Fix 2 fields to assign" }).click();
  await expect(build).toBeFocused(); await expect(build).toHaveAttribute("aria-invalid", "true");
  await expect(games).toHaveAttribute("aria-invalid", "true"); expect(calls).toHaveLength(0);
  await build.fill("Phoenix opener"); await games.fill("5");
  await expect(dialog.getByRole("status")).toContainText("Alex plays 5 eligible 1v1 games using Phoenix opener");
  await expect(dialog.getByRole("status")).toContainText("Europe/Berlin");
  await dialog.getByRole("button", { name: "Assign plan", exact: true }).click();
  await expect(page.getByText("Practice plan was not saved", { exact: true })).toBeVisible();
  await expect(build).toHaveValue("Phoenix opener"); await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await dialog.getByRole("combobox", { name: "Player's time zone" }).selectOption("Asia/Tokyo");
  await dialog.getByRole("status").scrollIntoViewIfNeeded();
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("coaching-assignment.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Assign plan", exact: true }).click();
  await expect(dialog).toBeHidden(); expect(calls).toHaveLength(2);
  expect(calls[1].path).toBe("/v1/coaching/students/alex/assignments");
  expect(calls[1].body).toMatchObject({ requiredGames: 5, timeZone: "Asia/Tokyo" });
  expect(await page.evaluate(() => localStorage.getItem("sc2tools:coaching:tz:alex"))).toBe("Asia/Tokyo");
  await page.getByRole("button", { name: "Assign games", exact: true }).first().click();
  await expect(page.getByRole("combobox", { name: "Player's time zone" })).toHaveValue("Asia/Tokyo");
  expect(errors).toEqual([]);
});

test("assignment remains usable when browser storage is blocked", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openCoachingFormsFixture(page, { blockedStorage: true });
  await page.getByRole("button", { name: "Assign games", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "Player's time zone" })).not.toHaveValue("");
  await dialog.getByRole("button", { name: /Total 1v1 games/ }).click();
  await expect(dialog.getByRole("status")).toContainText("each week");
  await dialog.getByRole("button", { name: "Assign plan", exact: true }).click();
  await expect(dialog).toBeHidden(); expect(calls).toHaveLength(1); expect(errors).toEqual([]);
});

test("availability errors block publishing and touching windows can be corrected without losing draft data", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const calls = await openCoachingFormsFixture(page, { schedule: true, failFirstSave: true });
  const start = page.getByLabel("Monday start time 1"); await start.fill("11:00");
  const publish = page.getByRole("button", { name: "Publish availability" });
  await expect(start).toBeFocused(); await expect(start).toHaveAttribute("aria-invalid", "true");
  await expect(publish).toBeDisabled(); await expect(page.getByText("Fix the highlighted hours to publish")).toBeVisible();
  await start.fill("09:00"); await page.getByRole("button", { name: "Add hours", exact: true }).click();
  await expect(publish).toBeDisabled(); await expect(page.getByLabel("Monday start time 2")).toHaveAttribute("aria-invalid", "true");
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("coaching-hours-errors.png"), fullPage: true });
  await page.getByLabel("Monday start time 2").fill("10:00"); await expect(publish).toBeEnabled();
  await publish.click(); await expect(page.getByText("Availability was not saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Monday start time 2")).toHaveValue("10:00");
  await publish.click(); await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  expect(calls).toHaveLength(2); expect(calls[1].body.expectedRev).toBe(7); expect(errors).toEqual([]);
});
