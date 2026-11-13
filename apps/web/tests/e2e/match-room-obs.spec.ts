import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import type { Room } from "../../lib/matchRoom";

const ROOM_ID = "abcdefghijklmnopqrstuvwx12345678";
const HOST_KEY = "h".repeat(32);
const ORIGIN = "http://127.0.0.1:3210";
const PATH = "/overlay/match-room";
const HASH = "#r=" + ROOM_ID;
const PRIVATE_PLAYER = "Private Player Fixture";
const PRIVATE_MAP = "Private Custom Map";
const HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

function vetoRoom(): Room {
  return {
    config: { format: 1, preset: "standard", maps: ["Alcyone LE", PRIVATE_MAP, "Dynasty LE"], practice: false },
    rev: 1, expiresAt: Date.now() + 14 * 86_400_000, serverTime: Date.now(), phase: "veto",
    names: { a: PRIVATE_PLAYER, b: "Secret Fixture Rival" }, ready: { a: true, b: true }, score: { a: 0, b: 0 },
    first: "a", turn: { seat: "b", kind: "ban" }, deadline: Date.now() + 30_000,
    moves: [{ seat: "a", kind: "ban", map: 1, automatic: true }], order: [], winners: [],
  };
}

async function installFixture(context: BrowserContext, firstRead?: Promise<void>) {
  const fixture = { room: vetoRoom(), status: 200, requests: [] as string[], outbound: [] as string[] };
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) return route.continue();
    if (!["http://localhost:8080", "http://127.0.0.1:8080"].includes(url.origin)) {
      fixture.outbound.push(url.host);
      return route.abort();
    }
    fixture.requests.push(route.request().method() + " " + url.pathname + url.search);
    if (url.pathname !== "/v1/match-rooms/" + ROOM_ID || route.request().method() !== "GET") {
      return route.fulfill({ status: 405, headers: HEADERS });
    }
    await firstRead;
    if (fixture.status === 404) {
      return route.fulfill({ status: 404, headers: HEADERS, json: { error: { code: "match_room_missing" } } });
    }
    if (fixture.status === 503) return route.fulfill({ status: 503, headers: HEADERS });
    if (url.searchParams.get("rev") === String(fixture.room.rev)) return route.fulfill({ status: 204, headers: HEADERS });
    return route.fulfill({ headers: HEADERS, json: { ...fixture.room, serverTime: Date.now(),
      receipt: "fixture receipt", toonDigests: { a: "private fingerprint" } } });
  });
  return fixture;
}

