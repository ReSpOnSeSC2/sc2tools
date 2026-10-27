import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TOURS, type TourId } from "../../lib/tours";
import { checkAccessibility } from "./accessibility-check";
import { closeGuidedToursFixtureServer, openGuidedToursFixture } from "./guided-tours-fixture.mjs";

type Host = typeof window & {
  toursSetReady: (ready: boolean) => void; toursSetOwner: (owner: string | null) => void;
  toursSetDialog: (open: boolean) => void; toursSetMissing: (ids: string[]) => void; toursNavigate: (href: string) => void;
  toursHoldNextToken: () => void; toursReleaseTokens: () => void;
  toursTokenEvents: () => { owner: string; held: boolean; released: boolean }[];
  toursHoldNextBody: (path: string) => void; toursReleaseBodies: () => void;
  toursBodyEvents: { path: string; released: boolean }[]; toursNativeAttempts: string[];
  toursSnapshot: (owner: string) => { toursDone?: Partial<Record<TourId, number>> } | null;
  toursScrolls: { target: string | null; options?: { behavior?: string } }[];
  toursUnmount: () => void;
};
type Evidence = Awaited<ReturnType<typeof openGuidedToursFixture>>;
let current: Evidence | null = null;
const preferencesPath = "/v1/me/preferences/onboarding";
const replayName = (id: TourId) => "Replay " + (id === "today" ? "Today" : id === "game" ? "game" : "Overlay") + " tour";
const tour = (page: Page) => page.locator('[role="dialog"][data-tour-dialog]');
async function drain(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function capture(page: Page, info: TestInfo, label: string) {
  if (!process.env.TOURS_SHOTS_DIR) return;
  const folder = path.resolve(process.env.TOURS_SHOTS_DIR); await mkdir(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, info.project.name + "-" + label + ".png"), fullPage: true });
}
async function placement(page: Page, phone: boolean) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await tour(page).boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  if (phone) expect(Math.abs(box!.y + box!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
  else expect(box!.width).toBeLessThanOrEqual(361);
}

test.afterEach(async ({ page }, info) => {
  const evidence = current; current = null;
  if (!evidence && !page.isClosed()) await page.evaluate(() => { const host = window as Host; host.toursUnmount?.(); host.toursReleaseTokens?.(); host.toursReleaseBodies?.(); }).catch(() => {});
  const closure = evidence ? await evidence.close() : await closeGuidedToursFixtureServer();
  const client = !page.isClosed() ? await page.evaluate(() => { const host = window as Host; return { native: host.toursNativeAttempts ?? [], tokens: host.toursTokenEvents?.() ?? [], bodies: host.toursBodyEvents ?? [], scrolls: host.toursScrolls ?? [] }; }) : null;
  await info.attach("guided-tours-transport-and-closure", { contentType: "application/json", body: JSON.stringify({ closure, client,
    errors: evidence?.errors ?? [], unexpectedRequests: evidence?.unexpectedRequests ?? [], rejectedWrites: evidence?.rejectedWrites ?? [], externalAttempts: evidence?.externalAttempts ?? [],
    reads: evidence?.reads ?? [], writes: evidence?.writes ?? [], abortedResponses: evidence?.abortedResponses ?? [], cssNames: evidence?.cssNames ?? [], buildId: evidence?.buildId ?? null,
    scope: "Real tour/controller/Help/Modal/check-in controls on synthetic target cards; not full consumer-page layout proof" }) });
  expect(closure.closed).toBe(true); expect(closure.listening).toBe(false); expect(closure.sockets).toBe(0); expect(client?.native ?? []).toEqual([]);
  if (evidence) { expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]); expect(evidence.rejectedWrites).toEqual([]); expect(evidence.externalAttempts).toEqual([]); }
});

