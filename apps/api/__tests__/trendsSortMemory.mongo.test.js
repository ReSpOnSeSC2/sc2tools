// @ts-nocheck
"use strict";

/**
 * Atlas Flex caps an in-memory sort at 32 MB and cannot spill to disk. A
 * Trends pipeline that sorts a player's whole history in memory therefore
 * fails once that history is large enough (production did at about 14k
 * games). These tests apply a far smaller cap to a history whose
 * whole-document sort is well past it, then run the verified-MMR, MMR
 * progression and session momentum charts.
 */

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const {
  netMmrPairStages,
  NET_MMR_WINDOW_INDEX,
} = require("../src/services/trendsNetMmr");
const { MOMENTUM_ORDER_INDEX } = require("../src/services/trendsInsights");

/** @param {Record<string, any>} plan explained aggregation */
function planSummary(plan) {
  return {
    cursor: JSON.stringify(plan.stages[0].$cursor.queryPlanner.winningPlan),
    stages: plan.stages.map((stage) => Object.keys(stage)[0]),
  };
}

// Small enough that each chart's old whole-history sort fails here.
const SORT_CAP_BYTES = 512 * 1024;
const GAMES = 600;
// Stands in for the heavy per-game fields (spatial data, build logs).
const PADDING = "x".repeat(4000);

/**
 * Alternating ranked wins and losses vs one Zerg opponent: a win at 4000
 * is followed by 4010 (+10), and a loss at 4010 by 4000 (-10).
 *
 * @param {number} i
 */
function game(i) {
  return {
    userId: "u1",
    gameId: `g${String(i).padStart(4, "0")}`,
    date: new Date(Date.UTC(2026, 0, 1) + i * 60 * 60 * 1000),
    result: i % 2 === 0 ? "Victory" : "Defeat",
    myRace: "Protoss",
    myLadderRace: "Protoss",
    myMmr: 4000 + (i % 2) * 10,
    myMmrSource: "replay",
    myToonHandle: "1-S2-1-100",
    isLadderGame: true,
    playerCount: 2,
    map: "Test LE",
    durationSec: 600,
    opponent: {
      pulseId: "1-S2-1-7",
      toonHandle: "1-S2-1-7",
      displayName: `Foe-${i}`,
      race: "Zerg",
    },
    spatial: { padding: PADDING },
  };
}

