import AxeBuilder from "@axe-core/playwright";
import type { AnalyzerFilters } from "@/lib/filterContext";
import type { SessionHistoryList } from "@/lib/sessionHistory";
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkAccessibility } from "../e2e/accessibility-check";
import { openSessionsHistoryBrowserFixture as openFixture } from "./sessions-history-browser-fixture.mjs";
import { checkRaceLabelContrast } from "./sessions-race-contrast";

type Fixture = Awaited<ReturnType<typeof openFixture>>;
type Options = NonNullable<Parameters<typeof openFixture>[2]>;
type Theme = "light" | "dark";
type Signal = { count: number; inserted: number; bulk: boolean; reason: string };
type RealtimeWindow = typeof window & { historyRealtime: { snapshot: () => Array<{ index: number; owner: string | null; connected: boolean; disconnected: boolean }>; fire: (index: number, event: string, value: Signal) => void } };
type CurrentScopeWindow = typeof window & { historyCurrentFilters: AnalyzerFilters };
type AuthWindow = typeof window & { sessionsAuth: { arm: () => void; release: () => void; snapshot: () => { owner: string; held: { owner: string; token: string } | null } } };
const currentRequests = (fixture: Fixture) => fixture.state.requests.filter(row => row.path === "/v1/sessions/current");
const socketSnapshot = (page: Page) => page.evaluate(() => (window as RealtimeWindow).historyRealtime.snapshot());
const fireGames = (page: Page, index: number, value: Signal) => page.evaluate(args => (window as RealtimeWindow).historyRealtime.fire(args.index, "games:changed", args.value), { index, value });
const details = (page: Page) => page.getByRole("link", { name: /^View session details:/ });
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh session view", exact: true });
const curve = (page: Page) => page.getByTestId("recorded-mmr-curve");
const observed = (page: Page) => page.getByRole("region", { name: "Session recorded MMR", exact: true });

async function open(page: Page, theme: Theme, info: TestInfo, options: Options = {}) {
  try { return await openFixture(page, theme, options); }
  catch (error) {
    if (error && typeof error === "object" && "historySetupAndClosure" in error) await info.attach("history-setup-closure", { contentType: "application/json", body: JSON.stringify(error.historySetupAndClosure) });
    throw error;
  }
}
async function ready(page: Page) {
  await expect(details(page)).toHaveCount(1);
  await expect(page.getByText("Loading session view…", { exact: true })).toHaveCount(0);
}
async function keyActivate(page: Page, target: Locator) {
  await page.getByRole("button", { name: "Owner A", exact: true }).focus();
  for (let index = 0; index < 80 && !await target.evaluate(element => element === document.activeElement); index++) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  const metrics = await target.evaluate(element => { const box = element.getBoundingClientRect(), css = getComputedStyle(element); return { width: box.width, height: box.height, outline: css.outlineStyle, outlineWidth: css.outlineWidth, shadow: css.boxShadow }; });
  expect(metrics.width).toBeGreaterThanOrEqual(44); expect(metrics.height).toBeGreaterThanOrEqual(44);
  expect(metrics.outline !== "none" && metrics.outlineWidth !== "0px" || metrics.shadow !== "none").toBe(true);
  await page.keyboard.press("Enter");
}
async function identity(page: Page, fixture: Fixture, info: TestInfo, theme: Theme) {
  await info.attach("history-source-import-build-assets", { contentType: "application/json", body: JSON.stringify(fixture.identity) });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const fonts = await page.evaluate(() => ({ body: getComputedStyle(document.body).fontFamily,
    loaded: [...document.fonts].filter(face => face.status === "loaded").map(face => face.family), background: getComputedStyle(document.body).backgroundColor }));
  expect(fonts.body).toContain("HistoryHanken"); expect(fonts.loaded).toContain("HistoryHanken"); expect(fonts.loaded).toContain("HistoryBricolage");
  expect(fonts.background).toBe(theme === "light" ? "rgb(244, 246, 250)" : "rgb(6, 9, 14)");
}
async function aa(page: Page, info: TestInfo, theme: Theme, label: string) {
  if (process.env.A11Y_COLLECT_ONLY) throw new Error("History verification forbids collect-only accessibility mode");
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  await info.attach(`${label}-full-AA`, { contentType: "application/json", body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete, passes: result.passes.map(row => row.id) }) });
  await checkAccessibility(page, info, `/sessions-history-${label}`, theme);
  expect(result.violations, "Every AA impact remains a gate").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  if (label.includes("native200")) await nativeDevicePixelCapture(page, info, label);
  else await info.attach(`${label}-screen`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}
