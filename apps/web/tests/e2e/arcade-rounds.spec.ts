import { expect, test, type Locator, type Page } from "@playwright/test";
import { openArcadeRoundsFixture } from "./arcade-rounds-fixture.mjs";
import { checkAccessibility } from "./accessibility-check";

const round = (page: Page) => page.getByRole("region", { name: "Fixture Arcade round", exact: true });
const answers = (page: Page) => round(page).locator("button[aria-pressed]");
const backgrounds = (buttons: Locator) => buttons.evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));

function onlyExplicitMatrix(project: string) {
  test.skip(["tablet-768", "desktop-1280"].includes(project), "The Arcade fixture checks its own touch-phone and mouse-desktop matrix once.");
}

async function freshRound(page: Page, expectedBackgrounds: string[]) {
  await expect(answers(page)).toHaveCount(4);
  for (const answer of await answers(page).all()) {
    await expect(answer).toHaveAttribute("aria-pressed", "false");
    await expect(answer).toBeEnabled();
  }
  await expect(round(page).locator('[data-revealed="true"]')).toHaveCount(0);
  await expect(round(page).getByRole("button", { name: "Next round →", exact: true })).toHaveCount(0);
  await expect.poll(() => backgrounds(answers(page))).toEqual(expectedBackgrounds);
}

for (const theme of ["light", "dark"] as const) for (const mode of ["streak", "closers"] as const) {
  test(`Arcade ${mode} ${theme}: touch and mouse rounds reset answer tones and selection`, async ({ browser }, info) => {
    onlyExplicitMatrix(info.project.name);
    test.setTimeout(90_000);
    for (const touch of [true, false]) {
      const width = touch ? 390 : 1440;
      const context = await browser.newContext({ viewport: { width, height: 950 }, hasTouch: touch, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage(), evidence = await openArcadeRoundsFixture(page, mode, { theme });
        await expect(answers(page)).toHaveCount(4);
        await page.mouse.move(0, 0);
        const neutral = await backgrounds(answers(page));
        await freshRound(page, neutral);
        const third = answers(page).nth(2);
        if (touch) await third.tap(); else await third.click();
        await expect(third).toHaveAttribute("aria-pressed", "true");
        await expect(third).toBeDisabled();
        await expect(page.getByLabel("Recorded attempts", { exact: true })).toHaveText("1");
        await expect(round(page).locator('[data-revealed="true"]')).toHaveCount(1);
        await expect.poll(() => third.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(neutral[2]);
        await page.screenshot({ path: info.outputPath(`arcade-${mode}-${theme}-${touch ? "touch" : "mouse"}-answered.png`), fullPage: true, animations: "disabled" });

        const next = round(page).getByRole("button", { name: "Next round →", exact: true });
        if (touch) await next.tap(); else await next.click();
        await page.mouse.move(0, 0);
        await freshRound(page, neutral);
        await expect(page.getByLabel("Recorded attempts", { exact: true })).toHaveText("1");
        await page.screenshot({ path: info.outputPath(`arcade-${mode}-${theme}-${touch ? "touch" : "mouse"}-fresh.png`), fullPage: true, animations: "disabled" });

        // A new answer remains available; keyboard focus still reaches the
        // shared answer control and the shell's 1–4 shortcut records once.
        const second = answers(page).nth(1);
        await second.focus(); await expect(second).toBeFocused();
        await second.press("2");
        await expect(second).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByLabel("Recorded attempts", { exact: true })).toHaveText("2");
        await expect(round(page).locator('[data-revealed="true"]')).toHaveCount(1);
        await second.press("2");
        await expect(page.getByLabel("Recorded attempts", { exact: true })).toHaveText("2");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await checkAccessibility(page, info, `/fixture/arcade-rounds/${mode}/${touch ? "touch" : "mouse"}`, theme);
        expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
      } finally { await context.close(); }
    }
  });
}
