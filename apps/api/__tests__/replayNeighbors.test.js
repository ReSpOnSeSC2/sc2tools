"use strict";

const { ObjectId } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
/** @type {import('mongodb-memory-server').MongoMemoryServer} */ let mongo;
/** @type {any} */ let db;
/** @type {import('../src/services/replayLibrary').ReplayLibraryService} */ let service;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); db = await connect({ uri: mongo.getUri(), dbName: "replay_neighbors" }); service = new ReplayLibraryService(db); });
afterEach(async () => { await db.games.deleteMany({}); });
afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });
function game(/** @type {number} */ n, /** @type {Record<string, any>} */ overrides = {}) {
  return { _id: new ObjectId(n.toString(16).padStart(24, "0")), userId: "owner", gameId: `game-${n}`, date: new Date("2026-10-21T12:00:00Z"), result: "Victory", map: "Alcyone LE", myRace: "Protoss", opponent: { race: "Zerg", displayName: "Fixture rival" }, myBuild: "Blink", ...overrides };
}

test("neighbors use filtered public labels and _id ties, returning working game IDs only", async () => {
  await db.games.insertMany([game(1), game(2, { myBuild: "Planned", buildIntent: { status: "confirmed", applied: true, build: { name: "Planned" }, detected: { name: "Blink" } } }), game(3, { date: new Date("2026-10-22T12:00:00Z") }), game(4, { result: "Defeat" }), game(5, { userId: "other" }), game(6, { isResumedFromReplay: true })]);
  const options = { filters: { map: "Alcyone", build: "Blink" }, result: "win", matchup: "PvZ", search: "rival" };
  expect(await service.neighbors("owner", "game-2", options)).toEqual({ olderGameId: "game-1", newerGameId: "game-3" });
  expect(await service.neighbors("owner", "game-1", options)).toEqual({ olderGameId: null, newerGameId: "game-2" });
  expect(await service.neighbors("owner", "game-3", options)).toEqual({ olderGameId: "game-2", newerGameId: null });
  for (const id of ["game-4", "game-5", "game-6", "missing"]) expect(await service.neighbors("owner", id, options)).toEqual({ olderGameId: null, newerGameId: null });
  for (const id of Object.values(await service.neighbors("owner", "game-2", options))) if (id) expect((await service.getDetail("owner", id))?.game.gameId).toBe(id);
  expect(await service.neighbors("owner", "game-2", { filters: { build: "Planned" } })).toEqual({ olderGameId: null, newerGameId: null });
});

test("the neighbor comparator agrees with both list orders across historical BSON date types", async () => {
  await db.games.insertMany([game(1, { date: null }), game(2, { date: Date.parse("2026-10-21T12:00:00Z") }), game(3, { date: "2026-10-21T12:00:00Z" }), game(4), game(5)]);
  const page = await service.list("owner", { sort: "date_asc", view: "detector" }); const ids = page.items.map((item) => item.gameId);
  expect(ids).toEqual(["game-1", "game-2", "game-3", "game-4", "game-5"]);
  for (let i = 0; i < ids.length; i++) expect(await service.neighbors("owner", ids[i])).toEqual({ olderGameId: ids[i - 1] || null, newerGameId: ids[i + 1] || null });
});