function networkUrl(value: string) {
  try { const url = new URL(value); url.hash = ""; return url.href; }
  catch { return value; }
}

async function close(fixture: Fixture | undefined, info: TestInfo) {
  if (!fixture) return;
  const receipt = await fixture.close();
  await info.attach("history-wire-and-closure", { contentType: "application/json", body: JSON.stringify(receipt) });
  expect(receipt.listening).toBe(false); expect(receipt.openSockets).toBe(0); expect(receipt.heldResponses).toBe(0); expect(receipt.heldBodies).toBe(0);
  expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]); expect(receipt.external).toEqual([]);
  const expectedErrors = receipt.requests.filter(row => row.status === 409 || row.status === 503);
  expect(receipt.console.filter(row => !(row.type === "error" && /Failed to load resource/.test(row.text)
    && expectedErrors.some(request => row.text.includes(`status of ${request.status} `)
      && networkUrl(row.location.url) === fixture.state.origin + request.path + request.query)))).toEqual([]);
  expect(receipt.failures.filter(row => !(row.closing && /ERR_ABORTED|ERR_FAILED/.test(row.error ?? ""))
    && !(row.method === "GET" && /ERR_ABORTED|ERR_FAILED/.test(row.error ?? "") && receipt.requests.some(request =>
      request.held && request.aborted && row.authSerial === request.authSerial && networkUrl(row.url) === fixture.state.origin + request.path + request.query)))).toEqual([]);
  expect(receipt.requests.every(row => row.method === "GET")).toBe(true);
  expect(receipt.realtime).toHaveLength(receipt.expectedRealtimeSockets);
  expect(receipt.realtime.every(row => row.disconnected && !row.connected)).toBe(true);
}

