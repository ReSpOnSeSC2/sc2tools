// @ts-nocheck
"use strict";

const express = require("express");
const supertest = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GameDetailsService } = require("../src/services/gameDetails");
const { SnapshotCohortService } = require("../src/services/snapshotCohort");
const { SnapshotCacheService } = require("../src/services/snapshotCache");
const { SnapshotCompareService } = require("../src/services/snapshotCompare");
const { SnapshotCentroidsService } = require("../src/services/snapshotCentroids");
const { SnapshotInsightsService } = require("../src/services/snapshotInsights");
const { SnapshotTrendsService } = require("../src/services/snapshotTrends");
const { SnapshotNeighborsService } = require("../src/services/snapshotNeighbors");
const { buildSnapshotsRouter } = require("../src/routes/snapshots");
const { makeGameAndDetail } = require("./fixtures/snapshotFixtures");

class InMemoryStore {
  constructor() { this.rows = new Map(); }
  k(u, g) { return `${u}:${g}`; }
  async write(u, g, _d, blob) { this.rows.set(this.k(u, g), blob); }
  async read(u, g) { return this.rows.get(this.k(u, g)) || null; }
  async readMany(u, ids) {
    const m = new Map();
    for (const id of ids) {
      const r = this.rows.get(this.k(u, id));
      if (r) m.set(id, r);
    }
    return m;
  }
  async delete() {}
  async deleteAllForUser() {}
}

describe("/v1/snapshots routes", () => {
  let mongo;
  let db;
  let app;
  let agent;
  let gameDetails;
  let store;
  let services;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "snapshot_routes_test" });
    store = new InMemoryStore();
    gameDetails = new GameDetailsService(store);
    const cohort = new SnapshotCohortService(db, { gameDetails });
    const cache = new SnapshotCacheService(db);
    const compare = new SnapshotCompareService();
    const centroids = new SnapshotCentroidsService();
    const insights = new SnapshotInsightsService();
    const trends = new SnapshotTrendsService(db, { gameDetails, cohort });
    const neighbors = new SnapshotNeighborsService(db, { gameDetails, cohort });
    services = { cohort, cache, compare, centroids, insights, trends, neighbors };
    app = express();
    app.use(express.json());
    const fakeAuth = (req, _res, next) => { req.auth = { userId: "u1" }; next(); };
    app.use(
      "/v1",
      buildSnapshotsRouter({
        db,
        gameDetails,
        snapshotCohort: cohort,
        snapshotCache: cache,
        snapshotCompare: compare,
        snapshotCentroids: centroids,
        snapshotInsights: insights,
        snapshotTrends: trends,
        snapshotNeighbors: neighbors,
        auth: fakeAuth,
      }),
    );
    agent = supertest(app);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.snapshotCohorts.deleteMany({});
    store.rows.clear();
  });

  async function seed(n, result) {
    for (let i = 0; i < n; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `g${i}`, result });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
  }

  test("GET /v1/snapshots/builds lists per-(build, matchup) sample sizes", async () => {
    await seed(3);
    const res = await agent.get("/v1/snapshots/builds");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.builds)).toBe(true);
    expect(res.body.builds[0].name).toBe("Protoss - Robo Opener");
    expect(res.body.builds[0].matchup).toBe("PvZ");
  });

  test("GET /v1/snapshots/cohort returns 422 when below k-anon floor", async () => {
    await seed(3);
    const res = await agent
      .get("/v1/snapshots/cohort")
      .query({
        build: "Protoss - Robo Opener",
        matchup: "PvZ",
        oppOpening: "Zerg - Hatch First",
        scope: "community",
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cohort_too_small");
  });

  test("GET /v1/snapshots/cohort returns band data when k-anon satisfied", async () => {
    // 6 wins + 6 losses
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `w${i}`, result: "Victory" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `l${i}`, result: "Defeat" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    const res = await agent
      .get("/v1/snapshots/cohort")
      .query({
        build: "Protoss - Robo Opener",
        matchup: "PvZ",
        oppOpening: "Zerg - Hatch First",
        scope: "community",
      });
    expect(res.status).toBe(200);
    expect(res.body.cohortTier).toBe(1);
    expect(res.body.sampleSize).toBe(12);
    expect(res.body.ticks.length).toBeGreaterThan(0);
    expect(res.body.ticks[0].my).toBeDefined();
  });

  test("GET /v1/snapshots/cohort second call hits cache", async () => {
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `w${i}`, result: "Victory" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `l${i}`, result: "Defeat" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    const params = {
      build: "Protoss - Robo Opener",
      matchup: "PvZ",
      oppOpening: "Zerg - Hatch First",
      scope: "community",
    };
    const r1 = await agent.get("/v1/snapshots/cohort").query(params);
    const r2 = await agent.get("/v1/snapshots/cohort").query(params);
    expect(r1.body.cached).toBe(false);
    expect(r2.body.cached).toBe(true);
  });

  test("GET /v1/snapshots/game/:gameId returns per-tick scores when cohort is satisfied", async () => {
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `w${i}`, result: "Victory" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    for (let i = 0; i < 6; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `l${i}`, result: "Defeat" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    const res = await agent.get("/v1/snapshots/game/w0");
    expect(res.status).toBe(200);
    expect(res.body.gameId).toBe("w0");
    expect(res.body.ticks.length).toBeGreaterThan(0);
    expect(res.body.insights).toBeDefined();
    expect(Array.isArray(res.body.insights.coachingTags)).toBe(true);
  });

  test("GET /v1/snapshots/game/:gameId 404 when game not found", async () => {
    const res = await agent.get("/v1/snapshots/game/missing");
    expect(res.status).toBe(404);
  });

  test("GET /v1/snapshots/cohort rejects bad scope", async () => {
    const res = await agent
      .get("/v1/snapshots/cohort")
      .query({ scope: "invalid" });
    expect(res.status).toBe(400);
  });

  test("GET /v1/snapshots/neighbors/:gameId surfaces counterfactual neighbors", async () => {
    for (let i = 0; i < 10; i += 1) {
      const { game, detail } = makeGameAndDetail({ gameId: `g${i}`, result: i < 7 ? "Victory" : "Defeat" });
      await db.games.insertOne(game);
      await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    }
    const { game, detail } = makeGameAndDetail({ gameId: "focus", result: "Defeat" });
    await db.games.insertOne(game);
    await gameDetails.upsert(game.userId, game.gameId, game.date, detail);
    const res = await agent
      .get("/v1/snapshots/neighbors/focus")
      .query({ anchorTick: 240, divergenceTick: 360, k: 3 });
    expect(res.status).toBe(200);
    expect(res.body.anchor.tick).toBe(240);
    expect(Array.isArray(res.body.neighbors)).toBe(true);
  });
});
