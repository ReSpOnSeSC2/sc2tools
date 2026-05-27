// @ts-nocheck
"use strict";

/**
 * Startup ladder-map (re)classification job. Stamps isLadderMap +
 * isLadderMapV on games not yet at the current classifier version,
 * matching against the all-seasons set. Version-gated so it self-skips
 * once the dataset is current and re-runs once after a version bump.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const {
  buildLadderMapBackfillJob,
} = require("../src/jobs/ladderMapBackfillJob");
const {
  LADDER_CLASSIFY_VERSION,
} = require("../src/util/isLadderMap");

const logger = pino({ level: "silent" });
const V = LADDER_CLASSIFY_VERSION;

function poolStub(maps, teamMaps = []) {
  return { get: async () => ({ maps, teamMaps, source: "liquipedia" }) };
}

describe("ladderMapBackfillJob", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "ladder_backfill_job" });
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
    date: new Date("2026-05-01"),
    result: "Victory",
    myRace: "Zerg",
    map,
    ...extra,
  });

  test("classifies games not at the current version and stamps isLadderMapV", async () => {
    await db.games.insertMany([
      mk("g1", "Site Delta LE"), // no version -> classify true
      mk("g2", "My Arcade Box"), // no version -> false
      mk("g3", "Concord"), // team map -> true
      mk("g4", "Whatever", { isLadderMap: true, isLadderMapV: V }), // current, skip
    ]);
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub(["Site Delta"], ["Concord"]),
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    expect(r.scanned).toBe(3); // g4 already at current version

    const rows = Object.fromEntries(
      (await db.games.find({}).toArray()).map((g) => [g.gameId, g.isLadderMap]),
    );
    expect(rows).toEqual({ g1: true, g2: false, g3: true, g4: true });
    // Processed rows are stamped with the current version.
    const g1 = await db.games.findOne({ gameId: "g1" });
    expect(g1.isLadderMapV).toBe(V);
  });

  test("reclassifies a STALE game whose boolean changes (retired map fix)", async () => {
    // Game classified by an older version as custom (false), on a map
    // that the all-seasons list knows is a real ladder map.
    await db.games.insertOne(
      mk("old", "Catalyst LE", { isLadderMap: false, isLadderMapV: 1 }),
    );
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub(["Site Delta"]), // current pool omits Catalyst
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    const g = await db.games.findOne({ gameId: "old" });
    expect(g.isLadderMap).toBe(true); // flipped custom -> ladder
    expect(g.isLadderMapV).toBe(V);
  });

  test("prefers a re-ingested game's isLadderGame flag over the map proxy", async () => {
    // Custom game played ON a ladder map: the proxy would say ladder,
    // but the authoritative flag (present after a Resync) says custom.
    await db.games.insertOne(
      mk("rs", "Site Delta LE", { isLadderGame: false, isLadderMapV: 1 }),
    );
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub(["Site Delta"]),
      logger,
    });
    await job.runOnce();
    const g = await db.games.findOne({ gameId: "rs" });
    expect(g.isLadderMap).toBe(false); // flag wins over the proxy
    expect(g.isLadderMapV).toBe(V);
  });

  test("uses the baked-in list even when the live pool fetch throws", async () => {
    await db.games.insertOne(mk("g1", "Acropolis LE")); // retired ladder map
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: {
        get: async () => {
          throw new Error("liquipedia down");
        },
      },
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    const g1 = await db.games.findOne({ gameId: "g1" });
    expect(g1.isLadderMap).toBe(true);
    expect(g1.isLadderMapV).toBe(V);
  });

  test("skips cheaply when every game is already at the current version", async () => {
    await db.games.insertMany([
      mk("g1", "Site Delta", { isLadderMap: true, isLadderMapV: V }),
      mk("g2", "Arcade", { isLadderMap: false, isLadderMapV: V }),
    ]);
    let getCalls = 0;
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: {
        get: async () => {
          getCalls += 1;
          return { maps: ["Site Delta"], teamMaps: [], source: "liquipedia" };
        },
      },
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.remaining).toBe(0);
    expect(getCalls).toBe(0); // pre-count short-circuits before the pool fetch
  });

  test("a second runOnce is a no-op after the first completes", async () => {
    await db.games.insertMany([mk("g1", "Site Delta"), mk("g2", "Arcade")]);
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub(["Site Delta"]),
      logger,
    });
    await job.runOnce();
    const second = await job.runOnce();
    expect(second.skipped).toBe(true);
    expect(second.remaining).toBe(0);
  });

  test("SC2TOOLS_LADDER_BACKFILL_DISABLED=1 makes start() a no-op", async () => {
    await db.games.insertOne(mk("g1", "Site Delta"));
    const prev = process.env.SC2TOOLS_LADDER_BACKFILL_DISABLED;
    process.env.SC2TOOLS_LADDER_BACKFILL_DISABLED = "1";
    try {
      const job = buildLadderMapBackfillJob({
        db,
        ladderMapPool: poolStub(["Site Delta"]),
        logger,
      });
      job.start();
      await job.stop();
      const g1 = await db.games.findOne({ gameId: "g1" });
      expect(g1.isLadderMap).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SC2TOOLS_LADDER_BACKFILL_DISABLED;
      else process.env.SC2TOOLS_LADDER_BACKFILL_DISABLED = prev;
    }
  });
});