for (const theme of ["light", "dark"] as const) test.describe(theme, () => {
  test("H01 local output day preserves complete cross-midnight membership and Back", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info); await ready(page); await identity(page, fixture, info, theme);
      await expect(page.getByText("29 min", { exact: true })).toBeVisible(); await expect(page.getByText("35 min", { exact: true })).toBeVisible();
      await expect(page.getByText("2 timed of 3 games · 1 missing", { exact: true })).toBeVisible();
      await expect(page.getByText("0 / 100", { exact: true })).toBeVisible();
      await expect(page.getByRole("list", { name: "Latest 3 results, oldest to newest" }).getByRole("listitem")).toHaveCount(3);
      const day = page.getByLabel("Output day", { exact: true }), zone = page.getByRole("textbox", { name: "Session timezone" });
      await day.evaluate(element => element.setAttribute("data-fixture-identity", "retained-day"));
      await day.fill("2026-10-26"); await zone.fill("America/New_York"); await zone.press("Enter"); await ready(page);
      await expect(day).toHaveAttribute("data-fixture-identity", "retained-day"); await expect(zone).toBeFocused();
      await expect(page.locator('time[datetime="2026-10-27T04:15:00.000Z"]')).toHaveCount(1);
      const request = fixture.state.requests.at(-1)!;
      expect(new URLSearchParams(request.query).get("day")).toBe("2026-10-26");
      await aa(page, info, theme, "cross-midnight-day"); await keyActivate(page, details(page));
      await expect(page.getByRole("heading", { name: "Session report", exact: true })).toBeVisible(); await ready(page);
      const report = fixture.state.requests.at(-1)!, parameters = new URLSearchParams(report.query);
      expect(parameters.has("day")).toBe(false); expect(parameters.has("windowFrom")).toBe(false);
      expect(parameters.get("tz")).toBe("America/New_York");
      const back = page.getByRole("link", { name: "Back to session history", exact: true });
      const href = new URL((await back.getAttribute("href"))!, fixture.state.origin);
      expect(href.searchParams.get("day")).toBe("2026-10-26"); expect(href.searchParams.get("map_pool")).toBe("all");
      expect(href.searchParams.get("game_size")).toBe("all"); expect(href.searchParams.get("exclude_too_short")).toBe("false");
      await keyActivate(page, back); await ready(page); await expect(day).toHaveValue("2026-10-26");
    } finally { await close(fixture, info); }
  });

  test("H02 bounded results, ready-empty, busy Retry and warm stale409 remain distinct", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info, { initialMode: "context_required" }); await identity(page, fixture, info, theme);
      await expect(page.getByText("More session context is needed", { exact: true })).toBeVisible(); await expect(details(page)).toHaveCount(0);
      await expect(page.getByText("No sessions in this output window", { exact: true })).toHaveCount(0);
      await aa(page, info, theme, "context-required");
      await page.getByRole("link", { name: "Check with more context", exact: true }).click(); await ready(page);
      expect(new URLSearchParams(fixture.state.requests.at(-1)!.query).get("contextDays")).toBe("3");
      fixture.next("narrow_window"); await refresh(page).click();
      await expect(page.getByText("This session view is too large", { exact: true })).toBeVisible(); await expect(details(page)).toHaveCount(0);
      await aa(page, info, theme, "narrow-window");
      fixture.next("empty"); await page.getByRole("link", { name: "Restart this view", exact: true }).click();
      await expect(page.getByText("No sessions in this output window", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Previous output window", exact: true })).toBeVisible(); await aa(page, info, theme, "ready-empty");
      fixture.next("busy"); await refresh(page).click(); await expect(page.getByRole("button", { name: /Retry/ })).toBeVisible();
      await expect(page.getByText("No sessions in this output window", { exact: true })).toHaveCount(0); await aa(page, info, theme, "unavailable503");
      await page.getByRole("button", { name: /Retry/ }).click(); await ready(page);
      fixture.next("stale"); await refresh(page).click();
      await expect(page.getByText("This session view changed", { exact: true })).toBeVisible(); await expect(details(page)).toHaveCount(0);
      await aa(page, info, theme, "warm-data-stale409");
      const reads = fixture.state.requests.length; await page.getByRole("link", { name: "Open fresh session view", exact: true }).click(); await ready(page);
      expect(fixture.state.requests.length).toBe(reads + 1);
    } finally { await close(fixture, info); }
  });

  test("H03 held continuation data and controls retire across owners and membership", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info); await ready(page); await identity(page, fixture, info, theme);
      fixture.next("hold"); await page.getByRole("link", { name: "Older sessions in this window", exact: true }).click();
      await expect.poll(() => fixture!.state.held.length).toBe(1);
      await expect(page.getByText("Loading session view…", { exact: true })).toBeVisible(); await expect(details(page)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Older sessions in this window", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Owner B", exact: true }).click();
      await expect(page.getByText("This session view changed", { exact: true })).toBeVisible(); await expect(details(page)).toHaveCount(0);
      await page.getByRole("link", { name: "Open fresh session view", exact: true }).click(); await ready(page);
      await expect(page.getByRole("status", { name: "Fixture owner" })).toHaveText("synthetic-b");
      await expect(page.getByText("2-S2-1-202", { exact: true })).toBeVisible();
      fixture.release(); await expect.poll(() => fixture!.state.requests.every(row => row.complete)).toBe(true);
      await expect(page.getByText("1-S2-1-101", { exact: true })).toHaveCount(0); await aa(page, info, theme, "retired-owner-release");
      const count = fixture.state.requests.length;
      await page.getByRole("button", { name: "Change membership race", exact: true }).click(); await ready(page);
      await expect.poll(() => fixture!.state.requests.length).toBeGreaterThan(count);
      expect(new URLSearchParams(fixture.state.requests.at(-1)!.query).get("race")).toBe("Z");
      await page.getByRole("button", { name: "Owner A", exact: true }).click(); await ready(page);
      expect(fixture.state.requests.at(-1)!.owner).toBe("synthetic-a");
      await expect(page.getByText("1-S2-1-101", { exact: true })).toBeVisible();
    } finally { await close(fixture, info); }
  });

  test("H04 full MMR curve is independent of both point and game paging", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info, { long: true }); await ready(page); await identity(page, fixture, info, theme);
      await expect(page.getByRole("list", { name: "Latest 12 results, oldest to newest" }).getByRole("listitem")).toHaveCount(12);
      await keyActivate(page, details(page)); await page.getByRole("button", { name: "Load recorded MMR chart", exact: true }).click();
      await expect(curve(page)).toHaveCount(1); const fullPath = await curve(page).getAttribute("d");
      expect(fullPath!.match(/M/g)?.length).toBe(13); expect(fullPath).toContain("H764");
      await expect(observed(page).getByText("Recorded game positions 1–125", { exact: true })).toBeVisible();
      await observed(page).locator("summary", { hasText: "Recorded point table" }).click();
      const points = observed(page).getByRole("table"); await expect(points.locator("tbody tr")).toHaveCount(50);
      await page.getByRole("button", { name: "Next 50 observations", exact: true }).click();
      await expect(points.locator("tbody tr").first().locator("td").first()).toHaveText("51"); await expect(curve(page)).toHaveAttribute("d", fullPath!);
      const url = page.url(), slider = page.getByRole("slider", { name: "Inspect a recorded observation" });
      await slider.focus(); await page.keyboard.press("ArrowRight"); expect(page.url()).toBe(url);
      await aa(page, info, theme, "full-curve-point-page");
      await observed(page).locator("summary", { hasText: "Recorded point table" }).click();
      const next = page.getByRole("link", { name: "Next games in this session", exact: true }); await next.scrollIntoViewIfNeeded(); await next.focus();
      const y = await page.evaluate(() => scrollY); fixture.next("hold"); await page.keyboard.press("Enter");
      await expect.poll(() => fixture!.state.held.length).toBe(1); await expect(curve(page)).toHaveCount(0);
      fixture.release(); await expect(curve(page)).toHaveCount(1); await expect(curve(page)).toHaveAttribute("d", fullPath!);
      await expect(page.getByText(/Showing recorded positions 51–100 of 125 games/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Load recorded MMR chart", exact: true })).toHaveCount(0);
      await expect.poll(() => page.evaluate(before => Math.abs(scrollY - before), y)).toBeLessThanOrEqual(2);
      await expect(page.getByRole("region", { name: "Games in this session", exact: true })).toBeFocused(); await aa(page, info, theme, "chart-retained-game-page");
      expect(fixture.state.requests.filter(row => row.path.startsWith("/v1/games"))).toHaveLength(0);
    } finally { await close(fixture, info); }
  });

  test("H05 current scope ignores global history facets and recovers initial noncanonical stale", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info, { initialMode: "stale", initialHref: "/app?filters=1&preset=custom&race=Z&patch_era=before&since=2026-01-01T00%3A00%3A00.000Z&day=2026-10-26" });
      await identity(page, fixture, info, theme);
      await expect.poll(() => page.evaluate(() => (window as CurrentScopeWindow).historyCurrentFilters)).toMatchObject({ preset: "custom", race: "Z", patch_era: "before", since: "2026-01-01T00:00:00.000Z" });
      await expect(page.getByText("This session view changed", { exact: true })).toBeVisible();
      const reads = currentRequests(fixture).length;
      await page.getByRole("link", { name: "Open fresh session view", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Last session", exact: true })).toBeVisible(); expect(currentRequests(fixture)).toHaveLength(reads + 1);
      expect(currentRequests(fixture)).toHaveLength(2);
      for (const row of currentRequests(fixture)) expect([...new URLSearchParams(row.query).keys()]).toEqual(["tz"]);
      await expect(page.getByText(/Live 14-day view/)).toBeVisible(); await expect(page.getByText(/Since manual reset:/)).toBeVisible();
      await aa(page, info, theme, "current-fixed-scope");
      const report = page.getByRole("link", { name: "View this session", exact: true });
      expect(new URL((await report.getAttribute("href"))!, fixture.state.origin).searchParams.get("sessionView")).toBe("current");
      await keyActivate(page, report); await expect(page.getByRole("heading", { name: "Session report", exact: true })).toBeVisible(); await ready(page);
      const parameters = new URLSearchParams(fixture.state.requests.at(-1)!.query);
      expect([...parameters.keys()].every(key => ["tz", "contextDays", "gamesLimit", "gamesBefore"].includes(key))).toBe(true);
      await expect(page.getByRole("link", { name: "Back to Today", exact: true })).toHaveAttribute("href", "/app");
    } finally { await close(fixture, info); }
  });

  test("H06 unidentified queue retains raw observations without a connected curve", async ({ page }, info) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await open(page, theme, info, { raw: true }); await ready(page); await identity(page, fixture, info, theme);
      await expect(page.getByText("Queue race: Unknown", { exact: true })).toBeVisible();
      await expect(page.getByText("Unavailable: rating track not fully identified", { exact: true })).toBeVisible();
      await keyActivate(page, details(page)); await page.getByRole("button", { name: "Load recorded MMR chart", exact: true }).click();
      await expect(observed(page)).toBeVisible(); await expect(curve(page)).toHaveCount(0);
      await expect(observed(page).getByText(/Rating track not fully identified/)).toBeVisible();
      await expect(observed(page).getByRole("table").locator("tbody tr")).toHaveCount(3);
      await expect(observed(page).getByRole("table").locator("tbody tr").nth(1).locator("td").nth(2)).toHaveText("—");
      await aa(page, info, theme, "raw-unidentified-queue");
    } finally { await close(fixture, info); }
  });
});

