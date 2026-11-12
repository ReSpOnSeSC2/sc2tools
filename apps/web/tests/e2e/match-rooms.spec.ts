import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import type { Room, RoomAction } from "../../lib/matchRoom";

const ROOM_ID = "abcdefghijklmnopqrstuvwx12345678";
const HOST_KEY = "h".repeat(32);
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Cache-Control": "no-store",
};

function initialRoom(): Room {
  return {
    config: { format: 1, preset: "standard", maps: ["Alpha", "Bravo"], practice: false },
    rev: 0, expiresAt: Date.now() + 14 * 86_400_000, serverTime: Date.now(), phase: "lobby",
    names: { a: "", b: "" }, ready: { a: false, b: false }, score: { a: 0, b: 0 },
    first: "a", turn: null, deadline: null, moves: [], order: [], winners: [],
  };
}

function fixtureAction(room: Room, action: RoomAction) {
  room.rev += 1;
  switch (action.type) {
    case "name": room.names[action.as] = action.value; break;
    case "ready":
      room.ready[action.as] = action.value;
      if (room.ready.a && room.ready.b) {
        room.phase = "veto";
        room.turn = { seat: "a", kind: "ban" };
        room.deadline = Date.now() + 30_000;
      }
      break;
    case "veto":
      room.moves = [{ seat: action.as, kind: "ban", map: action.map, automatic: false }];
      room.order = [1 - action.map];
      room.phase = "play";
      room.turn = null;
      room.deadline = null;
      break;
    case "score":
      room.winners = [action.winner];
      room.score[action.winner] = 1;
      room.phase = "complete";
      break;
  }
}

async function installFixture(context: BrowserContext, { failFirst = false } = {}) {
  const room = initialRoom();
  let deleted = false;
  let failed = false;
  const requests: string[] = [];
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text: string) => { sessionStorage.setItem("test-match-copy", text); },
      write: async (items: ClipboardItem[]) => {
        const png = await items[0].getType("image/png");
        sessionStorage.setItem("test-match-image", png.type + ":" + png.size);
      },
    } });
    Object.defineProperty(navigator, "share", { value: undefined });
  });
  await context.route("**/v1/seasons", route => route.fulfill({ headers: HEADERS, json: {
    items: [], current: 69, source: "pulse", mapPool: room.config.maps,
    mapPoolSource: "liquipedia", mapPoolFetchedAt: Date.now(),
  } }));
  await context.route(/\/v1\/match-rooms(?:\/|\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const send = (status: number, json?: unknown) => route.fulfill({ status, headers: HEADERS, json });
    if (method === "OPTIONS") return send(204);
    if (method === "POST" && url.pathname.endsWith("/match-rooms")) {
      room.config = request.postDataJSON() as Room["config"];
      return send(201, { id: ROOM_ID, hostKey: HOST_KEY });
    }
    if (deleted || !url.pathname.includes("/" + ROOM_ID)) return send(404);
    if (method === "DELETE") { deleted = true; return send(204); }
    if (method === "POST") {
      const body = request.postDataJSON() as { key: string; rev: number; action: RoomAction };
      if (body.rev !== room.rev) return send(409);
      fixtureAction(room, body.action);
    }
    if (method === "GET") {
      requests.push(url.search);
      if (failFirst && !failed) { failed = true; return send(503); }
      if (url.searchParams.get("rev") === String(room.rev)) return send(204);
    }
    return send(200, { ...room, serverTime: Date.now() });
  });
  return { requests };
}

async function copy(page: Page, name: string) {
  await page.evaluate(() => sessionStorage.removeItem("test-match-copy"));
  await page.getByRole("button", { name }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("test-match-copy"))).toBeTruthy();
  return await page.evaluate(() => sessionStorage.getItem("test-match-copy") ?? "");
}

