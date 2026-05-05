// @ts-nocheck
"use strict";

/**
 * /v1/custom-builds/preview-matches integration test.
 *
 * Spec: a build saved from your own perspective should match games
 * that have the rule's tokens in the user's buildLog. A build saved
 * from the opponent's perspective should match against oppBuildLog.
 *
 * Reproducer for the "0 games scanned" UX regression in 2026-05: the
 * route was filtering by myRace/opponent.race using a Mongo regex on
 * `^P` etc., which silently excluded games where those fields were
 * missing or stored in a non-canonical shape.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

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

const TERRAN_OPP_BUILD_LOG = [
  "[0:00] SCV",
  "[0:14] SCV",
  "[0:17] SupplyDepot",
  "[1:00] Barracks",
  "[2:30] Bunker",
  "[5:00] Factory",
];

describe("POST /v1/custom-builds/preview-matches", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_preview",
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

  async function seedGame(userId, overrides = {}) {
    await services.games.upsert(userId, {
      gameId: overrides.gameId || `g-${Math.random().toString(36).slice(2)}`,
      date: overrides.date || new Date(),
      myRace: "Protoss",
      myBuild: "PvT — Stargate",
      buildLog: PROTOSS_BUILD_LOG,
      oppBuildLog: TERRAN_OPP_BUILD_LOG,
      result: "Victory",
      map: "Equilibrium LE",
      opponent: { displayName: "scvSlayer", race: "Terran" },
      ...overrides,
    });
  }

  test("matches the user's own build when perspective=you", async () => {
    const userId = await bootstrap();
    await seedGame(userId, { gameId: "g-pvt-stargate" });

    const res = await withAuth(
      request(app)
        .post("/v1/custom-builds/preview-matches")
        .send({
          rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
          race: "Protoss",
          vsRace: "Terran",
          perspective: "you",
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.scanned_games).toBeGreaterThanOrEqual(1);
    const ids = res.body.matches.map((m) => m.game_id);
    expect(ids).toContain("g-pvt-stargate");
  });

  test("matches against the opponent's build when perspective=opponent", async () => {
    const userId = await bootstrap();
    await seedGame(userId, { gameId: "g-vs-bunker-rush" });

    const res = await withAuth(
      request(app)
        .post("/v1/custom-builds/preview-matches")
        .send({
          rules: [{ type: "before", name: "BuildBunker", time_lt: 180 }],
          race: "Terran",
          vsRace: "Protoss",
          perspective: "opponent",
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.scanned_games).toBeGreaterThanOrEqual(1);
    const ids = res.body.matches.map((m) => m.game_id);
    expect(ids).toContain("g-vs-bunker-rush");
  });

  test("does not crash and still scans games when myRace is missing", async () => {
    const userId = await bootstrap();
    await seedGame(userId, {
      gameId: "g-legacy-no-race",
      myRace: undefined,
      myBuild: "PvT — Legacy",
      opponent: { displayName: "?", race: undefined },
    });

    const res = await withAuth(
      request(app)
        .post("/v1/custom-builds/preview-matches")
        .send({
          rules: [{ type: "before", name: "BuildOracle", time_lt: 418 }],
          race: "Protoss",
          vsRace: "Terran",
          perspective: "you",
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.scanned_games).toBeGreaterThanOrEqual(1);
  });

  test("returns 200 with 0 matches when no rules are supplied", async () => {
    await bootstrap();
    const res = await withAuth(
      request(app)
        .post("/v1/custom-builds/preview-matches")
        .send({ rules: [], race: "Protoss", vsRace: "Terran" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.scanned_games).toBe(0);
    expect(res.body.matches).toEqual([]);
  });
});