for (const theme of ["light", "dark"] as const) test(`H08 real provider clock reaches current SWR/HTTP after ingest and zero-insert reset (${theme})`, async ({ page }, info) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await open(page, theme, info, { initialHref: "/app" }); await identity(page, fixture, info, theme);
    await expect(page.getByRole("heading", { name: "Last session", exact: true })).toBeVisible();
    await expect.poll(() => socketSnapshot(page)).toMatchObject([{ index: 0, owner: "synthetic-a", connected: true }]);
    const reads = currentRequests(fixture).length, started = Date.now(); fixture.current("ingested");
    await fireGames(page, 0, { count: 1, inserted: 1, bulk: false, reason: "ingest" });
    await expect.poll(() => currentRequests(fixture!).length).toBe(reads + 1);
    expect(currentRequests(fixture).at(-1)!.atMs - started).toBeGreaterThanOrEqual(1900);
    await expect(page.getByRole("heading", { name: "This session", exact: true })).toBeVisible();
    await expect(page.getByText("4 games", { exact: true })).toBeVisible(); expect(await socketSnapshot(page)).toHaveLength(1);
    fixture.current("reset"); await fireGames(page, 0, { count: 0, inserted: 0, bulk: false, reason: "session-reset" });
    await expect(page.getByText("No session in the current view", { exact: true })).toBeVisible();
    expect(currentRequests(fixture)).toHaveLength(reads + 2);
    await expect(page.getByRole("link", { name: "View this session", exact: true })).toHaveCount(0);
    await expect(page.locator('time[datetime="2026-10-27T06:00:00.000Z"]')).toHaveCount(2);
    await aa(page, info, theme, "current-live-empty-after-zero-reset");
    await page.getByRole("button", { name: "Owner B", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Last session", exact: true })).toBeVisible();
    await expect.poll(() => socketSnapshot(page)).toMatchObject([{ disconnected: true, connected: false }, { owner: "synthetic-b", connected: true }]);
    fixture.state.expectedRealtimeSockets = 2;
    const before = currentRequests(fixture).length, retiredAt = Date.now();
    await fireGames(page, 0, { count: 0, inserted: 0, bulk: false, reason: "session-reset" });
    await expect.poll(() => Date.now() - retiredAt).toBeGreaterThan(2100);
    expect(currentRequests(fixture)).toHaveLength(before); expect(currentRequests(fixture).at(-1)!.owner).toBe("synthetic-b");
    await expect(page.getByText("3 games", { exact: true })).toBeVisible();
  } finally { await close(fixture, info); }
});
for (const theme of ["light", "dark"] as const) test(`H09 pending JWT retires across A to B to A before HTTP (${theme})`, async ({ page }, info) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await open(page, theme, info); await ready(page); await identity(page, fixture, info, theme);
    await page.evaluate(() => (window as AuthWindow).sessionsAuth.arm()); await refresh(page).click();
    await expect.poll(() => page.evaluate(() => (window as AuthWindow).sessionsAuth.snapshot().held?.owner)).toBe("synthetic-a");
    const held = await page.evaluate(() => (window as AuthWindow).sessionsAuth.snapshot().held);
    const heldSerial = Number(held!.token.split("-").at(-1));
    expect(fixture.state.requests).toHaveLength(1);
    const bRead = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/sessions" && response.status() === 200);
    await page.getByRole("button", { name: "Owner B", exact: true }).click();
    const bBody = await (await bRead).json() as SessionHistoryList;
    expect(fixture.state.requests).toHaveLength(2);
    const bEntry = fixture.state.requests.at(-1)!;
    expect(bEntry).toMatchObject({ owner: "synthetic-b", complete: true, status: 200 });
    expect(bEntry.authSerial).not.toBe(heldSerial); expect(bBody.items[0].id).toContain("synthetic-b");
    await ready(page); await expect(page.getByText("2-S2-1-202", { exact: true })).toBeVisible();
    const aRead = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/sessions" && response.status() === 200);
    await page.getByRole("button", { name: "Owner A", exact: true }).click();
    const aBody = await (await aRead).json() as SessionHistoryList;
    expect(fixture.state.requests).toHaveLength(3);
    const aEntry = fixture.state.requests.at(-1)!;
    expect(aEntry).toMatchObject({ owner: "synthetic-a", complete: true, status: 200 });
    expect(aEntry.authSerial).not.toBe(heldSerial); expect(aEntry.authSerial).not.toBe(bEntry.authSerial);
    expect(aBody.items[0].id).toContain("synthetic-a");
    await ready(page); await expect(page.getByText("1-S2-1-101", { exact: true })).toBeVisible();
    const reads = fixture.state.requests.length; await page.evaluate(() => (window as AuthWindow).sessionsAuth.release());
    await expect.poll(() => page.evaluate(() => (window as AuthWindow).sessionsAuth.snapshot().held)).toBeNull();
    await aa(page, info, theme, "retired-JWT-ABA"); expect(fixture.state.requests).toHaveLength(reads);
    expect(fixture.state.requests.some(row => row.authSerial === heldSerial)).toBe(false);
    await expect(page.getByText("This session view changed", { exact: true })).toHaveCount(0); await ready(page);
    await info.attach("held-JWT-retirement", { contentType: "application/json", body: JSON.stringify({ heldSerial, freshOwner: "synthetic-a", requests: fixture.state.requests, claim: "Retired token did not initiate HTTP after ABA" }) });
  } finally { await close(fixture, info); }
});

