// @ts-nocheck
"use strict";

/**
 * League percentile benchmarks (services/leaguePercentiles.js) against
 * real Mongo (mongodb-memory-server, mongod 7.0.x — which also proves
 * the $percentile $group accumulator path the service relies on):
 *
 *   1. recompute builds one row per (leagueId, matchup) band with
 *      decile tables that match the seeded distributions.
 *   2. Bands below the MIN_SAMPLE floor exist as rows but are never
 *      served by lookup (k-anonymity suppression).
 *   3. No userId (or any per-user field) appears in the output
 *      collection.
 *   4. recompute is idempotent (same row count + values on re-run) and
 *      drops bands that vanished from the corpus.
 *   5. percentileOf interpolates linearly between deciles, clamps the
 *      below-p10 edge into 1..10 and the above-p90 edge into 90..99,
 *      and enforces the per-metric sample floor.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  LeaguePercentilesService,
  percentileOf,
  COLLECTION_NAME,
  MIN_SAMPLE,
} = require("../src/services/leaguePercentiles");

const DIAMOND = 4;
const MASTER = 5;

describe("league percentile benchmarks", () => {
  let mongo;
  let db;
  let svc;
  let outColl;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_league_percentiles",
    });
    svc = new LeaguePercentilesService(db, { logger: null });
    outColl = db.db.collection(COLLECTION_NAME);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await outColl.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  /** Slim games row, shaped like what services/games.js upsert leaves
   *  in the ``games`` collection after the heavy-field split. */
  function game(i, overrides = {}) {
    const {
      leagueId = DIAMOND,
      myRace = "Protoss",
      oppRace = "Zerg",
      userId = `user-${i % 9}`,
      ...rest
    } = overrides;
    return {
      userId,
      gameId: `g-${leagueId}-${myRace[0]}${oppRace[0]}-${i}`,
      date: new Date(Date.UTC(2026, 5, 1 + (i % 28), i % 24)),
      result: i % 2 === 0 ? "Victory" : "Defeat",
      myRace,
      map: "Site Delta",
      opponent: {
        displayName: `opp-${i}`,
        race: oppRace,
        ...(leagueId === null ? {} : { leagueId }),
      },
      _schemaVersion: 5,
      ...rest,
    };
  }

  /**
   * Known distributions:
   *   Diamond PvZ — 100 games, macroScore uniform 0.5..99.5 (decile k
   *     ≈ 10k), apm 100..298 step 2, spq 50..149, durationSec
   *     300..894, myMmr 3000..3990.
   *   Diamond ZvT — 100 games, macroScore uniform 50..74.75.
   *   Master  PvZ — 60 games, macroScore uniform 40.5..99.5.
   *   Master  ZvT — 30 games (below MIN_SAMPLE → suppressed).
   * Plus rows that must be EXCLUDED, all shaped like Diamond PvZ so
   * contamination would move that band's n/deciles: missing
   * opponent.leagueId, team games (playerCount 4), Random race.
   */
  async function seedCorpus() {
    const docs = [];
    for (let i = 0; i < 100; i += 1) {
      docs.push(
        game(i, {
          macroScore: i + 0.5,
          apm: 100 + 2 * i,
          spq: 50 + i,
          durationSec: 300 + 6 * i,
          myMmr: 3000 + 10 * i,
        }),
      );
    }
    for (let i = 0; i < 100; i += 1) {
      docs.push(
        game(i, {
          myRace: "Zerg",
          oppRace: "Terran",
          macroScore: 50 + i / 4,
          apm: 200 + i,
        }),
      );
    }
    for (let i = 0; i < 60; i += 1) {
      docs.push(game(i, { leagueId: MASTER, macroScore: 40.5 + i }));
    }
    for (let i = 0; i < 30; i += 1) {
      docs.push(
        game(i, {
          leagueId: MASTER,
          myRace: "Zerg",
          oppRace: "Terran",
          macroScore: 60 + i,
        }),
      );
    }
    // Excluded rows (Diamond-PvZ-shaped, extreme scores so any leak
    // into the band would visibly move its deciles):
    for (let i = 100; i < 110; i += 1) {
      docs.push(game(i, { leagueId: null, macroScore: 100 }));
    }
    for (let i = 110; i < 115; i += 1) {
      docs.push(game(i, { playerCount: 4, macroScore: 100 }));
    }
    for (let i = 115; i < 120; i += 1) {
      docs.push(game(i, { myRace: "Random", macroScore: 100 }));
    }
    await db.games.insertMany(docs);
  }

  test("recompute builds per-(league, matchup) decile tables", async () => {
    await seedCorpus();
    const out = await svc.recompute();
    expect(out.bands).toBe(4);
    expect(out.updatedAt).toBeInstanceOf(Date);

    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "PvZ" });
    expect(row).not.toBeNull();
    expect(row.n).toBe(100); // excluded rows did not contaminate
    expect(row.league).toBe("Diamond");
    expect(row.matchup).toBe("PvZ");

    // macroScore uniform 0.5..99.5 → decile k should sit near 10k.
    const d = row.metrics.macroScore.deciles;
    expect(row.metrics.macroScore.n).toBe(100);
    expect(d).toHaveLength(9);
    for (let k = 1; k <= 9; k += 1) {
      expect(Math.abs(d[k - 1] - 10 * k)).toBeLessThanOrEqual(4);
    }
    // Other metrics: check the median against the seeded uniform
    // ranges (tolerance scaled to each metric's step size).
    expect(Math.abs(row.metrics.apm.deciles[4] - 199)).toBeLessThanOrEqual(8);
    expect(Math.abs(row.metrics.spq.deciles[4] - 99.5)).toBeLessThanOrEqual(4);
    expect(
      Math.abs(row.metrics.durationSec.deciles[4] - 597),
    ).toBeLessThanOrEqual(24);
    expect(Math.abs(row.metrics.myMmr.deciles[4] - 3495)).toBeLessThanOrEqual(
      40,
    );

    // Distinct band, distinct distribution: Diamond ZvT median ≈ 62.4.
    const zvt = await svc.lookup({ leagueId: DIAMOND, matchup: "ZvT" });
    expect(zvt.n).toBe(100);
    expect(Math.abs(zvt.metrics.macroScore.deciles[4] - 62.4)).toBeLessThanOrEqual(2);
    // Metric absent from this band's seeds → n 0, no deciles served.
    expect(zvt.metrics.spq.n).toBe(0);
    expect(zvt.metrics.spq.deciles).toBeNull();

    // Second league band is independent: Master PvZ median ≈ 70.
    const master = await svc.lookup({ leagueId: MASTER, matchup: "PvZ" });
    expect(master.n).toBe(60);
    expect(master.league).toBe("Master");
    expect(Math.abs(master.metrics.macroScore.deciles[4] - 70)).toBeLessThanOrEqual(4);
  });

  test("lookup normalizes matchup casing and rejects junk", async () => {
    await seedCorpus();
    await svc.recompute();
    const row = await svc.lookup({ leagueId: DIAMOND, matchup: "pvz" });
    expect(row).not.toBeNull();
    expect(row.matchup).toBe("PvZ");
    expect(await svc.lookup({ leagueId: DIAMOND, matchup: "PvX" })).toBeNull();
    expect(await svc.lookup({ leagueId: "4", matchup: "PvZ" })).toBeNull();
    expect(await svc.lookup({ leagueId: 3, matchup: "PvZ" })).toBeNull();
  });

  test("n-floor: bands under MIN_SAMPLE are stored but never served", async () => {
    await seedCorpus();
    await svc.recompute();
    // The raw aggregate row exists (it is aggregate-only data)...
    const raw = await outColl.findOne({ leagueId: MASTER, matchup: "ZvT" });
    expect(raw).not.toBeNull();
    expect(raw.n).toBe(30);
    expect(raw.n).toBeLessThan(MIN_SAMPLE);
    // ...but lookup suppresses it.
    expect(await svc.lookup({ leagueId: MASTER, matchup: "ZvT" })).toBeNull();
  });

  test("no userId (or per-user field) in the output collection", async () => {
    await seedCorpus();
    await svc.recompute();
    const docs = await outColl.find({}).toArray();
    expect(docs.length).toBe(4);
    for (const doc of docs) {
      expect(JSON.stringify(doc)).not.toContain("userId");
      expect(JSON.stringify(doc)).not.toContain("user-");
      expect(Object.keys(doc).sort()).toEqual(
        ["_id", "_schemaVersion", "league", "leagueId", "matchup", "metrics", "n", "updatedAt"].sort(),
      );
    }
  });

  test("recompute is idempotent and drops vanished bands", async () => {
    await seedCorpus();
    const first = await svc.recompute();
    const before = await outColl
      .find({}, { projection: { _id: 0, updatedAt: 0 } })
      .sort({ leagueId: 1, matchup: 1 })
      .toArray();

    const second = await svc.recompute();
    expect(second.bands).toBe(first.bands);
    const after = await outColl
      .find({}, { projection: { _id: 0, updatedAt: 0 } })
      .sort({ leagueId: 1, matchup: 1 })
      .toArray();
    expect(after.length).toBe(before.length);
    // Same key set + same sample counts; deciles may jitter within the
    // approximate accumulator's tolerance so compare the stable parts.
    expect(after.map((r) => [r.leagueId, r.matchup, r.n])).toEqual(
      before.map((r) => [r.leagueId, r.matchup, r.n]),
    );

    // Remove one band from the corpus → next recompute deletes its row.
    await db.games.deleteMany({ "opponent.leagueId": MASTER });
    const third = await svc.recompute();
    expect(third.bands).toBe(2);
    expect(await outColl.countDocuments({})).toBe(2);
    expect(await outColl.findOne({ leagueId: MASTER })).toBeNull();
  });

  describe("percentileOf interpolation (pure)", () => {
    const table = {
      leagueId: DIAMOND,
      league: "Diamond",
      matchup: "PvZ",
      n: 100,
      metrics: {
        macroScore: { n: 100, deciles: [10, 20, 30, 40, 50, 60, 70, 80, 90] },
        spq: { n: 10, deciles: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, // under floor
        apm: { n: 100, deciles: null }, // no numeric samples
      },
      updatedAt: new Date(),
    };

    test("interpolates linearly between deciles", () => {
      expect(percentileOf(table, "macroScore", 50)).toBe(50);
      expect(percentileOf(table, "macroScore", 55)).toBe(55);
      expect(percentileOf(table, "macroScore", 14)).toBe(14);
      expect(percentileOf(table, "macroScore", 10)).toBe(10);
      expect(percentileOf(table, "macroScore", 90)).toBe(90);
      // instance method delegates to the same implementation
      const svcLocal = new LeaguePercentilesService(db);
      expect(svcLocal.percentileOf(table, "macroScore", 55)).toBe(55);
    });

    test("below p10 lands in 1..10", () => {
      const at5 = percentileOf(table, "macroScore", 5);
      expect(at5).toBeGreaterThanOrEqual(1);
      expect(at5).toBeLessThanOrEqual(10);
      expect(at5).toBe(5); // slope of the p10→p20 segment
      expect(percentileOf(table, "macroScore", -1000)).toBe(1); // clamp
    });

    test("above p90 lands in 90..99", () => {
      const at95 = percentileOf(table, "macroScore", 95);
      expect(at95).toBeGreaterThanOrEqual(90);
      expect(at95).toBeLessThanOrEqual(99);
      expect(at95).toBe(95); // slope of the p80→p90 segment
      expect(percentileOf(table, "macroScore", 1e9)).toBe(99); // clamp
    });

    test("floors and junk return null", () => {
      expect(percentileOf(table, "spq", 5)).toBeNull(); // n < MIN_SAMPLE
      expect(percentileOf(table, "apm", 150)).toBeNull(); // null deciles
      expect(percentileOf(table, "durationSec", 300)).toBeNull(); // missing
      expect(percentileOf(null, "macroScore", 50)).toBeNull();
      expect(percentileOf(table, "macroScore", NaN)).toBeNull();
      expect(percentileOf(table, "macroScore", "55")).toBeNull();
    });

    test("flat decile ladder still returns an in-range integer", () => {
      const flat = {
        ...table,
        metrics: { macroScore: { n: 100, deciles: Array(9).fill(50) } },
      };
      const p = percentileOf(flat, "macroScore", 50);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(99);
    });
  });
});
