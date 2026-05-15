// @ts-nocheck
"use strict";

/**
 * BuildsMmrStatsService — real-Mongo integration tests for the
 * MMR-bracketed build / strategy analytics that power the new
 * analyzer charts.
 *
 * No mock data: every test inserts real game documents and exercises
 * the same aggregation pipelines production runs. The fixtures
 * deliberately span multiple MMR buckets, multiple builds,
 * win-and-loss outcomes, and a couple of edge cases (missing
 * myMmr / opponent.mmr, out-of-range MMR, missing build name) so
 * the assertions pin behaviour across the realistic data surface.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { BuildsMmrStatsService } = require("../src/services/buildsMmrStats");

describe("services/buildsMmrStats", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "mmr_stats_test" });
    svc = new BuildsMmrStatsService(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  function makeGame(overrides) {
    return {
      userId: "u1",
      gameId: `${Date.now()}-${Math.random()}`,
      date: new Date("2026-05-09T12:00:00Z"),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "Protoss - Robo Opener",
      myMmr: 4500,
      map: "Hard Lead LE",
      durationSec: 620,
      opponent: {
        pulseId: "1-S2-1-1",
        toonHandle: "1-S2-1-1",
        displayName: "Foe",
        race: "Zerg",
        mmr: 4500,
        strategy: "Zerg - Hatch First",
      },
      ...overrides,
    };
  }

  async function insertGames(games) {
    await db.games.insertMany(games);
  }

  describe("buildWinRateByMmr", () => {
    test("returns one row per (build, my-MMR bucket) with win/loss counts", async () => {
      await insertGames([
        // 3 games of Robo Opener at 4400-bucket (4400, 4500, 4599): 2W 1L
        makeGame({ gameId: "g1", myMmr: 4400, result: "Victory" }),
        makeGame({ gameId: "g2", myMmr: 4500, result: "Victory" }),
        makeGame({ gameId: "g3", myMmr: 4599, result: "Defeat" }),
        // 2 games of Robo Opener at 4600-bucket: 1W 1L
        makeGame({ gameId: "g4", myMmr: 4600, result: "Victory" }),
        makeGame({ gameId: "g5", myMmr: 4700, result: "Defeat" }),
        // 1 game of Cyclone Rush at 4400-bucket: 1W
        makeGame({
          gameId: "g6",
          myMmr: 4450,
          myBuild: "Terran - Cyclone Rush",
          result: "Victory",
        }),
      ]);
      const { bucketWidth, buckets } = await svc.buildWinRateByMmr("u1", {});
      expect(bucketWidth).toBe(200);
      const byKey = new Map(
        buckets.map((b) => [`${b.build}|${b.bucket}`, b]),
      );
      expect(byKey.get("Protoss - Robo Opener|4400")).toMatchObject({
        wins: 2,
        losses: 1,
        games: 3,
        label: "4400–4599",
      });
      expect(byKey.get("Protoss - Robo Opener|4600")).toMatchObject({
        wins: 1,
        losses: 1,
        games: 2,
      });
      expect(byKey.get("Terran - Cyclone Rush|4400")).toMatchObject({
        wins: 1,
        losses: 0,
        games: 1,
      });
    });

    test("drops games where myMmr or opponent.mmr is missing", async () => {
      await insertGames([
        // missing myMmr → dropped
        makeGame({ gameId: "g1", myMmr: null }),
        // missing opponent.mmr → dropped
        makeGame({
          gameId: "g2",
          opponent: {
            pulseId: "1-S2-1-1",
            toonHandle: "1-S2-1-1",
            displayName: "Foe",
            race: "Zerg",
            strategy: "Zerg - Hatch First",
            // no mmr
          },
        }),
        // both present → kept
        makeGame({ gameId: "g3", myMmr: 4500 }),
      ]);
      const { buckets } = await svc.buildWinRateByMmr("u1", {});
      const games = buckets.reduce((acc, b) => acc + b.games, 0);
      expect(games).toBe(1);
    });

    test("drops out-of-range MMR (corrupt rows)", async () => {
      await insertGames([
        makeGame({ gameId: "g_low", myMmr: 50 }),
        makeGame({ gameId: "g_high", myMmr: 99999 }),
        makeGame({ gameId: "g_ok", myMmr: 4500 }),
      ]);
      const { buckets } = await svc.buildWinRateByMmr("u1", {});
      expect(buckets.reduce((acc, b) => acc + b.games, 0)).toBe(1);
    });

    test("custom bucket width groups differently", async () => {
      await insertGames([
        makeGame({ gameId: "g1", myMmr: 4500 }),
        makeGame({ gameId: "g2", myMmr: 4700 }),
      ]);
      // width=500 → both land in the same 4500-bucket.
      const { buckets } = await svc.buildWinRateByMmr(
        "u1",
        {},
        { bucketWidth: 500 },
      );
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({
        bucket: 4500,
        games: 2,
        label: "4500–4999",
      });
    });

    test("mmrDelta filter keeps only games within the mirror window", async () => {
      await insertGames([
        // |my - opp| = 50 → kept under delta=100
        makeGame({
          gameId: "g_mirror",
          myMmr: 4500,
          opponent: {
            pulseId: "1-S2-1-1",
            toonHandle: "1-S2-1-1",
            displayName: "Foe",
            race: "Zerg",
            mmr: 4550,
            strategy: "Zerg - Hatch First",
          },
        }),
        // |my - opp| = 300 → dropped under delta=100
        makeGame({
          gameId: "g_lopsided",
          myMmr: 4500,
          opponent: {
            pulseId: "1-S2-1-2",
            toonHandle: "1-S2-1-2",
            displayName: "Foe",
            race: "Zerg",
            mmr: 4200,
            strategy: "Zerg - Hatch First",
          },
        }),
      ]);
      const { buckets } = await svc.buildWinRateByMmr(
        "u1",
        {},
        { mmrDelta: 100 },
      );
      expect(buckets.reduce((acc, b) => acc + b.games, 0)).toBe(1);
    });

    test("respects the global date filter from gamesMatchStage", async () => {
      await insertGames([
        makeGame({
          gameId: "g_old",
          date: new Date("2025-01-01T00:00:00Z"),
        }),
        makeGame({
          gameId: "g_new",
          date: new Date("2026-05-09T12:00:00Z"),
        }),
      ]);
      const { buckets } = await svc.buildWinRateByMmr("u1", {
        since: new Date("2026-01-01T00:00:00Z"),
      });
      expect(buckets.reduce((acc, b) => acc + b.games, 0)).toBe(1);
    });

    test("Unknown placeholder when myBuild is missing", async () => {
      await insertGames([
        makeGame({ gameId: "g1", myBuild: undefined }),
      ]);
      const { buckets } = await svc.buildWinRateByMmr("u1", {});
      expect(buckets[0].build).toBe("Unknown");
    });
  });

  describe("oppStrategyWinRateByMmr", () => {
    test("buckets on opponent.mmr and groups by opponent.strategy", async () => {
      await insertGames([
        // Hatch First @ opp 4400-bucket: 2 games
        makeGame({
          gameId: "g1",
          opponent: {
            pulseId: "p1",
            toonHandle: "1-S2-1-1",
            displayName: "A",
            race: "Z",
            mmr: 4450,
            strategy: "Zerg - Hatch First",
          },
        }),
        makeGame({
          gameId: "g2",
          opponent: {
            pulseId: "p2",
            toonHandle: "1-S2-1-2",
            displayName: "B",
            race: "Z",
            mmr: 4550,
            strategy: "Zerg - Hatch First",
          },
        }),
        // Pool First @ opp 4600-bucket: 1 game
        makeGame({
          gameId: "g3",
          opponent: {
            pulseId: "p3",
            toonHandle: "1-S2-1-3",
            displayName: "C",
            race: "Z",
            mmr: 4650,
            strategy: "Zerg - Pool First",
          },
        }),
      ]);
      const { buckets } = await svc.oppStrategyWinRateByMmr("u1", {});
      const byKey = new Map(
        buckets.map((b) => [`${b.strategy}|${b.bucket}`, b]),
      );
      expect(byKey.get("Zerg - Hatch First|4400")?.games).toBe(2);
      expect(byKey.get("Zerg - Pool First|4600")?.games).toBe(1);
    });
  });

  describe("buildVsStrategyByMmr", () => {
    test("emits cells keyed on (build, strategy, average-MMR bucket)", async () => {
      await insertGames([
        // Robo Opener vs Hatch First, avg(4500, 4500) = 4500 → bucket 4400
        makeGame({
          gameId: "g1",
          myBuild: "Protoss - Robo Opener",
          myMmr: 4500,
          opponent: {
            pulseId: "p1",
            toonHandle: "1-S2-1-1",
            displayName: "A",
            race: "Z",
            mmr: 4500,
            strategy: "Zerg - Hatch First",
          },
        }),
        // Same matchup, higher bucket
        makeGame({
          gameId: "g2",
          myBuild: "Protoss - Robo Opener",
          myMmr: 4700,
          opponent: {
            pulseId: "p2",
            toonHandle: "1-S2-1-2",
            displayName: "B",
            race: "Z",
            mmr: 4700,
            strategy: "Zerg - Hatch First",
          },
        }),
      ]);
      const { cells } = await svc.buildVsStrategyByMmr("u1", {});
      const byKey = new Map(
        cells.map((c) => [`${c.build}|${c.strategy}|${c.bucket}`, c]),
      );
      expect(
        byKey.get("Protoss - Robo Opener|Zerg - Hatch First|4400")?.games,
      ).toBe(1);
      expect(
        byKey.get("Protoss - Robo Opener|Zerg - Hatch First|4600")?.games,
      ).toBe(1);
    });
  });

  describe("buildAgingCurve", () => {
    test("emits cumulative wins/losses in chronological order per build", async () => {
      await insertGames([
        makeGame({
          gameId: "g1",
          date: new Date("2026-05-01T00:00:00Z"),
          result: "Victory",
        }),
        makeGame({
          gameId: "g2",
          date: new Date("2026-05-02T00:00:00Z"),
          result: "Defeat",
        }),
        makeGame({
          gameId: "g3",
          date: new Date("2026-05-03T00:00:00Z"),
          result: "Victory",
        }),
      ]);
      const series = await svc.buildAgingCurve("u1", {});
      expect(series).toHaveLength(1);
      const [{ curve }] = series;
      expect(curve).toHaveLength(3);
      expect(curve[0]).toMatchObject({ n: 1, cumulativeWins: 1, cumulativeLosses: 0 });
      expect(curve[1]).toMatchObject({ n: 2, cumulativeWins: 1, cumulativeLosses: 1 });
      expect(curve[2]).toMatchObject({ n: 3, cumulativeWins: 2, cumulativeLosses: 1 });
    });
  });

  describe("mmrProgressionByBuild", () => {
    test("emits date-sorted (date, mmr, result) points per build", async () => {
      await insertGames([
        makeGame({
          gameId: "g_late",
          date: new Date("2026-05-10T00:00:00Z"),
          myMmr: 4700,
          result: "Victory",
        }),
        makeGame({
          gameId: "g_early",
          date: new Date("2026-05-01T00:00:00Z"),
          myMmr: 4400,
          result: "Defeat",
        }),
      ]);
      const series = await svc.mmrProgressionByBuild("u1", {});
      expect(series).toHaveLength(1);
      const [{ points }] = series;
      // Chronological order: earlier point first
      expect(points[0].mmr).toBe(4400);
      expect(points[0].result).toBe("loss");
      expect(points[1].mmr).toBe(4700);
      expect(points[1].result).toBe("win");
    });

    test("separate series per build", async () => {
      await insertGames([
        makeGame({ gameId: "g_robo", myBuild: "Protoss - Robo Opener" }),
        makeGame({ gameId: "g_cyc", myBuild: "Terran - Cyclone Rush" }),
      ]);
      const series = await svc.mmrProgressionByBuild("u1", {});
      const names = series.map((s) => s.build).sort();
      expect(names).toEqual(["Protoss - Robo Opener", "Terran - Cyclone Rush"]);
    });
  });
});