for (const theme of ["light", "dark"] as const) test(`H10 partial JSON body retires across ABA and a fresh held body admits (${theme})`, async ({ page }, info) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await open(page, theme, info); await ready(page); await identity(page, fixture, info, theme);
    fixture.next("body"); const headers = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/sessions" && response.status() === 200);
    await refresh(page).click(); const oldResponse = await headers;
    const oldJson = oldResponse.json().then(() => ({ parsed: true }), error => ({ parsed: false, error: String(error) }));
    await expect.poll(() => fixture!.state.bodyHolds.length).toBe(1); const old = fixture.state.bodyHolds[0].entry;
    expect(old.headersSent).toBe(true); expect(old.prefixBytes).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Owner B", exact: true }).click(); await ready(page);
    await expect.poll(() => old.aborted).toBe(true); await expect(page.getByText("2-S2-1-202", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Owner A", exact: true }).click(); await ready(page);
    const reads = fixture.state.requests.length; fixture.releaseBodies();
    expect(await oldJson).toMatchObject({ parsed: false }); expect(old.releaseAttempted).toBe(true);
    expect(old.finalBytesQueued).toBe(0); await expect(details(page)).not.toHaveAttribute("href", /body-held/);
    expect(fixture.state.requests).toHaveLength(reads);
    fixture.next("body"); const freshHeaders = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/sessions" && response.status() === 200);
    await refresh(page).click(); const freshResponse = await freshHeaders;
    await expect.poll(() => fixture!.state.bodyHolds.length).toBe(1); const fresh = fixture.state.bodyHolds[0].entry;
    fixture.releaseBodies(); const body = await freshResponse.json();
    expect(body.items[0].id).toContain("body-held"); await expect(details(page)).toHaveAttribute("href", /body-held/);
    expect(fresh.serverEndQueued).toBe(true); expect(fresh.finalBytesQueued).toBeGreaterThan(0);
    await aa(page, info, theme, "fresh-body-admitted-after-ABA");
    await info.attach("partial-body-retirement-and-admission", { contentType: "application/json", body: JSON.stringify({ old, fresh, oldClientJsonParsed: false, freshClientJsonParsed: true, claim: "Old headers were received and a prefix was queued; the client body read aborted before complete JSON. Only the fresh owner response completed JSON and appeared in actual UI. Server queued bytes alone do not prove a post-body hook guard." }) });
  } finally { await close(fixture, info); }
});
for (const theme of ["light", "dark"] as const) test(`H11 race labels retain AA contrast and unknown identity (${theme})`, async ({ page }, info) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await open(page, theme, info, { initialHref: "/app/sessions?raceContrast=1" });
    await expect(page.getByRole("heading", { name: "Recorded race labels", exact: true })).toBeVisible();
    await identity(page, fixture, info, theme);
    await checkRaceLabelContrast(page, info);
    await aa(page, info, theme, "race-label-palette");
  } finally { await close(fixture, info); }
});

