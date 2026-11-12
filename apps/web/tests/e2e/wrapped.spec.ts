import { expect, test } from "@playwright/test";
import { assertNoReplayOverflow, dropLocalReplays, localReplayRequestPaths, isLocalReplayRequest, REAL_REPLAY } from "./local-replay-fixture";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const ENABLED = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all";
const REPLAY = { contents: REAL_REPLAY, name: "Private Fixture.SC2Replay", lastModified: Date.UTC(2026, 4, 8) };


test.describe("/wrapped local year recap", () => {
  test.skip(!ENABLED, "Instant Analysis must be rolled out to everyone");

  test("signed-out intake fits the viewport with accessible controls", async ({ page }, info) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/wrapped");
      await expect(page.getByRole("heading", { name: "Your 2026 in StarCraft II" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
      await assertNoReplayOverflow(page);
      await checkAccessibility(page, info, "/wrapped", theme);
      await captureAccessibility(page, info, `wrapped-${theme}`, true);
    }
  });

  test("reads a real replay without sending files, results or analytics", { tag: "@slow" }, async ({ page }, info) => {
    test.setTimeout(150_000);
    const site = new URL(String(info.project.use.baseURL)).origin;
    const allowedPaths = localReplayRequestPaths("/wrapped");
    const outbound: string[] = [], engine: string[] = [];
    await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
    page.context().on("request", (request) => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (!isLocalReplayRequest(request, site, allowedPaths)) outbound.push(`${request.method()} ${url.href}`);
      if (url.origin === site && url.pathname === "/engine/current.json") engine.push(url.pathname);
    });
    await page.context().route("**/*", (route) => isLocalReplayRequest(route.request(), site, allowedPaths) ? route.continue() : route.abort());
    await page.goto("/wrapped");
    expect(engine).toEqual([]);
    await dropLocalReplays(page, [REPLAY]);
    await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: /response/i }).click();
    const open = page.getByRole("button", { name: "View recap" });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.getByRole("dialog", { name: "Year in review" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Time played", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Busiest month", { exact: true })).toBeVisible();
    await assertNoReplayOverflow(page);
    await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
    expect(engine).toHaveLength(1);
    expect(outbound).toEqual([]);
  });
});
