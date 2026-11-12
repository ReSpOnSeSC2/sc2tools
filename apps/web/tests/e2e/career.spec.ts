import { expect, test, type Page } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { assertNoReplayOverflow, dropLocalReplays, isLocalReplayRequest, localReplayRequestPaths, REAL_REPLAY } from "./local-replay-fixture";

const CAREER = "/career";
const REAL = { contents: REAL_REPLAY, name: "Private Fixture.SC2Replay", lastModified: Date.UTC(2032, 0, 1) };
const NOT_REPLAY = { contents: "eA==", name: "Unrelated.txt", lastModified: REAL.lastModified };

async function chooseReplayPlayer(page: Page) {
  await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeFocused({ timeout: 120_000 });
  await page.getByRole("button", { name: /response/i }).click();
  await expect(page.getByRole("heading", { name: "Your replay record" })).toBeFocused();
}

test.describe("local replay career", () => {
  test("signed-out intake and empty state fit both themes", async ({ page }, info) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(CAREER);
      await expect(page.getByRole("heading", { name: "Your StarCraft II career" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
      await assertNoReplayOverflow(page);
      await checkAccessibility(page, info, CAREER, theme);
      await captureAccessibility(page, info, `career-intake-${theme}`, true);
      await dropLocalReplays(page, [NOT_REPLAY]);
      await expect(page.getByRole("heading", { name: "No games to show" })).toBeFocused();
      await page.getByRole("button", { name: "Choose different files" }).click();
      await expect(page.getByRole("heading", { name: "Choose your replays" })).toBeFocused();
    }
  });

  test("retries a real replay locally and reuses its header across reload", { tag: "@slow" }, async ({ page }, info) => {
    test.setTimeout(180_000);
    const site = new URL(String(info.project.use.baseURL)).origin;
    const allowed = localReplayRequestPaths(CAREER);
    const outbound: string[] = [];
    let boots = 0;
    let finishFirstBoot: () => void = () => { throw new Error("Missing replay boot gate"); };
    const firstBoot = new Promise<void>((resolve) => { finishFirstBoot = resolve; });
    await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
    await page.addInitScript(() => localStorage.setItem("sc2tools.analyticsConsent.v1", "granted"));
    await page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!isLocalReplayRequest(request, site, allowed)) {
        outbound.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      if (url.pathname === "/engine/current.json" && ++boots === 1) {
        await firstBoot;
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(CAREER);
    const clearButton = page.getByRole("button", { name: "Clear saved replay summaries" });
    const initialClear = await clearButton.boundingBox();
    await dropLocalReplays(page, [REAL]);
    try {
      await expect(page.getByRole("progressbar", { name: "Replay headers read" })).toBeVisible();
      const loadingClear = await clearButton.boundingBox();
      if (!initialClear || !loadingClear) throw new Error("Storage action missing");
      expect(Math.abs(loadingClear.y - initialClear.y)).toBeLessThanOrEqual(2);
      await captureAccessibility(page, info, "career-loading", true);
    } finally {
      finishFirstBoot();
    }
    await expect(page.getByRole("heading", { name: "Couldn’t read the replays" })).toBeFocused({ timeout: 120_000 });
    await captureAccessibility(page, info, "career-error", true);
    await page.getByRole("button", { name: "Try again" }).click();
    await chooseReplayPlayer(page);
    expect(boots).toBe(2);
    await expect(page.getByText("First replay found")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your race journey" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gaps in the record" })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await assertNoReplayOverflow(page);
      await checkAccessibility(page, info, CAREER, theme);
      await captureAccessibility(page, info, `career-record-${theme}`, true);
    }

    await page.reload();
    const renamed = { ...REAL, name: "Renamed.SC2Replay" };
    await dropLocalReplays(page, [renamed]);
    await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Choose your replays" })).toBeFocused();
    await dropLocalReplays(page, [renamed]);
    await chooseReplayPlayer(page);
    await expect(page.getByText("Reused saved results for 1 file.")).toBeVisible();
    expect(boots).toBe(2);
    await page.getByRole("button", { name: "Clear saved replay summaries" }).click();
    await expect(page.getByText("Saved summaries cleared.")).toBeVisible();
    await dropLocalReplays(page, [REAL]);
    await chooseReplayPlayer(page);
    await expect(page.getByText(/reused saved results/i)).toHaveCount(0);
    expect(boots).toBe(3);
    expect(outbound).toEqual([]);
  });
});