async function nativeDevicePixelCapture(page: Page, info: TestInfo, label: string) {
  const session = await page.context().newCDPSession(page);
  try {
    const layout = await session.send("Page.getLayoutMetrics");
    const device = layout.contentSize, css = layout.cssContentSize;
    const zoom = await page.evaluate(() => ({ dpr: devicePixelRatio, innerWidth, outerWidth,
      visualScale: visualViewport?.scale, rootZoom: getComputedStyle(document.documentElement).zoom }));
    await info.attach(`${label}-capture-layout`, { contentType: "application/json", body: JSON.stringify({
      purpose: "Native200 screenshot clip in legacy device pixels; no emulation or zoom change", layout, zoom }) });
    expect(zoom).toMatchObject({ dpr: 2, innerWidth: 632, outerWidth: 1280, visualScale: 1, rootZoom: "1" });
    expect(device.width / css.width).toBeCloseTo(2, 2);
    expect(device.height / css.height).toBeCloseTo(2, 2);
    const capture = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true,
      captureBeyondViewport: true, clip: { x: device.x, y: device.y, width: device.width, height: device.height, scale: 1 } });
    const png = Buffer.from(capture.data, "base64");
    // Attach the raw pixels and exact dimensions even if the capability check fails.
    await info.attach(`${label}-screen`, { body: png, contentType: "image/png" });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    await info.attach(`${label}-capture-pixels`, { contentType: "application/json", body: JSON.stringify({
      pixels, clip: { ...device, scale: 1 }, css, zoom, requiresVisualReview: true }) });
    expect(Math.abs(pixels.width - device.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(pixels.height - device.height)).toBeLessThanOrEqual(1);
  } finally { await session.detach(); }
}

