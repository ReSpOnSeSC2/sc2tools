// @ts-nocheck
"use strict";

/**
 * /v1/custom-builds/:slug/matches integration test.
 *
 * Spec: a single-matchup build (e.g. PvP) must only count games whose
 * stored matchup matches. Reproducer for the May-2026 bug where a
 * PvP build was attaching PvT replays — the rule evaluator was running
 * but no matchup gate was applied, so any cross-matchup game whose
 * opener happened to fire the same tokens leaked in and showed up in
 * Top matchups, Recent games, and Vs opponent strategy.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");

const PHASE_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "phase", "warpgate_adept_tracking.json"),
    "utf8",
  ),
);

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-clerk-token") return { sub: "clerk_user_test" };
    throw new Error("invalid");
  }),
}));

const PROTOSS_BUILD_LOG = [
  "[0:00] Probe",
  "[0:12] Probe",
  "[0:17] Pylon",
  "[0:49] Gateway",
  "[1:20] Assimilator",
  "[1:43] CyberneticsCore",
  "[3:00] Stargate",
  "[6:28] Oracle",
];

const PROTOSS_OPP_BUILD_LOG = [
  "[0:00] Probe",
  "[0:14] Probe",
  "[0:17] Pylon",
  "[0:49] Gateway",
  "[3:30] RoboticsFacility",
];

const TERRAN_OPP_BUILD_LOG = [
  "[0:00] SCV",
  "[0:14] SCV",
  "[0:17] SupplyDepot",
  "[1:00] Barracks",
  "[2:30] Bunker",
  "[5:00] Factory",
];

async function waitForReclassification(db, userId, generation, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await db.customBuildJobs.findOne({ userId, generation });
    if (job?.status === "complete") return job;
    if (job?.status === "failed") {
      throw new Error(`reclassification failed: ${job.error}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for reclassification ${generation}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GET /v1/custom-builds/:slug/matches matchup gate", () => {
  let mongo;
  let db;
  let app;
  let services;
  let roomEmit;
  let io;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_matches",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 1),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    roomEmit = jest.fn();
    io = { to: jest.fn(() => ({ emit: roomEmit })) };
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      io,
    });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (services?.customBuilds) {
      await services.customBuilds.stopReclassifications();
    }
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrap() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  test("a PvP build does not attach PvT replays even when openers tokenize the same", async () => {
    const userId = await bootstrap();

    // PvP game — should be counted.
    await services.games.upsert(userId, {
      gameId: "g-pvp-stargate",
      date: new Date("2026-05-01T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvP — Stargate",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: PROTOSS_OPP_BUILD_LOG,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "tossBro", race: "Protoss" },
    });

    // PvT game with the SAME opener tokens — must be dropped by the gate.
    await services.games.upsert(userId, {
      gameId: "g-pvt-stargate",
      date: new Date("2026-05-02T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvT — Stargate",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: TERRAN_OPP_BUILD_LOG,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "DuncanTheFat", race: "Terran" },
    });

    // Save a PvP-only custom build whose rule the Protoss opener satisfies.
    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/pvp-custom").send({
        slug: "pvp-custom",
        name: "PvP Stargate",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);
    await waitForReclassification(
      db,
      userId,
      putRes.body.reclassify.generation,
    );
    expect(io.to).toHaveBeenCalledWith(`user:${userId}`);
    expect(roomEmit).toHaveBeenCalledWith(
      "games:changed",
      expect.objectContaining({ count: 1 }),
    );

    const res = await withAuth(
      request(app).get("/v1/custom-builds/pvp-custom/matches"),
    );
    expect(res.status).toBe(200);

    const recentIds = res.body.recent.map((r) => r.gameId);
    expect(recentIds).toContain("g-pvp-stargate");
    expect(recentIds).not.toContain("g-pvt-stargate");

    expect(res.body.totals.total).toBe(1);
    const matchupNames = res.body.byMatchup.map((m) => m.name);
    expect(matchupNames).toContain("PvP");
    expect(matchupNames).not.toContain("PvT");
  });

  test("evaluateAllStats applies the same gate to the BuildsLibrary card grid", async () => {
    const userId = await bootstrap();

    await services.games.upsert(userId, {
      gameId: "g-pvz-stats",
      date: new Date("2026-05-03T00:00:00Z"),
      myRace: "Protoss",
      myBuild: "PvZ — Stargate",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: ["[0:00] Drone", "[0:17] Overlord", "[0:50] SpawningPool"],
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "zergRusher", race: "Zerg" },
    });

    const stats = await withAuth(
      request(app).get("/v1/custom-builds/stats"),
    );
    expect(stats.status).toBe(200);
    const row = stats.body.find((r) => r.slug === "pvp-custom");
    expect(row).toBeTruthy();
    // Only the PvP game from the previous test should be counted; the
    // PvT and PvZ games match the rule but are different matchups.
    expect(row.total).toBe(1);
  });

  test("library stats and matches use durable classification provenance without hydrating replay blobs", async () => {
    const userId = await bootstrap();
    const slug = "authoritative-classification";
    const save = await withAuth(
      request(app).put(`/v1/custom-builds/${slug}`).send({
        slug,
        name: "Authoritative opener",
        race: "Protoss",
        vsRace: "Any",
        // This deliberately cannot match either tagged replay below. The
        // completed classifier's slug, not a second live rule pass, must drive
        // the library and dossier.
        rules: [{ type: "before", name: "BuildFleetBeacon", time_lt: 60 }],
        reclassify: false,
      }),
    );
    expect(save.status).toBe(200);

    await services.games.upsert(userId, {
      gameId: "g-authoritative-win",
      date: new Date("2026-06-01T12:00:00Z"),
      myRace: "Protoss",
      myBuild: "Old display name",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: TERRAN_OPP_BUILD_LOG,
      result: "Victory",
      map: "Blackrock LE",
      opponent: {
        displayName: "TerranOne",
        race: "Terran",
        strategy: "Terran - Ghost Rush",
      },
    });
    await services.games.upsert(userId, {
      gameId: "g-authoritative-loss",
      date: new Date("2026-06-02T12:00:00Z"),
      myRace: "Protoss",
      myBuild: "Old display name",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: ["[0:00] Drone", "[0:17] Overlord", "[0:50] SpawningPool"],
      result: "Defeat",
      map: "Blackrock LE",
      opponent: {
        displayName: "ZergOne",
        race: "Zerg",
        strategy: "Zerg - Roach Rush",
      },
    });
    await services.games.upsert(userId, {
      gameId: "g-rule-only-decoy",
      date: new Date("2026-06-03T12:00:00Z"),
      myRace: "Protoss",
      myBuild: "Agent classifier label",
      buildLog: ["[0:30] FleetBeacon"],
      result: "Victory",
      map: "Blackrock LE",
      opponent: { displayName: "Decoy", race: "Terran" },
    });
    await db.games.updateMany(
      {
        userId,
        gameId: { $in: ["g-authoritative-win", "g-authoritative-loss"] },
      },
      { $set: { _customBuildSlug: slug } },
    );
    const indexes = await db.games.indexes();
    const classifiedIndex = indexes.find((index) => (
      index.key?.userId === 1
      && index.key?._customBuildSlug === 1
      && index.key?.date === -1
    ));
    expect(classifiedIndex).toBeTruthy();
    const plan = await db.games.find(
      { userId, _customBuildSlug: slug },
    ).sort({ date: -1 }).limit(1).explain("queryPlanner");
    expect(JSON.stringify(plan)).toContain(classifiedIndex.name);

    const hydrateSpy = jest.spyOn(services.gameDetails, "findMany");
    try {
      const [stats, matches] = await Promise.all([
        withAuth(request(app).get("/v1/custom-builds/stats")),
        withAuth(request(app).get(`/v1/custom-builds/${slug}/matches`)),
      ]);
      expect(stats.status).toBe(200);
      expect(stats.body.find((row) => row.slug === slug)).toEqual(
        expect.objectContaining({
          name: "Authoritative opener",
          total: 2,
          wins: 1,
          losses: 1,
          winRate: 0.5,
        }),
      );
      expect(matches.status).toBe(200);
      expect(matches.body).toEqual(expect.objectContaining({
        name: "Authoritative opener",
        totals: expect.objectContaining({
          total: 2,
          wins: 1,
          losses: 1,
          winRate: 0.5,
        }),
        recent: expect.arrayContaining([
          expect.objectContaining({ gameId: "g-authoritative-win" }),
          expect.objectContaining({ gameId: "g-authoritative-loss" }),
        ]),
        timingSampleGames: 2,
        timingSampleLimit: 25,
        timingsTruncated: false,
      }));
      expect(Object.values(matches.body.medianTimings).some(
        (row) => row.count > 0,
      )).toBe(true);
      expect(matches.body.recent.map((row) => row.gameId))
        .not.toContain("g-rule-only-decoy");
      expect(matches.body.byMatchup.map((row) => row.name))
        .toEqual(expect.arrayContaining(["PvT", "PvZ"]));
      expect(hydrateSpy).toHaveBeenCalledTimes(2);
      expect(hydrateSpy.mock.calls.map((call) => call[1][0])).toEqual(
        expect.arrayContaining([
          "g-authoritative-win",
          "g-authoritative-loss",
        ]),
      );
      for (const call of hydrateSpy.mock.calls) {
        expect(call[0]).toBe(userId);
        expect(call[1]).toHaveLength(1);
        expect(call[1]).not.toContain("g-rule-only-decoy");
        expect(call[2]).toEqual(expect.objectContaining({
          fields: ["buildLog", "oppBuildLog"],
          concurrency: 1,
        }));
      }

      // Display-name edits do not change the stable replay ownership key.
      const renamed = await withAuth(
        request(app).put(`/v1/custom-builds/${slug}`).send({
          slug,
          name: "Renamed authoritative opener",
          race: "Protoss",
          vsRace: "Any",
          rules: [{ type: "before", name: "BuildFleetBeacon", time_lt: 60 }],
          reclassify: false,
        }),
      );
      expect(renamed.status).toBe(200);
      const renamedStats = await withAuth(
        request(app).get("/v1/custom-builds/stats"),
      );
      expect(renamedStats.body.find((row) => row.slug === slug)).toEqual(
        expect.objectContaining({
          name: "Renamed authoritative opener",
          total: 2,
        }),
      );
      expect(hydrateSpy).toHaveBeenCalledTimes(2);
    } finally {
      hydrateSpy.mockRestore();
    }
  });

  test("vsRace=Any allows cross-matchup replays through the gate", async () => {
    const userId = await bootstrap();

    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/protoss-any").send({
        slug: "protoss-any",
        name: "Protoss Stargate (any matchup)",
        race: "Protoss",
        vsRace: "Any",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);
    await waitForReclassification(
      db,
      userId,
      putRes.body.reclassify.generation,
    );

    const res = await withAuth(
      request(app).get("/v1/custom-builds/protoss-any/matches"),
    );
    expect(res.status).toBe(200);
    const ids = res.body.recent.map((r) => r.gameId);
    expect(ids).toEqual(
      expect.arrayContaining(["g-pvp-stargate", "g-pvt-stargate"]),
    );
  });

  test("stored stats and matches remain available when replay-detail evaluation is unavailable", async () => {
    const customBuilds = {
      evaluateAllStats: jest.fn(async () => [{
        slug: "stored-only",
        name: "Stored only",
        total: 1,
        wins: 1,
        losses: 0,
        winRate: 1,
      }]),
      evaluateBuild: jest.fn(async () => ({
        slug: "stored-only",
        name: "Stored only",
        totals: { total: 1, wins: 1, losses: 0, winRate: 1 },
        recent: [],
      })),
    };
    const standalone = express();
    standalone.use(express.json());
    standalone.use((req, _res, next) => {
      req.auth = { userId: "u-stored-only" };
      next();
    });
    standalone.use("/v1", buildCustomBuildsRouter({
      customBuilds,
      perGame: null,
      auth: (_req, _res, next) => next(),
    }));

    const [stats, matches] = await Promise.all([
      request(standalone).get("/v1/custom-builds/stats"),
      request(standalone).get("/v1/custom-builds/stored-only/matches"),
    ]);
    expect(stats.status).toBe(200);
    expect(stats.body[0]).toEqual(expect.objectContaining({ total: 1 }));
    expect(matches.status).toBe(200);
    expect(matches.body.totals.total).toBe(1);
  });
});

describe("GET /v1/custom-builds/:slug/compositions", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_compositions",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 1),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (services?.customBuilds) {
      await services.customBuilds.stopReclassifications();
    }
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrap() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  async function seedPhaseGame(userId, gameId, date) {
    await services.games.upsert(userId, {
      gameId,
      date,
      myRace: PHASE_FIXTURE.race,
      myBuild: "PvZ — Adept",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: ["[0:00] Drone", "[0:17] Overlord", "[0:50] SpawningPool"],
      result: "Victory",
      map: "Equilibrium LE",
      durationSec: PHASE_FIXTURE.durationSec,
      opponent: { displayName: "zergRusher", race: "Zerg", strategy: "Zerg - Mass Ling" },
      macroBreakdown: PHASE_FIXTURE.macroBreakdown,
    });
    await db.games.updateOne(
      { userId, gameId },
      { $set: { _customBuildSlug: "pvz-adept" } },
    );
  }

  async function savePhaseBuild() {
    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/pvz-adept").send({
        slug: "pvz-adept",
        name: "PvZ Adept",
        race: "Protoss",
        vsRace: "Zerg",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);
    return putRes.body?.reclassify?.generation || null;
  }

  test("returns the phase-aware JSON envelope without transitions", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-comp-1", new Date("2026-05-04T00:00:00Z"));
    await seedPhaseGame(userId, "g-comp-2", new Date("2026-05-05T00:00:00Z"));
    const generation = await savePhaseBuild();
    if (generation) {
      await waitForReclassification(db, userId, generation);
    }

    const res = await withAuth(
      request(app).get("/v1/custom-builds/pvz-adept/compositions"),
    );
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("pvz-adept");
    expect(res.body.name).toBe("PvZ Adept");
    // Phase-aggregator envelope. transitions stays absent on this
    // endpoint — the scouting widget only wants the compositions half.
    expect(res.body).toHaveProperty("sampleSize");
    expect(res.body).toHaveProperty("perPhase");
    expect(res.body).toHaveProperty("finalPhaseDistribution");
    expect(res.body).toHaveProperty("flags");
    expect(res.body).not.toHaveProperty("transitions");
    // Every phase carries the same row-shape so the SPA never needs
    // existence checks before rendering.
    for (const phase of ["early", "earlyMid", "mid", "midLate", "late"]) {
      expect(res.body.perPhase[phase]).toEqual(
        expect.objectContaining({
          signatures: expect.any(Array),
          tech: expect.any(Array),
          upgrades: expect.any(Array),
        }),
      );
    }
    // Both seeded games crossed the warpgate-adept fixture's midAt=293s
    // before duration=470s (real LotV seconds post-2026-05-17 timebase
    // migration), so they land in finalPhase=mid.
    expect(res.body.finalPhaseDistribution.mid).toBe(2);
    expect(res.body.sampleSize.mid).toBe(2);
  });

  test("404 for an unknown slug", async () => {
    await bootstrap();
    const res = await withAuth(
      request(app).get("/v1/custom-builds/no-such-build/compositions"),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });

  test("503 when perGame is missing", async () => {
    // Mount the router with no perGame dep so the 503 branch fires.
    // Mirrors how the route handler gates the stats / matches paths.
    const standalone = express();
    standalone.use(express.json());
    standalone.use((req, _res, next) => {
      req.auth = { userId: "u-no-pergame" };
      next();
    });
    standalone.use(
      "/v1",
      buildCustomBuildsRouter({
        customBuilds: services.customBuilds,
        perGame: null,
        auth: (_req, _res, next) => next(),
      }),
    );
    const res = await request(standalone).get(
      "/v1/custom-builds/anything/compositions",
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "stats_unavailable" } });
  });

  test("second call within 60s short-circuits via the cache", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-cache-1", new Date("2026-05-06T00:00:00Z"));
    const generation = await savePhaseBuild();
    if (generation) {
      await waitForReclassification(db, userId, generation);
    }

    const first = await withAuth(
      request(app).get("/v1/custom-builds/pvz-adept/compositions"),
    );
    expect(first.status).toBe(200);

    // Spy on the underlying service method. The second request must
    // hit the route-layer cache and never call into the service.
    const spy = jest.spyOn(services.customBuilds, "evaluateBuildPhases");
    try {
      const second = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/compositions"),
      );
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("?perspective=opponent forwards through to evaluateBuildPhases and is cached separately", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-persp-1", new Date("2026-05-10T00:00:00Z"));
    const generation = await savePhaseBuild();
    if (generation) {
      await waitForReclassification(db, userId, generation);
    }

    const spy = jest.spyOn(services.customBuilds, "evaluateBuildPhases");
    try {
      // First "you" call to seed the cache for that perspective.
      const yourFirst = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/compositions?perspective=you"),
      );
      expect(yourFirst.status).toBe(200);
      expect(yourFirst.body.perspective).toBe("you");

      // Opponent perspective is a separate cache slot — the spy
      // must fire even though "you" is already cached.
      spy.mockClear();
      const oppFirst = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/compositions?perspective=opponent"),
      );
      expect(oppFirst.status).toBe(200);
      expect(oppFirst.body.perspective).toBe("opponent");
      expect(spy).toHaveBeenCalledWith(
        userId,
        "pvz-adept",
        expect.objectContaining({ perspective: "opponent" }),
      );

      // Second opp call hits the cache. The spy must NOT fire again.
      spy.mockClear();
      const oppSecond = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/compositions?perspective=opponent"),
      );
      expect(oppSecond.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("?strategy=<name> narrows the matched set to the build × strategy cell", async () => {
    // Seed three games on a NEW custom build so the assertion is
    // independent of every other test in this describe block (which
    // shares the same MongoDB instance):
    //   - two against "Zerg - Mass Ling"
    //   - one against "Zerg - Roach allin"
    // The drill-down passes ``?strategy=`` so the left column of the
    // comparison view describes only the cell — not the build's full
    // marginal across opponents.
    const userId = await bootstrap();
    const seedCellGame = async (gameId, date, strategyLabel) => {
      await services.games.upsert(userId, {
        gameId,
        date,
        myRace: PHASE_FIXTURE.race,
        myBuild: "PvZ — Cell Adept",
        buildLog: PROTOSS_BUILD_LOG,
        oppBuildLog: ["[0:00] Drone", "[0:17] Overlord", "[0:50] SpawningPool"],
        result: "Victory",
        map: "Equilibrium LE",
        durationSec: PHASE_FIXTURE.durationSec,
        opponent: { displayName: "zergRusher", race: "Zerg", strategy: strategyLabel },
        macroBreakdown: PHASE_FIXTURE.macroBreakdown,
      });
      await db.games.updateOne(
        { userId, gameId },
        { $set: { _customBuildSlug: "pvz-cell-adept" } },
      );
    };
    await seedCellGame(
      "g-cell-mass-ling-1",
      new Date("2026-05-12T00:00:00Z"),
      "Zerg - Cell Mass Ling",
    );
    await seedCellGame(
      "g-cell-mass-ling-2",
      new Date("2026-05-13T00:00:00Z"),
      "Zerg - Cell Mass Ling",
    );
    await seedCellGame(
      "g-cell-roach",
      new Date("2026-05-14T00:00:00Z"),
      "Zerg - Cell Roach allin",
    );
    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/pvz-cell-adept").send({
        slug: "pvz-cell-adept",
        name: "PvZ Cell Adept",
        race: "Protoss",
        vsRace: "Zerg",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);

    // The prior tests in this describe block share the same Mongo
    // instance and seed games that ALSO satisfy this build's matchup
    // gate + rule, so we can't assert an absolute total. Instead we
    // assert the cell-scoped payload only matches our seeded
    // strategy labels — which are unique to this test — and the
    // unscoped payload picks up at LEAST the 3 newly-seeded games.
    const wide = await withAuth(
      request(app).get("/v1/custom-builds/pvz-cell-adept/compositions"),
    );
    expect(wide.status).toBe(200);
    expect(wide.body.finalPhaseDistribution.mid).toBeGreaterThanOrEqual(3);

    // Cell-scoped: only the two Mass-Ling games (the unique strategy
    // label this test owns). Other tests in the suite seed against
    // different strategies, so the cell-scope filter narrows to
    // exactly the two cell-Mass-Ling games.
    const cell = await withAuth(
      request(app).get(
        "/v1/custom-builds/pvz-cell-adept/compositions?strategy=Zerg%20-%20Cell%20Mass%20Ling",
      ),
    );
    expect(cell.status).toBe(200);
    expect(cell.body.finalPhaseDistribution.mid).toBe(2);

    // And the cell-scoped total is strictly less than the unscoped
    // total — proving the filter actually narrows the matched set.
    expect(cell.body.finalPhaseDistribution.mid).toBeLessThan(
      wide.body.finalPhaseDistribution.mid,
    );

    // The two responses come from independent cache slots — a second
    // unscoped call after the scoped one must still return the wider
    // count (cell payload didn't poison the unscoped slot).
    const wideAgain = await withAuth(
      request(app).get("/v1/custom-builds/pvz-cell-adept/compositions"),
    );
    expect(wideAgain.status).toBe(200);
    expect(wideAgain.body.finalPhaseDistribution.mid).toBe(
      wide.body.finalPhaseDistribution.mid,
    );
  });

  test("?strategy=<name> with no games in the intersection returns an empty envelope", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-only-mass-ling", new Date("2026-05-15T00:00:00Z"));
    await savePhaseBuild();

    // The compositions endpoint short-circuits on an empty matched
    // set by returning the envelope with zeroed phase rows (the
    // service returns ``out`` regardless of matched.length). The new
    // behavior we're protecting is that the matched set DOES shrink
    // under the strategy filter, not that 404 is returned.
    const res = await withAuth(
      request(app).get(
        "/v1/custom-builds/pvz-adept/compositions?strategy=Zerg%20-%20Nydus%20Worm",
      ),
    );
    expect(res.status).toBe(200);
    const totalSamples = ["early", "earlyMid", "mid", "midLate", "late"].reduce(
      (acc, phase) => acc + (res.body.sampleSize[phase] || 0),
      0,
    );
    expect(totalSamples).toBe(0);
  });

  test("reclassify busts the cached payload", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-bust-1", new Date("2026-05-07T00:00:00Z"));
    await savePhaseBuild();

    const first = await withAuth(
      request(app).get("/v1/custom-builds/pvz-adept/compositions"),
    );
    expect(first.status).toBe(200);

    const reclassify = await withAuth(
      request(app).post("/v1/custom-builds/pvz-adept/reclassify"),
    );
    expect(reclassify.status).toBe(202);
    expect(reclassify.body).toEqual(expect.objectContaining({
      ok: true,
      status: "queued",
      generation: expect.any(String),
    }));

    const spy = jest.spyOn(services.customBuilds, "evaluateBuildPhases");
    try {
      const after = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/compositions"),
      );
      expect(after.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /v1/custom-builds/:slug/transitions", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_transitions",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 1),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (services?.customBuilds) {
      await services.customBuilds.stopReclassifications();
    }
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrap() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  async function seedPhaseGame(userId, gameId, date) {
    await services.games.upsert(userId, {
      gameId,
      date,
      myRace: PHASE_FIXTURE.race,
      myBuild: "PvZ — Adept",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: ["[0:00] Drone", "[0:17] Overlord", "[0:50] SpawningPool"],
      result: "Victory",
      map: "Equilibrium LE",
      durationSec: PHASE_FIXTURE.durationSec,
      opponent: { displayName: "zergRusher", race: "Zerg", strategy: "Zerg - Mass Ling" },
      macroBreakdown: PHASE_FIXTURE.macroBreakdown,
    });
    await db.games.updateOne(
      { userId, gameId },
      { $set: { _customBuildSlug: "pvz-adept" } },
    );
  }

  async function savePhaseBuild() {
    const putRes = await withAuth(
      request(app).put("/v1/custom-builds/pvz-adept").send({
        slug: "pvz-adept",
        name: "PvZ Adept",
        race: "Protoss",
        vsRace: "Zerg",
        rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
      }),
    );
    expect(putRes.status).toBe(200);
    return putRes.body?.reclassify?.generation || null;
  }

  test("returns only the transitions half of the payload", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-tx-1", new Date("2026-05-08T00:00:00Z"));
    await savePhaseBuild();

    const res = await withAuth(
      request(app).get("/v1/custom-builds/pvz-adept/transitions"),
    );
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("pvz-adept");
    expect(res.body.name).toBe("PvZ Adept");
    expect(res.body.transitions).toEqual(
      expect.objectContaining({
        nodes: expect.any(Array),
        edges: expect.any(Array),
        rare: expect.objectContaining({
          collapsedNodes: expect.any(Number),
          collapsedEdges: expect.any(Number),
        }),
      }),
    );
    // The compositions half stays off this endpoint so the scouting
    // widget can request /compositions independently without paying
    // for the Sankey aggregation.
    expect(res.body).not.toHaveProperty("perPhase");
    expect(res.body).not.toHaveProperty("sampleSize");
    expect(res.body).not.toHaveProperty("finalPhaseDistribution");
  });

  test("404 for an unknown slug", async () => {
    await bootstrap();
    const res = await withAuth(
      request(app).get("/v1/custom-builds/no-such-build/transitions"),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });

  test("503 when perGame is missing", async () => {
    const standalone = express();
    standalone.use(express.json());
    standalone.use((req, _res, next) => {
      req.auth = { userId: "u-no-pergame" };
      next();
    });
    standalone.use(
      "/v1",
      buildCustomBuildsRouter({
        customBuilds: services.customBuilds,
        perGame: null,
        auth: (_req, _res, next) => next(),
      }),
    );
    const res = await request(standalone).get(
      "/v1/custom-builds/anything/transitions",
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: "stats_unavailable" } });
  });

  test("second call within 60s short-circuits via the cache", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-tx-cache-1", new Date("2026-05-09T00:00:00Z"));
    // The PUT queues a reclassification, and the phase cache key carries the
    // classification revision. Landing that job between the two reads gives
    // the second one a different key, so it recomputes and labels the build
    // node from the saved build name instead of the raw myBuild — the source
    // of an intermittent "PvZ Adept" vs "PvZ — Adept" mismatch here. Settle
    // the revision first, like the content tests above, so this test measures
    // the cache and nothing else.
    const generation = await savePhaseBuild();
    if (generation) {
      await waitForReclassification(db, userId, generation);
    }

    const first = await withAuth(
      request(app).get("/v1/custom-builds/pvz-adept/transitions"),
    );
    expect(first.status).toBe(200);

    const spy = jest.spyOn(services.customBuilds, "evaluateBuildPhases");
    try {
      const second = await withAuth(
        request(app).get("/v1/custom-builds/pvz-adept/transitions"),
      );
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