async function broadcastFrame(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function noPrivateContent(page: Page) {
  await expect(page.locator("main")).not.toContainText(
    new RegExp(PRIVATE_PLAYER + "|" + PRIVATE_MAP + "|Secret Fixture Rival|fixture receipt|private fingerprint"),
  );
}

for (const theme of ["light", "dark"] as const) {
  test("renders a neutral, detached source with " + theme + " preferences", async ({ page, context }, info) => {
    let releaseFirstRead: () => void = () => {};
    const firstRead = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    const fixture = await installFixture(context, firstRead);
    await page.addInitScript(() => localStorage.setItem("sc2tools.analyticsConsent.v1", "granted"));
    await page.addInitScript(mode => localStorage.setItem("sc2tools.theme", mode), theme);
    const serviceWorkerRequests: string[] = [];
    page.on("request", req => { if (new URL(req.url()).pathname === "/sw.js") serviceWorkerRequests.push(req.url()); });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const response = await page.goto(PATH + HASH);
    try {
      await expect(page.locator('[role="status"][aria-busy="true"]')).toContainText("Connecting to the match room");
      await captureAccessibility(page, info, "obs-loading-" + theme);
    } finally {
      releaseFirstRead();
    }
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response?.headers()["cache-control"]).toContain("no-store");
    await expect(page.getByRole("heading", { name: "Map veto" })).toBeVisible();
    await expect(page.getByText("Alcyone LE")).toBeVisible();
    await expect(page.getByText("Map 2")).toBeVisible();
    await expect(page.getByText("Banned by Seat A")).toBeVisible();
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.getByTestId("overlay-credit")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "sc2tools.theme", newValue: "light" })));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".widget-shell")).toHaveCSS("pointer-events", "none");
    const panel = await page.locator(".widget-shell").boundingBox();
    const credit = await page.getByTestId("overlay-credit").boundingBox();
    expect(panel?.x).toBeGreaterThanOrEqual(0);
    expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    const board = await page.getByRole("region", { name: "Map veto" }).boundingBox();
    expect(credit?.y).toBeGreaterThanOrEqual((board?.y ?? 0) + (board?.height ?? 0));
    await noPrivateContent(page);
    await checkAccessibility(page, info, PATH, theme);
    await captureAccessibility(page, info, "obs-veto-" + theme);

    fixture.room = { ...fixture.room, phase: "play", rev: 2, turn: null, deadline: null, order: [0] };
    await broadcastFrame(page);
    await expect(page.getByRole("heading", { name: "Series score" })).toBeVisible();
    await expect(page.getByText("Next up: Alcyone LE")).toBeVisible();
    await expect(page.getByText("Seat A", { exact: true })).toBeVisible();
    await expect(page.getByText("Seat B", { exact: true })).toBeVisible();
    expect(fixture.requests.some(request => request.endsWith("?rev=1"))).toBe(true);
    expect(fixture.requests.every(request => request.startsWith("GET /v1/match-rooms/" + ROOM_ID))).toBe(true);
    expect(fixture.outbound).toEqual([]);
    expect(serviceWorkerRequests).toEqual([]);
    await checkAccessibility(page, info, PATH, theme);
    await captureAccessibility(page, info, "obs-score-" + theme);
  });
}

