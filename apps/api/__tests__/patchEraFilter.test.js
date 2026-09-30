// @ts-nocheck
"use strict";

/**
 * The analyzer's patch filter (``patch_era``). 5.0.17's notes came out on
 * 30 Sep 2026, but the ladder stays on 5.0.16 until the patch goes live, so
 * the "After 5.0.17" preset cannot be a date alone: each game is kept by
 * its own version (util/patchEra.js): a 5.0.17 PTR game is 12-worker, a live
 * 5.0.16 game is 8-worker, and a game with no version falls back to its
 * date (8-worker from 5.0.16 until 5.0.17 reaches the live ladder). Covers parseFilters, gamesMatchStage against a
 * real Mongo, the Opponents list and an opponent's profile.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { gamesMatchStage, parseFilters } = require("../src/util/parseQuery");
const { OpponentsService } = require("../src/services/opponents");
const { PATCH_5_0_16_RELEASE, PATCH_5_0_17_RELEASE } = require("../src/util/patchEra");

const USER = "patch-era-user";
const R16 = PATCH_5_0_16_RELEASE.toISOString();
const R17 = PATCH_5_0_17_RELEASE.toISOString();
const TWELVE_WORKER = { since: R17, patch_era: "after" };
const EIGHT_WORKER = { since: R16, patch_era: "before" };

/** One opponent per game, so the Opponents list shows which games count. */
const GAMES = [
  // Played after the 5.0.17 notes, still on 5.0.16: the reported bug.
  { gameId: "g16-revert-day", gameVersion: "5.0.16.97425", gameBuild: 97425, date: "2026-09-30T21:00:00Z" },
  { gameId: "g16-july", gameVersion: "5.0.16.97425", gameBuild: 97425, date: "2026-07-01T12:00:00Z" },
  { gameId: "g17", gameVersion: "5.0.17.98000", gameBuild: 98000, date: "2026-10-08T12:00:00Z" },
  { gameId: "g15", gameVersion: "5.0.15.96883", gameBuild: 96883, date: "2026-05-01T12:00:00Z" },
  // A 5.0.17 PTR game (12 workers), played the day the notes came out.
  { gameId: "ptr17", gameVersion: "5.0.17.98123", gameBuild: 98123, date: "2026-09-30T22:00:00Z", toon: "98-S2-1-" },
  // No version or build: the date decides, and live is on 5.0.16 until
  // 5.0.17 ships.
  { gameId: "date-only-oct", date: "2026-10-02T12:00:00Z" },
  { gameId: "date-only-aug", date: "2026-08-02T12:00:00Z" },
];

function gameRow(g, i) {
  const pulseId = `${g.toon || "1-S2-1-"}${1000 + i}`;
  return {
    userId: USER,
    gameId: g.gameId,
    ...(g.gameVersion ? { gameVersion: g.gameVersion, gameBuild: g.gameBuild } : {}),
    date: new Date(g.date),
    result: "Victory",
    map: "Site Delta LE",
    myRace: "Zerg",
    myBuild: "ZvP - Hatch First",
    durationSec: 600,
    opponent: { pulseId, toonHandle: pulseId, displayName: g.gameId, race: "Protoss" },
  };
}

describe("patch_era filter", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "patch_era_filter" });
    await db.games.insertMany(GAMES.map(gameRow));
    await db.opponents.insertMany(GAMES.map((g, i) => {
      const row = gameRow(g, i);
      return {
        userId: USER,
        pulseId: row.opponent.pulseId,
        toonHandle: row.opponent.toonHandle,
        displayNameSample: g.gameId,
        race: "P",
        gameCount: 1,
        wins: 1,
        losses: 0,
        firstSeen: row.date,
        lastSeen: row.date,
      };
    }));
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function matchedIds(query) {
    const rows = await db.games
      .find(gamesMatchStage(USER, parseFilters(query)), { projection: { gameId: 1 } })
      .toArray();
    return rows.map((r) => r.gameId).sort();
  }

  test("parseFilters keeps after/before and drops anything else", () => {
    expect(parseFilters({ patch_era: "after" }).patchEra).toBe("after");
    expect(parseFilters({ patch_era: "before" }).patchEra).toBe("before");
    for (const raw of ["", "AFTER", "all", "5.0.17", ["after"], undefined]) {
      expect(parseFilters({ patch_era: raw })).not.toHaveProperty("patchEra");
    }
  });

  test("the patch clause sits in $and beside the region $or", () => {
    const stage = gamesMatchStage(USER, parseFilters({ ...TWELVE_WORKER, regions: "NA" }));
    expect(Array.isArray(stage.$or)).toBe(true);
    expect(stage.$and).toHaveLength(1);
    expect(stage.date).toEqual({ $gte: PATCH_5_0_17_RELEASE });
  });

  test("After 5.0.17 keeps 12-worker games only, not 5.0.16 games played after the notes", async () => {
    expect(await matchedIds(TWELVE_WORKER)).toEqual(["g17", "ptr17"]);
    // The date alone is what the preset used to send.
    expect(await matchedIds({ since: R17 })).toContain("g16-revert-day");
  });

  test("5.0.16 keeps every 5.0.16 game, including those after the notes", async () => {
    expect(await matchedIds(EIGHT_WORKER)).toEqual(["date-only-aug", "date-only-oct", "g16-july", "g16-revert-day"]);
  });

  test("the Opponents list leaves out opponents met only on 5.0.16", async () => {
    const svc = new OpponentsService(db, Buffer.alloc(32, 1));
    const names = async (query) => {
      const { items } = await svc.list(USER, { filters: parseFilters(query) });
      return items.map((o) => o.displayNameSample).sort();
    };
    expect(await names(TWELVE_WORKER)).toEqual(["g17", "ptr17"]);
    const eightWorker = ["date-only-aug", "date-only-oct", "g16-july", "g16-revert-day"];
    expect(await names(EIGHT_WORKER)).toEqual(eightWorker);
    // A patch filter alone still leaves the lifetime fast path.
    expect(await names({ patch_era: "before" })).toEqual(eightWorker);
  });

  test("an opponent's profile counts only the selected patch's games", async () => {
    const svc = new OpponentsService(db, Buffer.alloc(32, 1));
    const pulseId = gameRow(GAMES[0], 0).opponent.pulseId;
    const after = await svc.get(USER, pulseId, { filters: parseFilters(TWELVE_WORKER) });
    expect(after.games).toEqual([]);
    expect(after.totals).toMatchObject({ total: 0 });
    const before = await svc.get(USER, pulseId, { filters: parseFilters(EIGHT_WORKER) });
    expect(before.games.map((g) => g.id)).toEqual(["g16-revert-day"]);
    expect(before.totals).toMatchObject({ wins: 1, total: 1 });
    // The PTR opponent is a 12-worker game.
    const ptr = gameRow(GAMES[4], 4).opponent.pulseId;
    expect((await svc.get(USER, ptr, { filters: parseFilters(TWELVE_WORKER) })).games.map((g) => g.id)).toEqual(["ptr17"]);
    expect((await svc.get(USER, ptr, { filters: parseFilters(EIGHT_WORKER) })).games).toEqual([]);
  });
});
