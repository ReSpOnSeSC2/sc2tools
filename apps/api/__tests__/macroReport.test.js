// @ts-nocheck
"use strict";

/**
 * Macro Report aggregation (services/macroReport.js) against real
 * Mongo, plus the games-list click-through filters (leak / macro_min /
 * macro_max) it depends on:
 *
 *   1. Score buckets tile correctly and carry win rates.
 *   2. Leak ledger sums mineral costs, computes with/without win
 *      rates, and sorts by total cost.
 *   3. Trend halves split on the date midpoint and are suppressed for
 *      small/short samples.
 *   4. Segments group by matchup / duration bucket / build.
 *   5. gamesMatchStage honours leak + macroMin/macroMax so bucket and
 *      leak rows can open a matching game list.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { AggregationsService } = require("../src/services/aggregations");
const { MacroReportService } = require("../src/services/macroReport");
const { parseFilters, gamesMatchStage } = require("../src/util/parseQuery");

describe("macro report aggregation", () => {
  let mongo;
  let db;
  let games;
  let aggregations;
  let macroReport;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_macro_report",
    });
    games = new GamesService(db);
    aggregations = new AggregationsService(db);
    macroReport = new MacroReportService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function game(gameId, {
    score,
    result = "Victory",
    date = new Date("2026-05-01T12:00:00Z"),
    oppRace = "Zerg",
    durationSec = 700,
    build = "Carrier Rush",
    leaks,
  } = {}) {
    return {
      gameId,
      date,
      result,
      myRace: "Protoss",
      map: "Site Delta",
      durationSec,
      myBuild: build,
      opponent: { displayName: "opp", race: oppRace },
      ...(typeof score === "number" ? { macroScore: score } : {}),
      ...(leaks
        ? { macroBreakdown: { raw: { sq: 80 }, top_3_leaks: leaks } }
        : {}),
    };
  }

  const supplyLeak = (cost) => ({
    name: "Supply Blocked",
    detail: "blocked",
    quantity: 30,
    mineral_cost: cost,
    penalty: 6,
  });
  const floatLeak = (cost) => ({
    name: "Mineral Float",
    detail: "float",
    quantity: 3,
    mineral_cost: cost,
    penalty: 2,
  });

  test("score buckets tile and carry win rates", async () => {
    await games.upsert("u1", game("g1", { score: 55, result: "Defeat" }));
    await games.upsert("u1", game("g2", { score: 62, result: "Victory" }));
    await games.upsert("u1", game("g3", { score: 78, result: "Victory" }));
    await games.upsert("u1", game("g4", { score: 78, result: "Defeat" }));
    await games.upsert("u1", game("g5", { score: 92, result: "Victory" }));
    await games.upsert("u1", game("g6", {})); // unscored

    const out = await macroReport.report("u1", {});
    expect(out.ok).toBe(true);
    expect(out.gamesTotal).toBe(6);
    expect(out.gamesScored).toBe(5);

    const byKey = Object.fromEntries(out.scoreBuckets.map((b) => [b.key, b]));
    expect(byKey.lt60.games).toBe(1);
    expect(byKey.lt60.winRate).toBe(0);
    expect(byKey["60s"].games).toBe(1);
    expect(byKey["70s"].games).toBe(2);
    expect(byKey["70s"].winRate).toBe(0.5);
    expect(byKey["80s"].games).toBe(0);
    expect(byKey["80s"].winRate).toBeNull();
    expect(byKey["90plus"].games).toBe(1);
  });

  test("leak ledger: costs, with/without win rates, sort order", async () => {
    // 2 games with supply block (1 win, 1 loss), 1 with float (win),
    // 1 clean scored win.
    await games.upsert("u1", game("g1", {
      score: 70, result: "Victory", leaks: [supplyLeak(400)],
    }));
    await games.upsert("u1", game("g2", {
      score: 60, result: "Defeat", leaks: [supplyLeak(600)],
    }));
    await games.upsert("u1", game("g3", {
      score: 75, result: "Victory", leaks: [floatLeak(300)],
    }));
    await games.upsert("u1", game("g4", { score: 90, result: "Victory" }));

    const out = await macroReport.report("u1", {});
    expect(out.leaks.map((l) => l.name)).toEqual([
      "Supply Blocked",
      "Mineral Float",
    ]);

    const sb = out.leaks[0];
    expect(sb.games).toBe(2);
    expect(sb.totalMinerals).toBe(1000);
    expect(sb.mineralsPerGame).toBe(500);
    expect(sb.winRateWith).toBe(0.5);
    // Without supply block: g3 + g4, both wins.
    expect(sb.winRateWithout).toBe(1);
    expect(sb.share).toBe(0.5);
  });

  test("trend halves split on the midpoint; suppressed when sample too small", async () => {
    // 12 scored games across 30 days: older half leaks heavily, newer
    // half is clean — deltaPerGame must come out negative (improving).
    const docs = [];
    for (let i = 0; i < 6; i += 1) {
      docs.push(game(`old${i}`, {
        score: 60,
        date: new Date(Date.UTC(2026, 3, 1 + i, 12)),
        leaks: [supplyLeak(600)],
      }));
      docs.push(game(`new${i}`, {
        score: 80,
        date: new Date(Date.UTC(2026, 3, 25 + i, 12)),
      }));
    }
    for (const d of docs) await games.upsert("u1", d);

    const out = await macroReport.report("u1", {});
    expect(out.trend).not.toBeNull();
    expect(out.trend.previousGames).toBe(6);
    expect(out.trend.currentGames).toBe(6);
    expect(out.trend.previousAvgScore).toBe(60);
    expect(out.trend.currentAvgScore).toBe(80);

    const sb = out.leaks.find((l) => l.name === "Supply Blocked");
    expect(sb.trend).not.toBeNull();
    expect(sb.trend.previousPerGame).toBe(600);
    expect(sb.trend.currentPerGame).toBe(0);
    expect(sb.trend.deltaPerGame).toBe(-600);

    // Small sample: trend suppressed.
    await db.games.deleteMany({});
    await games.upsert("u1", game("a", { score: 70, leaks: [supplyLeak(100)] }));
    await games.upsert("u1", game("b", { score: 80 }));
    const small = await macroReport.report("u1", {});
    expect(small.trend).toBeNull();
    expect(small.leaks[0].trend).toBeNull();
  });

  test("segments group by matchup, duration bucket, and build", async () => {
    await games.upsert("u1", game("g1", {
      score: 80, oppRace: "Zerg", durationSec: 300, build: "Carrier Rush",
    }));
    await games.upsert("u1", game("g2", {
      score: 60, result: "Defeat", oppRace: "Terran", durationSec: 900,
      build: "Blink Stalkers",
    }));
    await games.upsert("u1", game("g3", {
      score: 70, oppRace: "Zerg", durationSec: 1500, build: "Carrier Rush",
    }));

    const out = await macroReport.report("u1", {});

    const vz = out.segments.matchup.find((s) => s.label === "vs Z");
    expect(vz.games).toBe(2);
    expect(vz.avgScore).toBe(75);
    expect(vz.winRate).toBe(1);

    const byKey = Object.fromEntries(
      out.segments.duration.map((s) => [s.key, s]),
    );
    expect(byKey.lt6.games).toBe(1);
    expect(byKey["14to20"].games).toBe(1);
    expect(byKey["20plus"].games).toBe(1);
    expect(byKey["6to10"].games).toBe(0);

    const carrier = out.segments.build.find((s) => s.key === "Carrier Rush");
    expect(carrier.games).toBe(2);
    expect(carrier.avgScore).toBe(75);
  });

  test("games-list click-through filters: leak + macro score bounds", async () => {
    await games.upsert("u1", game("g1", {
      score: 62, leaks: [supplyLeak(400)],
    }));
    await games.upsert("u1", game("g2", {
      score: 71, leaks: [floatLeak(200)],
    }));
    await games.upsert("u1", game("g3", { score: 70 }));

    const leakFilters = parseFilters({ leak: "Supply Blocked" });
    const leakRows = await db.games
      .find(gamesMatchStage("u1", leakFilters))
      .toArray();
    expect(leakRows.map((g) => g.gameId)).toEqual(["g1"]);

    // 70–79 bucket: inclusive min, exclusive max.
    const bucketFilters = parseFilters({ macro_min: "70", macro_max: "80" });
    const bucketRows = await db.games
      .find(gamesMatchStage("u1", bucketFilters))
      .sort({ gameId: 1 })
      .toArray();
    expect(bucketRows.map((g) => g.gameId)).toEqual(["g2", "g3"]);

    // And through the full gamesList service path.
    const list = await aggregations.gamesList(
      "u1",
      parseFilters({ leak: "Supply Blocked" }),
      {},
    );
    expect(list.total).toBe(1);
    expect(list.games[0].id).toBe("g1");
  });
});
