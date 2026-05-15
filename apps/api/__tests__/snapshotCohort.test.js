// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { SnapshotCohortService, percentile } = require("../src/services/snapshotCohort");
const {
  GameDetailsService,
  HEAVY_FIELDS,
} = require("../src/services/gameDetails");
const { makeGameAndDetail } = require("./fixtures/snapshotFixtures");

class InMemoryDetailsStore {
  constructor() {
    this.rows = new Map();
  }
  key(u, g) {
    return `${u}:${g}`;
  }
  async write(userId, gameId, _date, blob) {
    this.rows.set(this.key(userId, gameId), blob);
  }
  async read(userId, gameId) {
    return this.rows.get(this.key(userId, gameId)) || null;
  }
  async readMany(userId, gameIds) {
    const map = new Map();
    for (const id of gameIds) {
      const row = this.rows.get(this.key(userId, id));
      if (row) map.set(id, row);
    }
    return map;
  }
  async delete() {}
  async deleteAllForUser() {}
}

describe("services/snapshotCohort", () => {
  let mongo;
  let db;
  let svc;
  let gameDetails;
  let store;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "snapshot_cohort_test" });
    store = new InMemoryDetailsStore();
    gameDetails = new GameDetailsService(store);
    svc = new SnapshotCohortService(db, { gameDetails });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    store.rows.clear();
  });

  async function seedGames(specs) {
    for (const spec of specs) {
      const { game, detail } = makeGameAndDetail(spec);
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
  }

  describe("resolveCohort", () => {
    test("picks tier-1 when all 8 games match build + race + opening", async () => {
      const specs = [];
      for (let i = 0; i < 8; i += 1) {
        specs.push({ gameId: `g${i}`, result: i < 5 ? "Victory" : "Defeat" });
      }
      await seedGames(specs);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      expect(out.tooSmall).toBeUndefined();
      expect(out.cohortTier).toBe(1);
      expect(out.sampleSize).toBe(8);
    });

    test("falls back to tier-2 when opening filter eliminates too many", async () => {
      const specs = [];
      for (let i = 0; i < 8; i += 1) {
        specs.push({
          gameId: `g${i}`,
          result: "Victory",
          oppOpening: i < 3 ? "Zerg - Hatch First" : "Zerg - Pool First",
        });
      }
      await seedGames(specs);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      expect(out.tooSmall).toBeUndefined();
      expect(out.cohortTier).toBe(2);
    });

    test("falls back to tier-4 (matchup only) when nothing else fits", async () => {
      const specs = [];
      for (let i = 0; i < 8; i += 1) {
        specs.push({
          gameId: `g${i}`,
          myBuild: `Build-${i}`,
          oppOpening: `Opening-${i}`,
        });
      }
      await seedGames(specs);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "ZZZ - Never Played",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "ZZZ - Never Played",
      });
      expect(out.tooSmall).toBeUndefined();
      expect(out.cohortTier).toBe(4);
    });

    test("returns tooSmall when under k-anon floor", async () => {
      await seedGames([{ gameId: "g1" }, { gameId: "g2" }]);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      expect(out.tooSmall).toBe(true);
      expect(out.sampleSize).toBe(0);
    });

    test("scope=mine restricts to the requesting user", async () => {
      const specs = [];
      for (let i = 0; i < 8; i += 1) {
        specs.push({ gameId: `g${i}`, userId: "u-other" });
      }
      await seedGames(specs);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "mine",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      expect(out.tooSmall).toBe(true);
    });

    test("mmrBucket filter narrows to the requested 200-MMR window", async () => {
      const specs = [];
      for (let i = 0; i < 12; i += 1) {
        specs.push({
          gameId: `g${i}`,
          myMmr: i < 8 ? 4400 : 4800,
        });
      }
      await seedGames(specs);
      const out = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
        mmrBucket: 4400,
      });
      expect(out.sampleSize).toBe(8);
    });
  });

  describe("aggregateBands", () => {
    test("computes per-tick winner / loser percentile bands", async () => {
      const specs = [];
      for (let i = 0; i < 12; i += 1) {
        specs.push({
          gameId: `g${i}`,
          result: i < 6 ? "Victory" : "Defeat",
        });
      }
      await seedGames(specs);
      const cohort = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      expect(cohort.tooSmall).toBeUndefined();
      const bands = await svc.aggregateBands(cohort.games);
      expect(bands.ticks.length).toBeGreaterThan(0);
      const tick360 = bands.ticks.find((t) => t.t === 360);
      expect(tick360).toBeDefined();
      expect(tick360.my.army_value).toBeDefined();
      expect(tick360.my.army_value.p50w).toBeGreaterThan(
        tick360.my.army_value.p50l,
      );
      expect(tick360.my.workers.p50w).toBeGreaterThan(0);
      expect(tick360.my.bases.p50w).toBeGreaterThanOrEqual(1);
    });

    test("drops ticks below MIN_TICK_SAMPLES", async () => {
      const specs = [];
      for (let i = 0; i < 8; i += 1) {
        specs.push({
          gameId: `g${i}`,
          result: i < 2 ? "Victory" : "Defeat",
        });
      }
      await seedGames(specs);
      const cohort = await svc.resolveCohort({
        userId: "u1",
        scope: "community",
        myBuild: "Protoss - Robo Opener",
        myRace: "Protoss",
        oppRace: "Zerg",
        oppOpening: "Zerg - Hatch First",
      });
      const bands = await svc.aggregateBands(cohort.games);
      const tick360 = bands.ticks.find((t) => t.t === 360);
      expect(tick360?.my.army_value).toBeUndefined();
    });
  });
});

describe("percentile helper", () => {
  test("interpolates between sorted values", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile(arr, 0.5)).toBe(3);
    expect(percentile(arr, 1)).toBe(5);
    expect(percentile(arr, 0.25)).toBe(2);
    expect(percentile(arr, 0.75)).toBe(4);
  });

  test("returns 0 on empty array", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  test("returns single value on one-element array", () => {
    expect(percentile([42], 0.5)).toBe(42);
  });
});

test.skip("HEAVY_FIELDS export check", () => {
  expect(HEAVY_FIELDS).toContain("macroBreakdown");
});