type NativeZoomMetrics = { outerWidth: number; outerHeight: number; innerWidth: number; devicePixelRatio: number; visualViewportScale: number | null; rootZoom: string };
type NativeZoomProbe = { status: string; supported: boolean; clean: boolean; listenerClosed: boolean; openSockets: number;
  pins: Array<{ file: string; sha256: string }>; profiles: Array<{ label: string; metrics: NativeZoomMetrics }> };
async function nativeHistoryProfile(info: TestInfo) {
  const probePath = process.env.SESSIONS_HISTORY_NATIVE_ZOOM_PROBE;
  const probeSha256 = process.env.SESSIONS_HISTORY_NATIVE_ZOOM_PROBE_SHA256;
  if (!probePath || !path.isAbsolute(probePath) || !probeSha256 || !/^[a-f0-9]{64}$/.test(probeSha256)) throw new Error("Supply the root-reviewed native zoom probe path and SHA256");
  const probeBytes = await readFile(probePath);
  expect(createHash("sha256").update(probeBytes).digest("hex")).toBe(probeSha256);
  const probe = JSON.parse(probeBytes.toString("utf8")) as NativeZoomProbe;
  await info.attach("desktop1280-native200-supported-probe", { contentType: "application/json", body: probeBytes });
  expect(probe).toMatchObject({ status: "NATIVE_ZOOM_SUPPORTED", supported: true, clean: true, listenerClosed: true, openSockets: 0 });
  const binary = probe.pins.find(row => row.file.endsWith("/chrome.exe"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!binary || !executablePath || path.resolve(executablePath).toLowerCase() !== path.resolve(binary.file).toLowerCase()) throw new Error("Native phase requires the positively probed full Chrome binary");
  expect(createHash("sha256").update(await readFile(executablePath)).digest("hex")).toBe(binary.sha256);
  // Test output only: every case creates a new profile; an existing directory fails.
  await mkdir(info.outputDir, { recursive: true });
  const profileDir = info.outputPath("history-desktop1280-native200-new-profile");
  await mkdir(profileDir); await mkdir(path.join(profileDir, "Default"));
  await writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }) + "\n", { flag: "wx" });
  return { profileDir, executablePath, probe };
}


