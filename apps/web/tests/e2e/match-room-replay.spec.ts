import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { resolve } from "node:path";
import type { RoomAction } from "../../lib/matchRoom";
import type { WorkerEvent, WorkerRequest } from "../../lib/instant/protocol";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const ROOM_ID = "abcdefghijklmnopqrstuvwx12345678";
const KEYS = { a: "a".repeat(64), b: "b".repeat(64) };
const HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Cache-Control": "no-store" };
const PATH = "/match/room";

async function installWorker(context: BrowserContext, endedAt: number) {
  await context.addInitScript(({ endedAt }) => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage?: (event: MessageEvent<WorkerEvent>) => void;
      postMessage(message: WorkerRequest) {
        if (message.type === "boot") {
          sessionStorage.setItem("match-worker-boot", String(message.refreshPolicy));
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
            type: "ready", info: { engineVersion: "fixture", pyodideVersion: "fixture",
              pythonVersion: "fixture", bundleId: "fixture", bootMs: 1 }, heapBytes: 1,
          } })));
        } else if (message.type === "players") {
          const ok = message.bytes.byteLength > 1;
          sessionStorage.setItem("match-local-path", message.relativePath);
          setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: {
            type: "players", id: message.id, result: ok ? {
              ok: true, players: [
                { name: "Fixture Blue", pid: 1, toon: "1-S2-1-5", race: "Protoss", result: "Win" },
                { name: "Fixture Red", pid: 2, toon: "1-S2-1-6", race: "Zerg", result: "Loss" },
              ],
              map: "Alpha LE", date: new Date(endedAt).toISOString(), durationSec: 155,
              matchFormat: "1v1", playerCount: 2, isAiGame: false, toonFromPath: null,
            } : { ok: false, errorKind: "corrupt_file" },
          } })), 300);
        }
      }
      terminate() { this.onmessage = undefined; }
    } });
  }, { endedAt });
}

function fixtureRoom() {
  return {
    config: { format: 3, preset: "ban-only", maps: ["Alpha", "Beta", "Gamma"], practice: false },
    rev: 2, expiresAt: Date.now() + 1_000_000, phase: "play", first: "a", turn: null, deadline: null,
    names: { a: "", b: "" }, ready: { a: true, b: true }, score: { a: 0, b: 0 },
    moves: [], order: [0, 1, 2], winners: [] as ("a" | "b")[], replayScoring: true,
    reports: [] as ({ submittedBy: "a" | "b"; confirmed: boolean } | null)[], undoBy: null as "a" | "b" | null,
  };
}

function undo(room: ReturnType<typeof fixtureRoom>, seat: "a" | "b") {
  if (room.undoBy && room.undoBy !== seat) {
    room.undoBy = null;
    const winner = room.winners.pop();
    if (winner) room.score[winner] -= 1;
    room.reports.pop();
  } else room.undoBy = seat;
}

function report(room: ReturnType<typeof fixtureRoom>, seat: "a" | "b", action: Extract<RoomAction, { type: "report_replay" }>) {
  const current = room.reports[0];
  if (current) current.confirmed = seat !== current.submittedBy;
  else {
    room.reports.push({ submittedBy: seat, confirmed: false });
    room.winners.push(action.winnerSeat);
    room.score[action.winnerSeat] += 1;
  }
}

async function installApi(context: BrowserContext) {
  const room = fixtureRoom();
  const requests: RoomAction[] = [];
  let conflict = false;
  await context.route(/\/v1\/match-rooms\//, async route => {
    const request = route.request();
    const send = (status: number, json?: unknown) => route.fulfill({ status, headers: HEADERS, json });
    if (request.method() === "OPTIONS") return send(204);
    if (request.method() === "POST") {
      const { action, key, rev } = request.postDataJSON() as { action: RoomAction; key: string; rev: number };
      expect(rev).toBe(room.rev);
      expect(Object.values(KEYS)).toContain(key);
      const seat = key === KEYS.a ? "a" : "b";
      requests.push(action);
      if (conflict) { conflict = false; return send(409, { error: { code: "replay_result_conflict" } }); }
      if (action.type === "report_replay") report(room, seat, action);
      if (action.type === "undo") undo(room, seat);
      if (action.type === "score") {
        room.reports.push(null);
        room.winners.push(action.winner);
        room.score[action.winner] += 1;
      }
      room.rev += 1;
    }
    return send(200, { ...room, serverTime: Date.now() });
  });
  return { requests, nextConflict: () => { conflict = true; } };
}

function seatPath(seat?: "a" | "b") {
  return PATH + "#r=" + ROOM_ID + (seat ? "&seat=" + seat + "&key=" + KEYS[seat] : "");
}

async function start(page: Page, theme: "light" | "dark", seat?: "a" | "b") {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(seatPath(seat));
  await expect(page.getByRole("heading", { name: "Series score" })).toBeVisible();
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (await reject.isVisible()) await reject.click();
}

async function choose(page: Page, contents: string) {
  await page.getByLabel("Match replay").setInputFiles({ name: "private-filename.SC2Replay",
    mimeType: "application/octet-stream", buffer: Buffer.from(contents) });
}