for (const id of ["today", "game", "overlay"] as const) for (const theme of ["light", "dark"] as const) for (const width of [390, 1280]) {
  test("Guided " + id + " " + theme + " " + width + ": saved scope, suppression and replay", async ({ page }, info) => {
    test.setTimeout(180_000); await page.setViewportSize({ width, height: 900 });
    const phone = width < 640, evidence = current = await openGuidedToursFixture(page, theme, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("ToursHanken");
    expect(evidence.buildId).toBeTruthy(); expect(evidence.cssNames.length).toBeGreaterThan(0);
    expect(evidence.reads.filter((row: { path: string }) => row.path === preferencesPath)).toHaveLength(0);

    // Admission starts incomplete, then an actual open Modal keeps the tour from stealing focus.
    await page.evaluate(() => { const host = window as Host; host.toursSetDialog(true); host.toursSetReady(true); });
    const existing = page.getByRole("dialog", { name: "Existing dialog", exact: true });
    const input = existing.getByRole("textbox", { name: "Existing dialog input" }); await input.focus();
    await expect.poll(() => evidence.reads.some((row: { path: string }) => row.path === preferencesPath)).toBe(true);
    await drain(page); await expect(tour(page)).toHaveCount(0); await expect(input).toBeFocused(); expect(evidence.writes).toHaveLength(0);

    // Every real check-in content variant is visible and usable while tour startup remains blocked.
    for (const mode of ["full", "collapsed", "confirmed"] as const) {
      await page.evaluate(() => (window as Host).toursSetDialog(true));
      await evidence.showCheckIn(mode);
      const cardId = mode === "full" ? "build-checkin-card" : mode === "collapsed" ? "build-checkin-compact" : "build-checkin-summary";
      const card = page.getByTestId(cardId); await expect(card).toBeVisible();
      await existing.getByRole("button", { name: "Close existing dialog", exact: true }).click();
      const control = card.locator("button:not([disabled]),input:not([disabled])").first(); await control.focus();
      await drain(page); await expect(tour(page)).toHaveCount(0); await expect(control).toBeFocused(); expect(evidence.writes).toHaveLength(0);
      if (id === "game" && mode !== "full") {
        // Keep the real compact/confirmed card adjacent to the actual sticky nav.
        // Scrolling it out of view may admit the tour, but must not pull it back.
        await page.evaluate(() => (window as Host).toursSetReady(false));
        await page.evaluate(() => {
          const surface = document.querySelector<HTMLElement>('[data-tour-surface="game"]')!;
          surface.style.paddingBottom = "900px";
          const card = surface.querySelector<HTMLElement>('[data-tour-blocker="check-in"]')!;
          window.scrollTo({ top: scrollY + card.getBoundingClientRect().bottom + 64, behavior: "instant" });
        });
        await drain(page);
        expect(await card.evaluate(element => element.getBoundingClientRect().bottom <= 0)).toBe(true);
        const navigation = page.getByRole("navigation", { name: "Game sections", exact: true });
        expect(await navigation.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })).toBe(true);
        const readingY = await page.evaluate(() => scrollY);
        const reveals = await page.evaluate(() => (window as Host).toursScrolls.length);
        await page.evaluate(() => (window as Host).toursSetReady(true));
        await expect(tour(page).getByRole("heading")).toHaveText(TOURS.game.steps[0].title);
        expect(await page.evaluate(() => scrollY)).toBe(readingY);
        expect(await page.evaluate(() => (window as Host).toursScrolls.length)).toBe(reveals);
        for (let index = 1; index < TOURS.game.steps.length; index++) {
          await tour(page).getByRole("button", { name: "Next", exact: true }).click();
          await expect(tour(page).getByRole("heading")).toHaveText(TOURS.game.steps[index].title);
          expect(await card.evaluate(element => element.getBoundingClientRect().bottom <= 0)).toBe(true);
        }
        for (let index = TOURS.game.steps.length - 2; index >= 0; index--) {
          await tour(page).getByRole("button", { name: "Back", exact: true }).click();
          await expect(tour(page).getByRole("heading")).toHaveText(TOURS.game.steps[index].title);
          expect(await card.evaluate(element => element.getBoundingClientRect().bottom <= 0)).toBe(true);
        }
        expect(evidence.writes).toHaveLength(0);
        await page.evaluate(() => { const host = window as Host; host.toursSetReady(false); host.toursSetDialog(true); });
        await expect(tour(page)).toHaveCount(0);
        await page.evaluate(() => { document.querySelector<HTMLElement>('[data-tour-surface="game"]')!.style.paddingBottom = ""; });
        await existing.getByRole("button", { name: "Close existing dialog", exact: true }).click();
        await control.focus();
      }
    }
    await page.evaluate(() => { const host = window as Host; host.toursSetDialog(true); host.toursSetReady(false); });
    await evidence.showCheckIn(null); await existing.getByRole("button", { name: "Close existing dialog", exact: true }).click();
    const reading = page.getByRole("button", { name: "Reading focus", exact: true }); await reading.focus();
    await page.evaluate(() => (window as Host).toursSetReady(true));
    await expect(tour(page)).toBeVisible(); await expect(tour(page).getByRole("heading")).toHaveText(TOURS[id].steps[0].title);
    const skip = tour(page).getByRole("button", { name: "Skip tour", exact: true }); await expect(skip).toBeFocused();
    const next = tour(page).getByRole("button", { name: "Next", exact: true }); await next.focus(); await page.keyboard.press("Tab"); await expect(skip).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(next).toBeFocused();
    await placement(page, phone);
    expect(await page.evaluate(() => (window as Host).toursScrolls.filter(row => row.target).every(row => row.options?.behavior === "instant"))).toBe(true);
    await checkAccessibility(page, info, "/guided-tours-" + id + "-" + width + "-open", theme);
    await capture(page, info, id + "-" + theme + "-" + width + "-open");

    // A real failure cannot invent an ACK or hide the tour. Escape retries the explicit Skip choice.
    evidence.failNextSave(); await page.keyboard.press("Escape");
    await expect(tour(page).getByRole("alert")).toBeVisible(); await expect(tour(page)).toBeVisible();
    expect(await page.evaluate(tourId => (window as Host).toursSnapshot("owner-a")?.toursDone?.[tourId], id)).toBeUndefined();
    await checkAccessibility(page, info, "/guided-tours-" + id + "-" + width + "-save-error", theme);
    if (phone) await capture(page, info, id + "-" + theme + "-" + width + "-save-error");
    await page.keyboard.press("Escape"); await expect(tour(page)).toHaveCount(0); await expect(reading).toBeFocused();
    expect(await page.evaluate(tourId => (window as Host).toursSnapshot("owner-a")?.toursDone?.[tourId], id)).toBe(TOURS[id].version);

    await page.evaluate(() => (window as Host).toursNavigate("/help/take-a-tour"));
    await expect(page.getByRole("button", { name: replayName(id), exact: true })).toBeVisible();
    await checkAccessibility(page, info, "/guided-tours-" + id + "-" + width + "-help", theme);
    const beforeMissing = evidence.writes.length;
    await page.evaluate(ids => (window as Host).toursSetMissing(ids), TOURS[id].steps.slice(0, 3).map(step => step.target));
    await page.getByRole("button", { name: replayName(id), exact: true }).click();
    await expect(page.getByText("This tour is unavailable for the current layout.", { exact: false })).toBeVisible();
    await expect(tour(page)).toHaveCount(0); expect(evidence.writes).toHaveLength(beforeMissing);
    await expect(page.getByRole("button", { name: replayName(id), exact: true })).toHaveCount(0);

    // A retired record's false probe cannot poison full Help or the next record's replay.
    await page.evaluate(() => (window as Host).toursNavigate("/help/take-a-tour"));
    await expect(page.getByRole("button", { name: replayName(id), exact: true })).toBeVisible();
    await page.evaluate(() => (window as Host).toursSetMissing([])); if (id === "game") evidence.setLatestGame("game-one");
    await page.getByRole("button", { name: replayName(id), exact: true }).click(); await expect(tour(page)).toBeVisible();
    const resume = new URL(page.url()); resume.searchParams.set("tour", id); const resumeHref = resume.pathname + resume.search;
    if (phone) {
      await page.evaluate(value => (window as Host).toursHoldNextBody(value), preferencesPath); await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => (window as Host).toursBodyEvents.some(row => !row.released))).toBe(true);
    } else {
      await page.evaluate(() => (window as Host).toursHoldNextToken()); await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => (window as Host).toursTokenEvents().some(row => row.held && !row.released))).toBe(true);
    }
    const beforeRelease = evidence.writes.length;
    await page.evaluate(() => { const host = window as Host; host.toursSetReady(false); host.toursSetOwner("owner-b"); host.toursNavigate("/app/game/game-two"); }); await drain(page);
    await page.evaluate(href => { const host = window as Host; host.toursSetOwner("owner-a"); host.toursNavigate(href); host.toursSetReady(true); }, resumeHref);
    await expect(tour(page)).toBeVisible();
    await page.evaluate(() => { const host = window as Host; host.toursReleaseTokens(); host.toursReleaseBodies(); }); await drain(page);
    await expect(tour(page)).toBeVisible(); expect(evidence.writes).toHaveLength(beforeRelease);
    await tour(page).getByRole("button", { name: "Skip tour", exact: true }).click(); await expect(tour(page)).toHaveCount(0);
    expect(evidence.writes).toHaveLength(beforeRelease + 1);
    for (const row of evidence.writes) { expect(row.owner).toBe("owner-a"); expect(row.path).toBe(preferencesPath); expect(row.body).toEqual({ toursDone: { [id]: TOURS[id].version } }); }
  });
}