describe("Trends charts under a Flex-like in-memory sort cap", () => {
  let mongo;
  let db;
  let admin;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: {
        args: [
          "--setParameter", `internalQueryMaxBlockingSortMemoryUsageBytes=${SORT_CAP_BYTES}`,
          "--setParameter", "allowDiskUseByDefault=false",
        ],
      },
    });
    db = await connect({ uri: mongo.getUri(), dbName: "trends_sort_memory" });
    admin = await MongoClient.connect(mongo.getUri());
    const params = await admin.db("admin").command({
      getParameter: 1,
      internalQueryMaxBlockingSortMemoryUsageBytes: 1,
      allowDiskUseByDefault: 1,
    });
    expect(params).toMatchObject({
      internalQueryMaxBlockingSortMemoryUsageBytes: SORT_CAP_BYTES,
      allowDiskUseByDefault: false,
    });
    service = new AggregationsService(db);
    await db.games.insertMany(Array.from({ length: GAMES }, (_, i) => game(i)));
  });

  afterAll(async () => {
    if (admin) await admin.close();
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("a whole-history sort of these games exceeds the cap", async () => {
    // durationSec is in no index, so the sort has to hold whole games.
    await expect(
      db.games
        .aggregate([{ $match: { userId: "u1" } }, { $sort: { durationSec: 1, gameId: 1 } }])
        .toArray(),
    ).rejects.toMatchObject({ codeName: "QueryExceededMemoryLimitNoDiskUseAllowed" });
  });

  test("net MMR by matchup pairs the whole history", async () => {
    const out = await service.netMmrByMatchup("u1", {}, {});
    expect(out.matchups).toEqual([
      expect.objectContaining({ race: "Z", netMmr: 10, pairs: 599, wins: 300, losses: 299 }),
    ]);
    expect(out.dropped.terminalGame).toBe(1);
  });

  test("net MMR by opponent keeps the newest kept game's name", async () => {
    const out = await service.netMmrByOpponent("u1", {}, {});
    expect(out.items).toHaveLength(1);
    // g0599 is the terminal game, so g0598 is the newest kept pair.
    expect(out.items[0]).toMatchObject({ netMmr: 10, pairs: 599, displayName: "Foe-598" });
  });

  test("MMR progression opens and closes each bucket on the right games", async () => {
    const out = await service.mmrProgression("u1", { interval: "month", tz: "UTC" }, {});
    expect(out.points).toHaveLength(1);
    expect(out.points[0]).toMatchObject({ openMmr: 4000, closeMmr: 4010 });
    expect(out.latest.mmr).toBe(4010);
  });

  test("the net-MMR window's order comes from its index, not an in-memory sort", async () => {
    const indexes = await db.games.indexes();
    expect(indexes.find((ix) => ix.name === NET_MMR_WINDOW_INDEX.name).key)
      .toEqual(NET_MMR_WINDOW_INDEX.key);
    // The history $match, the window and the display $match.
    const stages = netMmrPairStages(service._trendsDeps(), "u1", {}).slice(0, 3);
    const plan = planSummary(await db.games.aggregate(stages).explain("queryPlanner"));
    expect(plan.cursor).toContain(`"indexName":"${NET_MMR_WINDOW_INDEX.name}"`);
    expect(plan.cursor).not.toContain('"stage":"SORT"');
    expect(plan.stages).not.toContain("$sort");
  });

  test("session momentum follows one session and session breaks", async () => {
    // An hour apart: one session under a 90-minute gap, one game per
    // session under a 15-minute gap. Results alternate from a win.
    const joined = await service.momentum("u1", {}, { sessionGapMinutes: 90 });
    expect(joined.baseline).toMatchObject({ wins: 300, losses: 300, total: 600 });
    expect(joined.postWin).toMatchObject({ wins: 0, losses: 300, total: 300 });
    expect(joined.postLoss).toMatchObject({ wins: 299, losses: 0, total: 299 });
    expect(joined.sessionPositions.slice(0, 2).map((row) => [row.pos, row.wins, row.losses]))
      .toEqual([[1, 1, 0], [2, 0, 1]]);
    const split = await service.momentum("u1", {}, { sessionGapMinutes: 15 });
    expect(split.postWin.total + split.postLoss.total).toBe(0);
    expect(split.sessionPositions.map((row) => [row.pos, row.total])).toEqual([[1, 600]]);
  });

  test("session momentum's order comes from its index, with no sort stage", async () => {
    const indexes = await db.games.indexes();
    expect(indexes.find((ix) => ix.name === MOMENTUM_ORDER_INDEX.name).key)
      .toEqual(MOMENTUM_ORDER_INDEX.key);
    const aggregate = jest.spyOn(db.games, "aggregate");
    await service.momentum("u1", { since: new Date(Date.UTC(2026, 0, 2)) }, { sessionGapMinutes: 90 });
    const [pipeline, options] = aggregate.mock.calls.at(-1);
    aggregate.mockRestore();
    const plan = planSummary(await db.games.aggregate(pipeline, options).explain("queryPlanner"));
    expect(plan.cursor).toContain(`"indexName":"${MOMENTUM_ORDER_INDEX.name}"`);
    expect(plan.cursor).not.toContain('"stage":"SORT"');
    // Both windows run on the index order: neither needs its own sort.
    expect(plan.stages.filter((stage) => stage === "$_internalSetWindowFields")).toHaveLength(2);
    expect(plan.stages).not.toContain("$sort");
  });
});
