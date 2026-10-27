"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { SessionHistoryService } = require("../src/services/sessionHistory");
const { GameDeskService } = require("../src/services/gameDesk");
const OWNER = "u_reset-owner", FOREIGN = "u_reset-foreign", TOKEN = "synthetic-reset-publication-token";
const NOW = Date.now(), MINUTE = 60_000;
/** @type {Awaited<ReturnType<typeof createHarness>>} */ let h;
/** @type {Array<{room:string,event:string,payload:unknown}>} */ let events;

/** Narrow the real buildApp service container at this test's consumed boundary.
 * @returns {{sessionHistory:import('../src/services/sessionHistory').SessionHistoryService,gameDesk:import('../src/services/gameDesk').GameDeskService,games:import('../src/services/games').GamesService}} */
function services() { return /** @type {{sessionHistory:import('../src/services/sessionHistory').SessionHistoryService,gameDesk:import('../src/services/gameDesk').GameDeskService,games:import('../src/services/games').GamesService}} */ (h.services); }

/** @returns {{promise:Promise<void>,resolve:()=>void}} */
function deferred() {
  /** @type {()=>void} */ let resolve = () => { throw new Error("not initialized"); };
  /** @type {Promise<void>} */ const promise = new Promise(done => { resolve = () => done(undefined); });
  return { promise, resolve };
}
/** Only a bounded test coordination deadline; no global/fake clock.
 * @param {Promise<void>} promise */
async function started(promise) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  try { await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("History cursor did not enter within 1 second")), 1000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
/** @param {string} owner @param {string} id @param {number} at */
function game(owner, id, at) {
  return { userId: owner, gameId: id, date: new Date(at), result: "Victory", myRace: "Protoss", myLadderRace: "P",
    myToonHandle: "1-S2-1-123", myMmr: 4000, myMmrSource: "replay", matchFormat: "1v1", playerCount: 2,
    isLadderGame: true, durationSec: 60, macroScore: 80, map: "Synthetic map", opponent: { race: "Terran", displayName: "Synthetic opponent" } };
}
/** Observe and pause only the actual History aggregate cursor's first next().
 * Data, projection, ownership and cursor cleanup remain the real implementation.
 * @param {string[]} owners */
function holdHistory(owners) {
  const original = h.db.games.aggregate.bind(h.db.games);
  /** @type {Map<string,{entered:ReturnType<typeof deferred>,release:ReturnType<typeof deferred>,cursor:import("mongodb").AggregationCursor<import("mongodb").Document>|null,close:jest.SpyInstance|null,closedEvent:jest.Mock|null}>} */
  const holds = new Map(owners.map(owner => [owner, { entered: deferred(), release: deferred(), cursor: null, close: null, closedEvent: null }]));
  const aggregate = jest.spyOn(h.db.games, "aggregate").mockImplementation((pipeline = [], options) => {
    const cursor = original(pipeline, options), owner = pipeline?.[0]?.$match?.userId;
    const hold = holds.get(owner);
    if (!hold || hold.cursor || !pipeline.some(stage => stage.$limit === 5001)) return cursor;
    hold.cursor = cursor; hold.close = jest.spyOn(cursor, "close");
    hold.closedEvent = jest.fn(); cursor.once("close", hold.closedEvent);
    const next = cursor.next.bind(cursor); let first = true;
    jest.spyOn(cursor, "next").mockImplementation(async () => {
      if (first) { first = false; hold.entered.resolve(); await hold.release.promise; }
      return next();
    });
    return cursor;
  });
  return { holds, async close() {
    for (const hold of holds.values()) hold.release.resolve();
    for (const hold of holds.values()) if (hold.cursor && !hold.closedEvent?.mock.calls.length) await hold.cursor.close();
    aggregate.mockRestore();
  } };
}
/** @param {ReturnType<typeof holdHistory>} watcher @param {string} owner */
function requireHold(watcher, owner) {
  const hold = watcher.holds.get(owner);
  if (!hold) throw new Error("Expected declared owner cursor hold");
  return hold;
}
/** @param {ReturnType<typeof requireHold>} hold */
async function assertClosed(hold) {
  if (!hold.cursor || !hold.close || !hold.closedEvent) throw new Error("Expected actual History cursor");
  // Mongo's closed getter also requires an empty local batch after close().
  // Observe resource closure without consuming buffered replay data for the test.
  expect(hold.close).toHaveBeenCalledTimes(1);
  await expect(hold.close.mock.results[0].value).resolves.toBeUndefined();
  expect(hold.closedEvent).toHaveBeenCalledTimes(1);
}
/** @param {string} path @param {string} [name] */
const get = (path, name = "reset-owner") => request(h.app).get(path).set("authorization", h.bearer(name));
const naturalPath = () => `/v1/sessions?${new URLSearchParams({ tz: "UTC", windowFrom: new Date(NOW - 5 * MINUTE).toISOString(), windowTo: new Date(NOW + 1000).toISOString() })}`;

beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  jest.restoreAllMocks(); events = [];
  for (const collection of [h.db.users, h.db.games, h.db.overlayTokens, h.db.multichatStudio]) await collection.deleteMany({});
  await h.seedUser("reset-owner", { sessionGapMinutes: 90 });
  await h.seedUser("reset-foreign", { sessionGapMinutes: 90 });
  expect(services().sessionHistory).toBeInstanceOf(SessionHistoryService);
  expect(services().gameDesk).toBeInstanceOf(GameDeskService);
  jest.spyOn(services().sessionHistory, "now").mockReturnValue(NOW + 1000);
  jest.spyOn(services().gameDesk, "now").mockReturnValue(NOW);
  // Unrelated legacy overlay fanout is outside this regression. History reads,
  // GameDesk's actual anchor write/studio update and buildApp callback are real.
  jest.spyOn(services().games, "todaySession").mockRejectedValue(Object.assign(new Error("Skip unrelated legacy fanout"), { code: "SESSION_RESOLUTION_STALE" }));
  const io = /** @type {import("socket.io").Server} */ (/** @type {unknown} */ ({ to: (/** @type {string} */ room) => ({ emit: (/** @type {string} */ event, /** @type {unknown} */ payload) => events.push({ room, event, payload }) }) }));
  jest.replaceProperty(services().gameDesk.deps, "io", io);
  await h.db.games.insertMany([game(OWNER, "owner-first", NOW - 2 * MINUTE), game(OWNER, "owner-last", NOW - MINUTE),
    game(FOREIGN, "foreign-first", NOW - 2 * MINUTE), game(FOREIGN, "foreign-last", NOW - MINUTE)]);
});
afterEach(() => jest.restoreAllMocks());

/** @param {string} mode */
async function readPath(mode) {
  const initial = await get("/v1/sessions/current?tz=UTC");
  expect(initial.status).toBe(200); expect(initial.body.session.games).toBe(2);
  return mode === "current" ? "/v1/sessions/current?tz=UTC" : `/v1/sessions/${initial.body.session.id}?tz=UTC`;
}

test.each(["current", "detail"])("actual reset retires a held %s read only for its owner", async mode => {
  const path = await readPath(mode), natural = await get(naturalPath());
  expect(natural.status).toBe(200); expect(natural.body.items[0].games).toBe(2);
  const watcher = holdHistory([OWNER, FOREIGN]), owner = requireHold(watcher, OWNER), foreign = requireHold(watcher, FOREIGN);
  const old = get(path).then(value => value), other = get("/v1/sessions/current?tz=UTC", "reset-foreign").then(value => value);
  try {
    await Promise.all([started(owner.entered.promise), started(foreign.entered.promise)]);
    const state = await services().gameDesk.resetSession(OWNER, TOKEN);
    expect(state.streamStartMs).toBe(NOW);
    owner.release.resolve(); foreign.release.resolve();
    const [retired, unaffected] = await Promise.all([old, other]);
    expect(retired.status).toBe(409); expect(retired.body.session).toBeUndefined();
    expect(unaffected.status).toBe(200); expect(unaffected.body.session.games).toBe(2);
    await assertClosed(owner);
    await assertClosed(foreign);
    const after = await get(naturalPath());
    expect(after.status).toBe(200); expect(after.body.items).toEqual(natural.body.items);
    const current = await get("/v1/sessions/current?tz=UTC");
    expect(current.status).toBe(200); expect(current.body.session).toBeNull();
    expect(current.body.manualAnchorAt).toBe(new Date(NOW).toISOString());
    expect((await h.db.users.findOne({ userId: FOREIGN }))?.sessionAnchorAt).toBeUndefined();
    expect(events.filter(event => event.event === "games:changed")).toEqual([
      { room: `user:${OWNER}`, event: "games:changed", payload: { count: 0, inserted: 0, bulk: false, reason: "session-reset" } },
    ]);
    await h.db.games.insertOne(game(OWNER, "exact-anchor", NOW));
    const inclusive = await get("/v1/sessions/current?tz=UTC");
    expect(inclusive.status).toBe(200); expect(inclusive.body.session.games).toBe(1);
  } finally {
    owner.release.resolve(); foreign.release.resolve();
    await Promise.allSettled([old, other]); await watcher.close();
  }
});

test.each(["current", "detail"])("a committed reset write error retires a %s read started during the write", async mode => {
  const path = await readPath(mode), watcher = holdHistory([OWNER]), hold = requireHold(watcher, OWNER);
  const enteredWrite = deferred(), allowCommit = deferred(), failure = new Error("synthetic reset ACK lost after commit");
  const original = h.db.users.updateOne.bind(h.db.users);
  const writing = jest.spyOn(h.db.users, "updateOne").mockImplementation(async (...args) => {
    const [filter, update] = args;
    if (filter.userId !== OWNER || Array.isArray(update) || !update.$max?.sessionAnchorAt) return original(...args);
    enteredWrite.resolve(); await allowCommit.promise;
    await original(...args); throw failure;
  });
  // Begin the read AFTER the reset's first fence, while the old anchor remains
  // stored. This catches an implementation that forgets the finally fence.
  const reset = services().gameDesk.resetSession(OWNER, TOKEN).then(() => null, error => error);
  /** @type {Promise<import("supertest").Response>|undefined} */ let old;
  try {
    await started(enteredWrite.promise);
    old = get(path).then(value => value); await started(hold.entered.promise);
    allowCommit.resolve(); expect(await reset).toBe(failure);
    expect((await h.db.users.findOne({ userId: OWNER }))?.sessionAnchorAt).toBe(new Date(NOW).toISOString());
    hold.release.resolve(); const retired = await old;
    expect(retired.status).toBe(409); expect(retired.body.session).toBeUndefined();
    await assertClosed(hold);
    expect(events.filter(event => event.event === "games:changed")).toEqual([]);
    const fresh = await get("/v1/sessions/current?tz=UTC");
    expect(fresh.status).toBe(200); expect(fresh.body.session).toBeNull();
    expect(fresh.body.manualAnchorAt).toBe(new Date(NOW).toISOString());
  } finally {
    allowCommit.resolve(); hold.release.resolve();
    await Promise.allSettled([reset, ...(old ? [old] : [])]);
    await watcher.close(); writing.mockRestore();
  }
});
