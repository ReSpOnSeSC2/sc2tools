// @ts-nocheck
"use strict";

/**
 * Startup ladder-map backfill job. Classifies historical games (those
 * missing isLadderMap) against the live pool on boot, idempotently.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const {
  buildLadderMapBackfillJob,
} = require("../src/jobs/ladderMapBackfillJob");

const logger = pino({ level: "silent" });

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

  test("stamps only games missing isLadderMap, leaving stamped ones untouched", async () => {
    await db.games.insertMany([
      mk("g1", "Site Delta LE"), // missing -> ladder true
      mk("g2", "Arcade Thing"), // missing -> false
      mk("g3", "Concord"), // missing, team map -> true
      mk("g4", "Whatever", { isLadderMap: true }), // already stamped, skip
    ]);
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub(["Site Delta"], ["Concord"]),
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    expect(r.scanned).toBe(3); // g4 not scanned (has the field)

    const rows = Object.fromEntries(
      (await db.games.find({}).toArray()).map((g) => [g.gameId, g.isLadderMap]),
    );
    expect(rows).toEqual({ g1: true, g2: false, g3: true, g4: true });
  });

  test("skips entirely when no game is missing the field (idempotent)", async () => {
    await db.games.insertMany([
      mk("g1", "Site Delta", { isLadderMap: true }),
      mk("g2", "Arcade", { isLadderMap: false }),
    ]);
    let getCalls = 0;
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: {
        get: async () => {
          getCalls += 1;
          return { maps: ["Site Delta"], teamMaps: [] };
        },
      },
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.remaining).toBe(0);
    // Pre-count short-circuits before any pool fetch.
    expect(getCalls).toBe(0);
  });

  test("refuses to write when the resolved pool is empty", async () => {
    await db.games.insertMany([mk("g1", "Site Delta")]);
    const job = buildLadderMapBackfillJob({
      db,
      ladderMapPool: poolStub([], []),
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.written).toBe(0);
    const g1 = await db.games.findOne({ gameId: "g1" });
    expect(g1.isLadderMap).toBeUndefined(); // left unclassified, not false
  });

  test("refuses to write against the stale fallback pool", async () => {
    await db.games.insertMany([mk("g1", "Site Delta")]);
    const job = buildLadderMapBackfillJob({
      db,
      // Non-empty list, but source=fallback (Liquipedia unreachable +
      // no cached file) — classifying against it would mislabel games.
      ladderMapPool: {
        get: async () => ({ maps: ["Site Delta"], teamMaps: [], source: "fallback" }),
      },
      logger,
    });
    const r = await job.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.written).toBe(0);
    const g1 = await db.games.findOne({ gameId: "g1" });
    expect(g1.isLadderMap).toBeUndefined();
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
    await db.games.insertMany([mk("g1", "Site Delta")]);
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
