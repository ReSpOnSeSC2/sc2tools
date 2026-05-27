// @ts-nocheck
"use strict";

/**
 * Migration: 2026-05-27-backfill-is-ladder-map.
 *
 * Classifies historical games as ladder / non-ladder by matching their
 * stored map name against the live pool, so the FilterBar's ladder
 * filter works on data uploaded before the ingest stamp shipped.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { buildLadderMapSet } = require("../src/util/isLadderMap");
const {
  backfillUser,
} = require("../src/db/migrations/2026-05-27-backfill-is-ladder-map");

describe("backfill-is-ladder-map migration", () => {
  let mongo;
  let db;
  // Pool covers a 1v1 map and a team map; matching is name-normalized
  // so the "LE" edition tag on the stored game name still resolves.
  const ladderSet = buildLadderMapSet(["Site Delta", "Concord"]);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "backfill_ladder" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  const mk = (gameId, map, extra = {}) => ({
    userId: "u1",
    gameId,
    date: new Date("2026-05-01T00:00:00.000Z"),
    result: "Victory",
    myRace: "Zerg",
    map,
    ...extra,
  });

  test("stamps isLadderMap by map name, skipping already-correct rows", async () => {
    await db.games.insertMany([
      mk("g1", "Site Delta LE"), // ladder (edition tag tolerated)
      mk("g2", "Some Arcade Map"), // non-ladder
      mk("g3", "Concord"), // team-ladder map -> ladder
      mk("g4", "Site Delta", { isLadderMap: true }), // already correct
    ]);

    const r = await backfillUser(db.db, "u1", ladderSet, {
      dryRun: false,
      batch: 500,
    });
    expect(r.scanned).toBe(4);
    expect(r.planned).toBe(3); // g4 skipped

    const rows = Object.fromEntries(
      (await db.games.find({ userId: "u1" }).toArray()).map((g) => [
        g.gameId,
        g.isLadderMap,
      ]),
    );
    expect(rows).toEqual({ g1: true, g2: false, g3: true, g4: true });
  });

  test("dry-run plans changes without writing", async () => {
    await db.games.insertMany([mk("g1", "Site Delta"), mk("g2", "Arcade")]);
    const r = await backfillUser(db.db, "u1", ladderSet, {
      dryRun: true,
      batch: 500,
    });
    expect(r.planned).toBe(2);
    expect(r.written).toBe(0);
    const g1 = await db.games.findOne({ gameId: "g1" });
    expect(g1.isLadderMap).toBeUndefined();
  });

  test("is idempotent on a second pass", async () => {
    await db.games.insertMany([mk("g1", "Site Delta"), mk("g2", "Arcade")]);
    await backfillUser(db.db, "u1", ladderSet, { dryRun: false, batch: 500 });
    const second = await backfillUser(db.db, "u1", ladderSet, {
      dryRun: false,
      batch: 500,
    });
    expect(second.planned).toBe(0);
    expect(second.written).toBe(0);
  });
});