async function dropReplay(page: Page) {
  const dataTransfer = await page.evaluateHandle(() => {
    const payload = new DataTransfer();
    payload.items.add(new File(["synthetic replay bytes"], "private-filename.SC2Replay"));
    return payload;
  });
  try {
    const target = page.getByText("Or drop one replay here.", { exact: false });
    await target.dispatchEvent("dragover", { dataTransfer });
    await target.dispatchEvent("drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function inspectReport(page: Page, info: TestInfo, theme: "light" | "dark") {
  expect(await page.evaluate(() => sessionStorage.getItem("match-worker-boot"))).toBeNull();
  const trigger = page.getByRole("button", { name: "Choose replay" });
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await trigger.focus();
  await choose(page, "x");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("This replay could not be read");
  await captureAccessibility(page, info, "match-replay-error-" + theme, true);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await dropReplay(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  const me = page.getByRole("button", { name: "Fixture Blue (winner)" });
  await expect(me).toBeVisible();
  expect((await me.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await me.focus();
  await checkAccessibility(page, info, PATH + "/replay-dialog", theme);
  await captureAccessibility(page, info, "match-replay-local-player-" + theme, true);
  expect(await page.evaluate(() => sessionStorage.getItem("match-worker-boot"))).toBe("false");
  expect(await page.evaluate(() => sessionStorage.getItem("match-local-path"))).toBe("match.SC2Replay");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Reported from replay")).toBeVisible();
}

async function confirmAndUndo(a: Page, b: Page, info: TestInfo, theme: "light" | "dark") {
  await start(b, theme, "b");
  await expect(b.getByText("Reported from replay")).toBeVisible();
  await choose(b, "synthetic replay bytes");
  await b.getByRole("button", { name: "Fixture Red (runner-up)" }).click();
  await expect(b.getByText("Confirmed by both players", { exact: false })).toBeVisible();
  await checkAccessibility(b, info, PATH, theme);
  await captureAccessibility(b, info, "match-replay-confirmed-" + theme, true);
  await b.getByRole("button", { name: "Request score undo" }).click();
  await expect(b.getByRole("status")).toContainText("Waiting for the other player");
  await a.bringToFront();
  await a.reload();
  await a.getByRole("button", { name: "Agree to undo last score" }).click();
  await expect(a.getByText("Up next", { exact: true })).toBeVisible();
  await a.getByRole("button", { name: "Seat A won" }).click();
  await expect(a.getByText("Manual score")).toBeVisible();
  await captureAccessibility(a, info, "match-replay-manual-score-" + theme, true);
}

async function verifyWatch(context: BrowserContext, theme: "light" | "dark") {
  const watch = await context.newPage();
  await start(watch, theme);
  await expect(watch.getByText("Manual score")).toBeVisible();
  await expect(watch.getByRole("button", { name: "Choose replay" })).toHaveCount(0);
  await expect(watch.getByText("Fixture Blue", { exact: false })).toHaveCount(0);
  expect(await watch.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(watch.viewportSize()?.width ?? 0);
  await watch.close();
}

test("reads a repository replay with the shipped engine", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { requests } = await installApi(context);
  await start(page, "light", "a");
  await page.getByLabel("Match replay").setInputFiles(resolve("../replay-engine/tests/fixtures/replays/ladder_tvt_tourmaline.SC2Replay"));
  const dialog = page.getByRole("dialog", { name: "Report replay as Seat A" });
  await expect(dialog.getByRole("button", { name: /\(winner\)$/u })).toBeVisible({ timeout: 45_000 });
  await expect(dialog.getByRole("button", { name: /\(runner-up\)$/u })).toBeVisible();
  expect(requests).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Choose replay" })).toBeFocused();
});

for (const theme of ["light", "dark"] as const) {
  test("reports locally, handles a conflict, confirms independently and undoes in " + theme, async ({ page, context }, info) => {
    const endedAt = Date.now();
    await installWorker(context, endedAt);
    const { requests, nextConflict } = await installApi(context);
    await start(page, theme, "a");
    await inspectReport(page, info, theme);
    const b = await context.newPage();
    await verifyConflict(b, info, theme, nextConflict);
    await confirmAndUndo(page, b, info, theme);
    await verifyWatch(context, theme);
    expect(requests[0]).toEqual(requests[2]);
    expect(requests[0]).toEqual({
      type: "report_replay", mapKey: "alpha", endedAt, durationSec: 155, winnerSeat: "a",
      receipt: expect.stringMatching(/^[a-f0-9]{64}$/),
      toonDigests: { a: expect.stringMatching(/^[a-f0-9]{64}$/), b: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(JSON.stringify(requests)).not.toMatch(/private-filename|Fixture|1-S2|synthetic replay bytes/);
    await b.close();
  });
}

async function verifyConflict(page: Page, info: TestInfo, theme: "light" | "dark", nextConflict: () => void) {
  await start(page, theme, "b");
  await choose(page, "synthetic replay bytes");
  nextConflict();
  await page.getByRole("button", { name: "Fixture Blue (winner)" }).click();
  await expect(page.getByRole("alert")).toContainText("This report disagrees with the recorded winner.");
  await captureAccessibility(page, info, "match-replay-conflict-" + theme, true);
}
