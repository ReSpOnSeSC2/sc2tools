"use strict";

const { SessionHistoryService } = require("../src/services/sessionHistory");
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { SessionResolutionGate } = require("../src/services/sessionResolutionGate");
const { OwnerRevisions } = require("../src/util/gameVisibility");
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const BASE = Date.parse("2026-10-25T00:00:00.000Z");
/** @param {string} id @param {number} minute @param {Record<string,unknown>} [extra] */
function game(id, minute, extra = {}) {
  return { gameId: id, date: new Date(BASE + minute * 60_000), result: "Victory", myRace: "P", myToonHandle: "1-S2-1-1",
    myMmr: 4000, durationSec: 600, macroScore: 80, myBuild: "Recorded opener", opponent: { race: "T", displayName: "Opponent" }, ...extra };
}
/** @template T @returns {{promise:Promise<T>,resolve:(value:T)=>void}} */
function deferred() {
  /** @type {(value:T)=>void} */ let resolve = () => { throw new Error("deferred not initialized"); };
  /** @type {Promise<T>} */ const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
/** Structural stream boundary used only by this unit double.
 * @param {Record<string,unknown>[]} rows @param {Promise<Record<string,unknown>[]>|null} [held] */
function rowCursor(rows, held = null) {
  let index = 0, current = rows;
  return { next: jest.fn(async () => {
    if (held) { current = await held; held = null; }
    return index < current.length ? current[index++] : null;
  }), close: jest.fn(async () => {}) };
}
/** Explicit structural Mongo boundary double; the real Mongo sibling proves
 * actual owner/type/index behavior. This helper replaces no product hook/kernel.
 * @param {Record<string,unknown>[]} initial */
function fixture(initial) {
  const state = { rows: initial, now: NOW, anchor: /** @type {string|null} */ (null) };
  const revisions = new OwnerRevisions();
  const profile = async () => ({ userId: "owner", sessionGapMinutes: 90, sessionAnchorAt: state.anchor });
  const policy = new SessionPolicyService({ users: { findOne: profile }, overlayTokens: { findOne: async () => null } }, { revisions });
  const aggregate = jest.fn((/** @type {Record<string,unknown>[]} */ pipeline = []) => {
    const match = /** @type {{date:{$gte:Date,$lte:Date}}} */ (pipeline[0].$match);
    return rowCursor(state.rows.filter(row => row.date instanceof Date && row.date >= match.date.$gte && row.date <= match.date.$lte));
  });
  const db = /** @type {Pick<import('../src/db/connect').DbContext,'games'|'users'>} */ (/** @type {unknown} */ ({ games: { aggregate }, users: { findOne: profile } }));
  return { service: new SessionHistoryService(db, { sessionPolicy: policy, now: () => state.now }), state, revisions, aggregate, db };
}
function query() { return { windowFrom: "2026-10-25T00:00:00.000Z", windowTo: "2026-10-26T00:00:00.000Z", contextDays: "1" }; }

test("complete full-component summaries and IDs survive different output windows", async () => {
  const { service } = fixture([game("before", -10), game("zero", 0, { result: "Tie" }), game("after", 90)]);
  const first = await service.list("owner", query());
  const second = await service.list("owner", { ...query(), windowFrom: "2026-10-24T23:30:00.000Z" });
  expect(first.status).toBe("ready");
  expect(first.items[0]).toMatchObject({ games: 3, wins: 2, losses: 0, unknown: 1, results: "WUW" });
  expect(first.items[0].id).toBe(second.items[0].id);
  expect(first.items[0].mmr[0]).not.toHaveProperty("steps");
  const detail = await service.detail("owner", first.items[0].id, { contextDays: "1", gamesLimit: "1" });
  expect(detail.gamePage).toEqual({ limit: 1, count: 1, total: 3 });
  expect(detail.games[0].id).toBe("before");
  expect(detail.mmr[0].steps).toHaveLength(3);
});

test("continuous scan-edge chains require explicit context, never partial statistics", async () => {
  const { service } = fixture([game("a", -160), game("b", -80), game("c", 0), game("d", 80)]);
  const limited = await service.list("owner", { windowFrom: query().windowFrom, windowTo: query().windowTo });
  expect(limited).toMatchObject({ status: "context_required", items: [], nextBefore: null });
  const extended = await service.list("owner", query());
  expect(extended.status).toBe("ready");
  expect(extended.items[0].games).toBe(4);
});

test("late imports between already visited sessions stale the whole-window cursor", async () => {
  const { service, state } = fixture([game("old", 120), game("middle", 480), game("new", 840)]);
  const first = await service.list("owner", { ...query(), limit: "2" });
  expect(first.items.map(item => item.games)).toEqual([1, 1]);
  expect(first.nextBefore).not.toBeNull();
  state.rows.push(game("late-between", 660));
  await expect(service.list("owner", { ...query(), before: first.nextBefore, limit: "2" })).rejects.toMatchObject({ code: "session_view_changed", status: 409 });
});

test("content digest detects macro/build edits outside core order keys, omitting notes", async () => {
  const { service, state } = fixture([game("one", 120)]);
  const first = await service.list("owner", query());
  state.rows[0].macroScore = 0;
  await expect(service.detail("owner", first.items[0].id, { contextDays: "1" })).rejects.toMatchObject({ code: "session_view_changed" });
  const next = await service.list("owner", query());
  expect(next.items[0].avgMacro).toBe(0);
  expect(next.items[0].id).not.toBe(first.items[0].id);
  state.rows[0].buildIntent = { status: "confirmed", notes: "private-note", suggestionCache: { private: true } };
  const detail = await service.detail("owner", next.items[0].id, { contextDays: "1" });
  expect(JSON.stringify(detail)).not.toContain("private-note");
  expect(JSON.stringify(detail)).not.toContain("suggestionCache");
});

test("current reset clips inclusively and cannot become historical reset events", async () => {
  const { service, state } = fixture([game("pre", 120), game("at", 180), game("post", 240)]);
  state.anchor = new Date(BASE + 180 * 60_000).toISOString();
  const current = await service.current("owner");
  expect(current.session).toMatchObject({ games: 2 });
  expect(current.manualAnchorAt).toBe(state.anchor);
  const natural = await service.list("owner", query());
  expect(natural.items[0].games).toBe(3);
  const id = current.session?.id;
  if (!id) throw new Error("expected current locator");
  state.anchor = new Date(BASE + 240 * 60_000).toISOString();
  await expect(service.detail("owner", id)).rejects.toMatchObject({ code: "session_view_changed" });
});

test("oversized dense input returns an honest bounded state before summary construction", async () => {
  const { service } = fixture(Array.from({ length: 5001 }, (_, index) => game(`row-${index}`, index / 100)));
  const value = await service.list("owner", query());
  expect(value).toMatchObject({ status: "narrow_window", items: [], nextBefore: null, nextWindow: null });
});

test("same-clock distinct requests cannot join another route's pending result", async () => {
  const { service, aggregate } = fixture([game("one", 120)]);
  /** @type {{promise:Promise<Record<string,unknown>[]>,resolve:(value:Record<string,unknown>[])=>void}} */ const held = deferred();
  aggregate.mockImplementationOnce(() => rowCursor([], held.promise));
  const history = service.list("owner", query());
  await Promise.resolve(); await Promise.resolve();
  const current = service.current("owner");
  held.resolve([game("one", 120)]);
  expect((await history).kind).toBe("history");
  expect((await current).kind).toBe("current");
  expect(aggregate).toHaveBeenCalledTimes(2);
});

test("current locator uses the fixed live rule, not a moving scope timestamp", async () => {
  const { service, state } = fixture([game("same", 120)]);
  const before = await service.current("owner");
  state.now += 1000;
  const after = await service.current("owner");
  expect(before.session?.id).toBe(after.session?.id);
  expect(before.window.asOf).not.toBe(after.window.asOf);
});

test("an actual current edge member aging out changes the derived locator", async () => {
  const edge = NOW - 14 * 86_400_000 + 500;
  const { service, state } = fixture([game("edge", 0, { date: new Date(edge) }), game("later", 0, { date: new Date(edge + 80 * 60_000) })]);
  const before = await service.current("owner");
  expect(before.session?.games).toBe(2);
  state.now += 1000;
  const after = await service.current("owner");
  expect(after.session?.games).toBe(1);
  expect(before.session?.id).not.toBe(after.session?.id);
});

test("normalized byte admission rejects a dense bounded projection honestly", async () => {
  const long = "x".repeat(200);
  const { service } = fixture(Array.from({ length: 5000 }, (_, index) => game(`row-${index}-${long.slice(0, 180)}`, index / 100,
    { map: long, myBuild: long, opponent: { displayName: long, race: "T" } })));
  expect(await service.list("owner", query())).toMatchObject({ status: "narrow_window", items: [], nextBefore: null });
});

test("nullable IDs and equal core ties retain multiplicity without fabricated identifiers", async () => {
  const { service } = fixture([game("ignored", 120, { gameId: null, macroScore: 20 }), game("ignored", 120, { gameId: null, macroScore: 90 })]);
  const value = await service.list("owner", query());
  expect(value.items[0].games).toBe(2);
  const detail = await service.detail("owner", value.items[0].id, { contextDays: "1" });
  expect(detail.games.map(row => row.id)).toEqual([null, null]);
  expect(detail.games.map(row => row.macroScore)).toEqual([20, 90]);
});

test("request deadline retires held policy work before a late games query", async () => {
  jest.useFakeTimers();
  const { service, aggregate } = fixture([game("one", 120)]);
  /** @type {{promise:Promise<import('../src/services/sessionPolicy').SessionPolicy>,resolve:(value:import('../src/services/sessionPolicy').SessionPolicy)=>void}} */ const held = deferred();
  jest.spyOn(service.policy, "resolve").mockImplementationOnce(() => held.promise);
  try {
    const pending = service.list("owner", query());
    const rejected = expect(pending).rejects.toMatchObject({ status: 503, code: "session_history_unavailable" });
    await jest.advanceTimersByTimeAsync(4001);
    await rejected;
    held.resolve({ gapMinutes: 90, storedGapMinutes: 90, source: "preference" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(aggregate).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test("detail archive metadata is bounded and part of content identity without storage keys", async () => {
  const { service, state } = fixture([game("archived", 120, { replayFile: { storedAt: new Date(BASE), sizeBytes: 1234, key: "private-object-key", url: "private-provider-url" } })]);
  const listed = await service.list("owner", query());
  const detail = await service.detail("owner", listed.items[0].id);
  expect(detail.games[0]).toMatchObject({ replayAvailable: true, replaySizeBytes: 1234 });
  expect(JSON.stringify(detail)).not.toContain("private-object-key");
  expect(JSON.stringify(detail)).not.toContain("private-provider-url");
  state.rows[0].replayFile = { storedAt: null, sizeBytes: null };
  await expect(service.detail("owner", listed.items[0].id)).rejects.toMatchObject({ code: "session_view_changed" });
});

test("actual gate saturation maps only known busy rejection to retryable503", async () => {
  const { service } = fixture([]);
  service.gate = new SessionResolutionGate({ maxActiveComputes: 1, maxComputeWaiters: 0 });
  /** @type {{promise:Promise<number>,resolve:(value:number)=>void}} */ const held = deferred();
  const first = service.admit("owner-a", () => held.promise);
  await Promise.resolve(); await Promise.resolve();
  await expect(service.admit("owner-b", async () => 2)).rejects.toMatchObject({ code: "session_history_unavailable", status: 503 });
  held.resolve(1); expect(await first).toBe(1);
  const original = new Error("other failure");
  await expect(service.admit("owner-c", async () => { throw original; })).rejects.toBe(original);
});

test("caller deadline retains actual compute capacity until cursor cleanup settles", async () => {
  jest.useFakeTimers();
  const { service, aggregate } = fixture([game("held-close", 120)]);
  service.gate = new SessionResolutionGate({ maxActiveComputes: 1, maxComputeWaiters: 0 });
  /** @type {{promise:Promise<void>,resolve:(value:void)=>void}} */ const held = deferred();
  const cursor = rowCursor([game("held-close", 120)]);
  cursor.close.mockImplementationOnce(() => held.promise);
  aggregate.mockImplementationOnce(() => cursor);
  try {
    const first = service.list("owner-a", query());
    const expired = expect(first).rejects.toMatchObject({ status: 503 });
    await jest.advanceTimersByTimeAsync(4001); await expired;
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(service.gate.capacitySnapshot().computeActive).toBe(1);
    await expect(service.list("owner-b", query())).rejects.toMatchObject({ status: 503 });
    held.resolve(undefined);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(service.gate.capacitySnapshot().computeActive).toBe(0);
  } finally { held.resolve(undefined); jest.useRealTimers(); }
});



test("API keeps format/queue observations while comparing only proved ranked1v1 queued-race tracks", async () => {
  const ranked = { isLadderGame: true, playerCount: 2, myLadderRace: "P" };
  const { service } = fixture([
    game("ranked-first", 0, { ...ranked, myMmr: 4000 }),
    game("ranked-last", 30, { ...ranked, myMmr: 4050 }),
    game("explicit-null", 60, { ...ranked, matchFormat: null, myMmr: 6100 }),
    game("team", 90, { ...ranked, playerCount: 4, matchFormat: "team", myMmr: 9000 }),
    game("custom", 120, { ...ranked, isLadderGame: false, matchFormat: "1v1", myMmr: 2000 }),
    game("unproved-race", 150, { isLadderGame: true, playerCount: 2, matchFormat: "1v1", myMmr: 8000 }),
  ]);
  const listed = await service.list("owner", query());
  expect(listed.items[0].games).toBe(6);
  const tracks = listed.items[0].mmr;
  expect(tracks.reduce((sum, track) => sum + track.games, 0)).toBe(6);
  expect(tracks.find(track => track.ratingScope === "ranked-1v1" && track.ladderRace === "P"))
    .toMatchObject({ comparable: true, samples: 2, start: 4000, end: 4050, delta: 50 });
  expect(tracks.find(track => track.ratingScope === "ranked-1v1" && track.ladderRace === null))
    .toMatchObject({ comparable: false, samples: 1, start: 8000, end: 8000, delta: null });
  for (const track of tracks) {
    expect(track).not.toHaveProperty("steps");
    if (!track.comparable) expect(track.delta).toBeNull();
  }
  const detail = await service.detail("owner", listed.items[0].id, { contextDays: "1" });
  expect(detail.games).toHaveLength(6);
  expect(detail.games[0]).toMatchObject({ ratingScope: "ranked-1v1", comparable: true, ladderRace: "P" });
  expect(detail.games[2]).toMatchObject({ ratingScope: "ranked-unknown", comparable: false });
  expect(detail.games[5]).toMatchObject({ ratingScope: "ranked-1v1", comparable: false, ladderRace: null });
});

test("explicit null format cannot inherit missing-format fallback or keep an old content locator", async () => {
  const ranked = { isLadderGame: true, playerCount: 2, myLadderRace: "P" };
  const { service, state } = fixture([game("first", 0, { ...ranked, myMmr: 4000 }), game("last", 30, { ...ranked, myMmr: 4050 })]);
  const first = await service.list("owner", query());
  expect(first.items[0].mmr).toHaveLength(1);
  expect(first.items[0].mmr[0]).toMatchObject({ ratingScope: "ranked-1v1", comparable: true, delta: 50 });
  state.rows[0].matchFormat = null;
  await expect(service.detail("owner", first.items[0].id, { contextDays: "1" })).rejects.toMatchObject({ code: "session_view_changed" });
  const next = await service.list("owner", query());
  expect(next.items[0].games).toBe(2);
  expect(next.items[0].id).not.toBe(first.items[0].id);
  expect(next.items[0].mmr).toHaveLength(2);
  expect(next.items[0].mmr.find(track => track.ratingScope === "ranked-unknown"))
    .toMatchObject({ comparable: false, samples: 1, delta: null });
});
