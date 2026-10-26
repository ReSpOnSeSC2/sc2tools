import { expect, test } from "@playwright/test";
import { openDesignGalleryFixture } from "./design-gallery-fixture.mjs";

for (const theme of ["light", "dark"] as const) {
  test(`design gallery ${theme}: real controls, overlay focus and local states`, async ({ page }, info) => {
    const evidence = await openDesignGalleryFixture(page, theme);
    await expect(page.getByRole("heading", { name: "Controls", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByLabel("Invalid example", { exact: true })).toHaveAttribute("aria-invalid", "true");
    const toggle = page.getByRole("switch", { name: "Enable example", exact: true });
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Add example", exact: true }).click();
    await expect(page.getByText("1 local example added.", { exact: true })).toBeVisible();

    const opener = page.getByRole("button", { name: "Open right Sheet", exact: true });
    await opener.click();
    const sheet = page.getByRole("dialog", { name: "Right Sheet example", exact: true });
    await expect(sheet).toBeVisible(); await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    const box = (await sheet.boundingBox())!, viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    await sheet.getByLabel("Example dialog input").fill("Local keyboard example");
    await page.keyboard.press("Escape"); await expect(sheet).toBeHidden(); await expect(opener).toBeFocused();

    await page.getByRole("button", { name: "Copy example text", exact: true }).click();
    const manualCopy = page.getByRole("textbox", { name: "Copy this text", exact: true });
    await expect(manualCopy).toBeFocused(); await expect(manualCopy).toHaveValue("Design gallery: example text");
    await manualCopy.press("Escape"); await expect(manualCopy).toBeHidden();

    const query = page.getByLabel("Query example state", { exact: true });
    await query.selectOption("empty"); await expect(page.getByText("No example results", { exact: true })).toBeVisible();
    await query.selectOption("error"); await expect(page.getByRole("alert").filter({ hasText: "The server is busy" })).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Example replay · Ready preview", { exact: true })).toBeVisible();
    await page.getByLabel("Local draft example", { exact: true }).fill("Changed preview");
    await page.getByRole("button", { name: "Save example", exact: true }).click();
    await expect(page.getByText("Example saved locally in this preview.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`design-gallery-${theme}.png`), fullPage: true });
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
  });
}
