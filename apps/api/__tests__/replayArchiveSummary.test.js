"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
const { _internals: { cachedFacets, FACET_TTL_MS, FACET_CACHE_MAX } } = require("../src/services/replayArchiveSummary");

/** @type {import('mongodb-memory-server').MongoMemoryServer} */ let mongo;
/** @type {any} */ let db;
/** @type {import('../src/services/replayLibrary').ReplayLibraryService} */ let service;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "archive_summary" }); });
beforeEach(async () => { await db.games.deleteMany({}); service = new ReplayLibraryService(db); });
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });

function game(/** @type {string} */ id, /** @type {Record<string, any>} */ overrides = {}) {
  return { userId: "owner", gameId: id, date: new Date(`2026-10-${id.padStart(2, "0")}T12:00:00Z`), myRace: "Protoss", opponent: { race: "Zerg", displayName: "Opponent" }, map: "Alcyone LE", myBuild: "Blink", result: "Victory", durationSec: 600, ...overrides };
}

test("the filtered record matches a manual count and ignores cursor, sort and page size", async () => {
  await db.games.insertMany([game("1"), game("2", { result: "Win", durationSec: 1200 }), game("3", { result: "Defeat", durationSec: 900 }), game("4", { map: "Oceanborn LE", result: "Tie", opponent: { race: "Terran" } }), game("5", { userId: "other" }), game("6", { isResumedFromReplay: true })]);
  const options = { filters: { map: "Alcyone" }, result: "win", view: /** @type {const} */ ("detector"), withSummary: true, limit: 1 };
  const first = await service.list("owner", options);
  const second = await service.list("owner", { ...options, cursor: first.nextCursor });
  expect(first.items.map((item) => item.gameId)).toEqual(["2"]); expect(second.items.map((item) => item.gameId)).toEqual(["1"]);
  expect(first.summary).toEqual({ total: 2, wins: 2, losses: 0, ties: 0, avgDurationSec: 900 }); expect(second.summary).toEqual(first.summary);
  expect(first.facets).toEqual({ maps: ["Alcyone LE", "Oceanborn LE"], matchups: ["PvT", "PvZ"] });
  expect((await service.list("owner", { ...options, sort: "date_asc" })).summary).toEqual(first.summary);
});

test("summary uses detector labels, handles both tie spellings and ignores invalid durations", async () => {
  await db.games.insertMany([game("1", { myBuild: "Planned", buildIntent: { status: "confirmed", applied: true, build: { name: "Planned" }, detected: { name: "Blink" } } }), game("2", { result: "Draw", durationSec: -1 }), game("3", { result: "Tie", durationSec: null }), game("4", { result: "Unknown", durationSec: "private-junk" })]);
  const selected = await service.list("owner", { view: "detector", withSummary: true, filters: { build: "Blink" } });
  expect(selected.summary).toEqual({ total: 4, wins: 1, losses: 0, ties: 2, avgDurationSec: 600 });
  const none = await service.list("owner", { view: "detector", withSummary: true, filters: { build: "Planned" } });
  expect(none.summary).toEqual({ total: 0, wins: 0, losses: 0, ties: 0, avgDurationSec: null });
});

test("facets ignore active filters, stay owner-scoped and cache ten minutes", async () => {
  await db.games.insertMany([game("1"), game("2", { userId: "other", map: "Private other map" }), ...Array.from({ length: 34 }, (_, index) => game(String(index + 10), { date: new Date(), map: `Map ${String(index).padStart(2, "0")}` }))]);
  const first = await service.list("owner", { withSummary: true, result: "loss" });
  expect(first.facets.maps).toHaveLength(30); expect(first.facets.maps).not.toContain("Private other map");
  await db.games.insertMany([game("3", { map: "Newest map" }), game("4", { map: "Newest map" })]);
  expect((await service.list("owner", { withSummary: true, matchup: "PvZ" })).facets).toEqual(first.facets);
  const now = Date.now(); jest.spyOn(Date, "now").mockReturnValue(now + FACET_TTL_MS + 1);
  const refreshed = await service.list("owner", { withSummary: true }); expect(refreshed.facets.maps[0]).toBe("Newest map");
});

test("a facet failure is recoverable without dropping the filtered record or page", async () => {
  await db.games.insertOne(game("1"));
  const aggregate = db.games.aggregate.bind(db.games);
  jest.spyOn(db.games, "aggregate").mockImplementation((raw) => { const pipeline = /** @type {any[]} */ (raw); return pipeline.some((stage) => stage.$facet) ? { toArray: () => Promise.reject(new Error("facet temporarily unavailable")) } : aggregate(pipeline); });
  const result = await service.list("owner", { withSummary: true }); expect(result.summary.total).toBe(1); expect(result.items).toHaveLength(1); expect(result).not.toHaveProperty("facets");
  expect(service.archiveFacets.size).toBe(0);
});

test("the owner facet LRU is bounded and promotes recent reads", async () => {
  const games = /** @type {any} */ ({ aggregate: jest.fn(() => ({ toArray: async () => [{ maps: [], matchups: [] }] })) });
  const cache = new Map();
  for (let i = 0; i < FACET_CACHE_MAX; i++) await cachedFacets(games, String(i), cache);
  await cachedFacets(games, "0", cache); await cachedFacets(games, "new", cache);
  expect(cache.size).toBe(FACET_CACHE_MAX); expect(cache.has("0")).toBe(true); expect(cache.has("1")).toBe(false); expect(games.aggregate).toHaveBeenCalledTimes(FACET_CACHE_MAX + 1);
});