for (const theme of ["light", "dark"] as const) test(`H07 @native200 real browser zoom preserves history and recorded curve (${theme})`, async ({}, info) => {
  let fixture: Fixture | undefined, context: BrowserContext | undefined, closed = false;
  try {
    const native = await nativeHistoryProfile(info);
    context = await chromium.launchPersistentContext(native.profileDir, { executablePath: native.executablePath,
      headless: true, viewport: null, serviceWorkers: "block", timeout: 20_000, timezoneId: "America/New_York",
      args: ["--window-size=1280,900", "--proxy-server=direct://", "--proxy-bypass-list=*"] });
    context.once("close", () => { closed = true; }); expect(context.pages()).toHaveLength(1);
    const page = context.pages()[0]; fixture = await open(page, theme, info); await ready(page); await identity(page, fixture, info, theme);
    const metrics: NativeZoomMetrics = await page.evaluate(() => ({ outerWidth, outerHeight, innerWidth, devicePixelRatio,
      visualViewportScale: visualViewport?.scale ?? null, rootZoom: getComputedStyle(document.documentElement).zoom }));
    const expected = native.probe.profiles.find(row => row.label === "200")?.metrics;
    await info.attach("history-native200-metrics", { contentType: "application/json", body: JSON.stringify({ metrics, expected, freshProfile: native.profileDir }) });
    expect(metrics).toMatchObject({ outerWidth: 1280, outerHeight: 900, innerWidth: 632, devicePixelRatio: 2, visualViewportScale: 1, rootZoom: "1" });
    expect(expected).toBeDefined();
    expect(metrics).toEqual({ outerWidth: expected!.outerWidth, outerHeight: expected!.outerHeight,
      innerWidth: expected!.innerWidth, devicePixelRatio: expected!.devicePixelRatio,
      visualViewportScale: expected!.visualViewportScale, rootZoom: expected!.rootZoom });
    await aa(page, info, theme, "list-native200");
    await keyActivate(page, details(page)); await page.getByRole("button", { name: "Load recorded MMR chart", exact: true }).click();
    await expect(curve(page)).toHaveCount(1);
    const metadata = observed(page).getByText("Recorded game positions 1–3", { exact: true });
    expect(await metadata.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    await aa(page, info, theme, "report-curve-native200");
  } finally {
    try { await close(fixture, info); }
    finally {
      if (context) {
        const browser = context.browser();
        try { await context.close(); }
        finally {
          const browserConnected = browser ? browser.isConnected() : null;
          await info.attach("history-native200-context-closure", { contentType: "application/json", body: JSON.stringify({ closed, browserConnected }) });
          expect(closed).toBe(true); expect(browserConnected).toBe(false);
        }
      }
    }
  }
});
