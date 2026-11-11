import { expect, test, type Page } from "@playwright/test";
import { encodeReportCard } from "../../lib/instant/reportCardLink";
import { REPORT_CARD_PATH } from "../../lib/instant/reportCardRoute";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const fragment = encodeReportCard({
  totals: { games: 10, wins: 7, losses: 2 },
  matchups: [{ label: "vs P", wins: 3, losses: 1 }, { label: "vs Z", wins: 4, losses: 1 }],
  opener: { name: "TvT - Proxy Marauder", games: 4, wins: 3, losses: 1 },
  macro: { score: 72, games: 9 },
});

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

test("shows a noindex, self-reported card with accessible text", async ({ page }, info) => {
  if (!fragment) throw new Error("Invalid report card fixture");
  const requests: string[] = [];
  const site = new URL(String(info.project.use.baseURL)).origin;
  await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
  page.on("request", request => { requests.push(request.url()); });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const response = await page.goto(`${REPORT_CARD_PATH}#${fragment}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByText(/numbers are self-reported/)).toBeVisible();
    await expect(page.getByText(/10 games, 7-2/)).toBeVisible();
    const preview = page.getByRole("region", { name: "Shared replay report" });
    await expect(preview.locator("canvas")).toBeVisible();
    await expect.poll(() => preview.locator("canvas").evaluate((element: HTMLCanvasElement) =>
      element.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] ?? 0)).toBeGreaterThan(0);
    const action = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all" ? { name: "Make yours", href: "/try" } : { name: "Explore SC2 Tools", href: "/" };
    const makeYours = page.getByRole("link", { name: action.name });
    await expect(makeYours).toHaveAttribute("href", action.href);
    expect((await makeYours.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await assertNoOverflow(page);
    await checkAccessibility(page, info, REPORT_CARD_PATH, theme);
    await captureAccessibility(page, info, `report-card-${theme}`, true);
  }
  expect(requests.some(url => url.includes(fragment))).toBe(false);
  expect(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== site)).toEqual([]);
});

test("renders neutral missing, forged and oversized states", async ({ page }, info) => {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(REPORT_CARD_PATH);
    await expect(page.getByText("No report card in this link")).toBeVisible();
    await captureAccessibility(page, info, `report-card-empty-${theme}`, true);
    for (const forged of ["<Private Name>", "AQEBAAICAQ", "X".repeat(400)]) {
      await page.evaluate(value => { window.location.hash = value; }, forged);
      await expect(page.getByText("This report card link is invalid")).toBeVisible();
      await expect(page.getByText(forged)).toHaveCount(0);
      await expect(page.locator("canvas")).toHaveCount(0);
      await assertNoOverflow(page);
    }
    await captureAccessibility(page, info, `report-card-invalid-${theme}`, true);
  }
  expect((await page.goto("/card/report/not-a-class"))?.status()).toBe(404);
});