async function refreshRoom(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function rejectCookies(page: Page) {
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (await reject.isVisible()) await reject.click();
}

for (const theme of ["light", "dark"] as const) {
  test("hosts a veto, follows it as a spectator and shares a neutral result in " + theme, async ({ page, context }, info) => {
    const { requests } = await installFixture(context);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/match");
    await page.getByRole("combobox", { name: "Series format" }).selectOption("1");
    await expect(page.getByText("Current ladder pool", { exact: false })).toBeVisible();
    await rejectCookies(page);
    await checkAccessibility(page, info, "/match", theme);
    await captureAccessibility(page, info, "match-create-" + theme, true);
    await page.getByRole("button", { name: "Create room" }).click();
    await expect(page.getByRole("heading", { name: "Invite players and spectators" })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await captureAccessibility(page, info, "match-host-" + theme, true);
    const seatA = await copy(page, "Copy Seat A link");
    const seatB = await copy(page, "Copy Seat B link");
    const watch = await copy(page, "Copy watch link");
    expect(new URL(seatA).pathname + new URL(seatA).search).toBe("/match/room");
    expect(seatA).not.toBe(seatB);
    expect(watch).not.toContain("key=");
    expect((await page.request.get("/match/room")).headers()["cache-control"]).toBe("no-store");
    await playVeto(context, seatA, seatB, theme, info);
    await verifyResult(page, context, watch, theme, info);
    expect(requests.some(query => query.startsWith("?rev="))).toBe(true);
  });
}

async function playVeto(context: BrowserContext, seatA: string, seatB: string, theme: "light" | "dark", info: TestInfo) {
  const a = await context.newPage();
  await a.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await a.goto(seatA);
  await a.getByRole("textbox", { name: "Seat A name" }).fill("Fixture Blue");
  await a.getByRole("button", { name: "Save name" }).click();
  await expect(a.getByText("(self-declared)")).toBeVisible();
  await a.getByRole("button", { name: "Ready Seat A" }).click();
  await expect(a.getByRole("button", { name: "Unready Seat A" })).toBeVisible();
  const b = await context.newPage();
  await b.goto(seatB);
  await b.getByRole("button", { name: "Ready Seat B" }).click();
  await expect(b.getByRole("timer")).toBeVisible();
  await refreshRoom(a);
  const map = a.getByRole("button", { name: "Ban Alpha" });
  await expect(map).toBeVisible();
  await captureAccessibility(a, info, "match-veto-" + theme, true);
  await map.focus();
  await a.keyboard.press("Space");
  await expect(a.getByRole("heading", { name: "Series score" })).toBeFocused();
  await a.getByRole("button", { name: "Seat A won" }).click();
  await expect(a.getByText("Seat A wins the series.")).toBeVisible();
  await a.close();
  await b.close();
}

async function verifyResult(page: Page, context: BrowserContext, watch: string, theme: "light" | "dark", info: Parameters<typeof checkAccessibility>[1]) {
  const viewer = await context.newPage();
  await viewer.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await viewer.goto(watch);
  await expect(viewer.getByText("Fixture Blue")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Seat A won" })).toHaveCount(0);
  const result = await copy(viewer, "Copy for Discord");
  expect(result).toContain("Seat A 1–0 Seat B");
  expect(result).not.toMatch(/Fixture Blue|#r=|key=/);
  await viewer.getByRole("button", { name: "Share result image" }).click();
  await expect.poll(() => viewer.evaluate(() => sessionStorage.getItem("test-match-image"))).toMatch(/^image\/png:[1-9]\d+$/);
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await viewer.evaluate(() => document.documentElement.clientWidth),
  );
  await checkAccessibility(viewer, info, "/match/room", theme);
  await captureAccessibility(viewer, info, "match-result-" + theme, true);
  await page.bringToFront();
  const remove = page.getByRole("button", { name: "Delete room now" });
  await remove.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(remove).toBeFocused();
  await remove.click();
  await page.getByRole("button", { name: "Delete room", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Room unavailable" })).toBeVisible();
  await refreshRoom(viewer);
  await expect(viewer.getByRole("heading", { name: "Room unavailable" })).toBeVisible();
  await viewer.close();
}

test("creates a custom practice room and recovers a connection failure", async ({ page, context }) => {
  await installFixture(context, { failFirst: true });
  await page.goto("/match");
  await page.getByRole("combobox", { name: "Series format" }).selectOption("1");
  await rejectCookies(page);
  await page.getByRole("checkbox", { name: "Use a custom map pool" }).check();
  await page.getByRole("textbox", { name: "Map names" }).fill("Zulu\nYankee");
  await page.getByRole("button", { name: "Practice solo" }).click();
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("heading", { name: "Map veto" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready Seat A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready Seat B" })).toBeVisible();
  await expect(page.getByText("Zulu", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy watch link" })).toHaveCount(0);
});
