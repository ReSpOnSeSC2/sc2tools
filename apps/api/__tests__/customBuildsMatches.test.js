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

describe("GET /v1/custom-builds/:slug/matches matchup gate", () => {
  let mongo;
  let db;
  let app;
  let services;

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
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
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

    const res = await withAuth(
      request(app).get("/v1/custom-builds/protoss-any/matches"),
    );
    expect(res.status).toBe(200);
    const ids = res.body.recent.map((r) => r.gameId);
    expect(ids).toEqual(
      expect.arrayContaining(["g-pvp-stargate", "g-pvt-stargate"]),
    );
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
  }

  test("returns the phase-aware JSON envelope without transitions", async () => {
    const userId = await bootstrap();
    await seedPhaseGame(userId, "g-comp-1", new Date("2026-05-04T00:00:00Z"));
    await seedPhaseGame(userId, "g-comp-2", new Date("2026-05-05T00:00:00Z"));
    await savePhaseBuild();

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
    // Both seeded games crossed the warpgate-adept fixture's midAt=410s
    // before duration=470s, so they land in finalPhase=mid.
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
    await savePhaseBuild();

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
    expect(reclassify.status).toBe(200);

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
    await savePhaseBuild();

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