test("connects without credit, retries and drops an expired result", async ({ page, context }, info) => {
  const fixture = await installFixture(context);
  fixture.room = { ...fixture.room, rev: 2, phase: "complete", turn: null, deadline: null,
    score: { a: 1, b: 0 }, order: [0], winners: ["a"] };
  await page.goto(PATH + "?credit=0" + HASH);
  await expect(page.getByText("Series complete")).toBeVisible();
  await expect(page.getByText("1", { exact: true })).toBeVisible();
  await expect(page.getByTestId("overlay-credit")).toHaveCount(0);
  await broadcastFrame(page);
  await expect.poll(() => fixture.requests.some(request => request.endsWith("?rev=2"))).toBe(true);
  fixture.status = 503;
  await broadcastFrame(page);
  await expect(page.getByRole("heading", { name: "Connection lost" })).toBeVisible();
  await expect(page.getByText("Series complete")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Retry connection" });
  await retry.focus();
  await expect(retry).toBeFocused();
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await captureAccessibility(page, info, "obs-connection-lost");
  await checkAccessibility(page, info, PATH, "dark");
  fixture.status = 200;
  await page.keyboard.press("Enter");
  await expect(page.getByText("Series complete")).toBeVisible();
  fixture.status = 404;
  await broadcastFrame(page);
  await expect(page.getByRole("heading", { name: "Room unavailable" })).toBeVisible();
  await expect(page.getByText("Series complete")).toHaveCount(0);
  const readCount = fixture.requests.length;
  await broadcastFrame(page);
  expect(fixture.requests).toHaveLength(readCount);
  await captureAccessibility(page, info, "obs-expired");
});

test("rejects a writable invite without fetching the room", async ({ page, context }, info) => {
  const fixture = await installFixture(context);
  await page.goto(PATH + HASH + "&seat=host&key=" + HOST_KEY);
  await expect(page.getByRole("heading", { name: "Open an OBS source link" })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  await expect(page.locator("main")).not.toContainText(HOST_KEY);
  await checkAccessibility(page, info, PATH, "dark");
  await captureAccessibility(page, info, "obs-invalid-link");
});

test("canonicalizes private aliases without losing the watch fragment", async ({ page, context }) => {
  const fixture = await installFixture(context);
  for (const path of ["/overlay/%6datch-room", "/%6fverlay/match-room"]) {
    const redirect = await page.request.get(path + "?credit=0", { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    const location = new URL(redirect.headers().location, ORIGIN);
    expect(location.pathname + location.search).toBe(PATH + "?credit=0");
    expect(redirect.headers()["referrer-policy"]).toBe("no-referrer");
    expect(redirect.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(redirect.headers()["cache-control"]).toContain("no-store");
    await page.goto(path + "?credit=0" + HASH);
    await expect(page).toHaveURL(ORIGIN + PATH + "?credit=0" + HASH);
    await expect(page.getByRole("heading", { name: "Map veto" })).toBeVisible();
    await expect(page.getByTestId("overlay-credit")).toHaveCount(0);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  }
  expect(fixture.outbound).toEqual([]);
});

test("fits all twenty maps in an 800 by 600 broadcast frame", async ({ page, context }, info) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const fixture = await installFixture(context);
  const maps = ["Purity and Industry LE", ...Array.from({ length: 19 }, (_, i) => "Custom fixture " + i)];
  fixture.room.config.maps = maps;
  await page.goto(PATH + HASH);
  await expect(page.getByRole("listitem")).toHaveCount(20);
  await expect(page.getByText("Purity and Industry LE")).toBeInViewport({ ratio: 1 });
  for (const card of await page.getByRole("listitem").all()) await expect(card).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("overlay-credit")).toBeInViewport({ ratio: 1 });
  await captureAccessibility(page, info, "obs-20-maps");
});

test("the host copies a watch-only source, including the clipboard fallback", async ({ page, context }, info) => {
  await installFixture(context);
  await page.addInitScript(() => {
    localStorage.setItem("sc2tools.analyticsConsent.v1", "denied");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("Clipboard disabled"); } } });
  });
  await page.goto("/match/room" + HASH + "&seat=host&key=" + HOST_KEY);
  const copy = page.getByRole("button", { name: "Copy OBS source" });
  expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await copy.focus();
  await page.keyboard.press("Enter");
  const field = page.getByRole("textbox", { name: "OBS source URL" });
  const url = new URL(page.url());
  await expect(field).toHaveValue(url.origin + PATH + HASH);
  await expect(field).toBeFocused();
  await page.getByRole("combobox", { name: "Overlay credit" }).selectOption("hide");
  await expect(field).toHaveCount(0);
  await copy.click();
  await expect(field).toHaveValue(url.origin + PATH + "?credit=0" + HASH);
  await checkAccessibility(page, info, "/match/room", "dark");
  await captureAccessibility(page, info, "obs-host-copy", true);
});

test.describe("touch source", () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 800 } });

  test("copies on touch and retries a source showing a long map title", async ({ page, context }, info) => {
    const fixture = await installFixture(context);
    fixture.room.config.maps[0] = "Purity and Industry LE";
    await page.addInitScript(() => {
      localStorage.setItem("sc2tools.analyticsConsent.v1", "denied");
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("Clipboard disabled"); } } });
    });
    await page.goto("/match/room" + HASH + "&seat=host&key=" + HOST_KEY);
    await page.getByRole("button", { name: "Copy OBS source" }).tap();
    const field = page.getByRole("textbox", { name: "OBS source URL" });
    const url = new URL(page.url()).origin + PATH + HASH;
    await expect(field).toHaveValue(url);
    await expect(field).toBeFocused();
    expect(await field.evaluate(input => input instanceof HTMLInputElement
      && input.selectionStart === 0 && input.selectionEnd === input.value.length)).toBe(true);
    await page.goto(url);
    const title = page.getByText("Purity and Industry LE");
    await expect(title).toBeInViewport({ ratio: 1 });
    const box = await title.boundingBox();
    const card = await title.locator("..").boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((card?.x ?? 0) + (card?.width ?? 0));
    await captureAccessibility(page, info, "obs-long-map-touch");
    fixture.status = 503;
    await broadcastFrame(page);
    await expect(page.getByRole("heading", { name: "Connection lost" })).toBeVisible();
    fixture.status = 200;
    await page.getByRole("button", { name: "Retry connection" }).tap();
    await expect(title).toBeVisible();
  });
});
