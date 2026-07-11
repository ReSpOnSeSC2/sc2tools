// @ts-nocheck
"use strict";

/**
 * Route contract for GET /v1/benchmarks: validated params, 404 when
 * the band lacks corpus (client falls back to absolutes), table
 * passthrough otherwise. Service math is covered in
 * leaguePercentiles.test.js; this exercises the HTTP surface through
 * the real app wiring.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_bench" };
    throw new Error("invalid");
  }),
}));

describe("GET /v1/benchmarks", () => {
  let mongo;
  let db;
  let app;
  let services;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_benchmarks",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 9),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function getBenchmarks(query) {
    return request(app)
      .get(`/v1/benchmarks${query}`)
      .set("authorization", "Bearer test-token");
  }

  test("400s on missing/invalid params", async () => {
    expect((await getBenchmarks("")).status).toBe(400);
    expect((await getBenchmarks("?leagueId=4")).status).toBe(400);
    expect((await getBenchmarks("?leagueId=4&matchup=XvY")).status).toBe(400);
    expect(
      (await getBenchmarks("?leagueId=abc&matchup=PvZ")).status,
    ).toBe(400);
  });

  test("404s when the band has no table yet", async () => {
    const res = await getBenchmarks("?leagueId=4&matchup=PvZ");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_enough_data");
  });

  test("serves the table once the corpus supports the band", async () => {
    // Seed enough games for one band past the k-anonymity floor, then
    // recompute through the real service.
    const games = [];
    for (let i = 0; i < 60; i += 1) {
      games.push({
        userId: `u_${i % 10}`,
        gameId: `bench_g_${i}`,
        date: new Date(Date.UTC(2026, 5, 1 + (i % 28))),
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myRace: "Protoss",
        map: "Bench Map",
        durationSec: 600 + i,
        macroScore: 40 + (i % 50),
        apm: 100 + i,
        playerCount: 2,
        opponent: { pulseId: `1-S2-1-${i}`, race: "Zerg", leagueId: 4 },
      });
    }
    await db.games.insertMany(games);
    await services.leaguePercentiles.recompute();

    const res = await getBenchmarks("?leagueId=4&matchup=PvZ");
    expect(res.status).toBe(200);
    expect(res.body.table).toBeTruthy();
    expect(res.body.table.matchup).toBe("PvZ");
    expect(res.body.table.leagueId).toBe(4);
  });

  test("requires auth", async () => {
    const res = await request(app).get("/v1/benchmarks?leagueId=4&matchup=PvZ");
    expect(res.status).toBe(401);
  });
});
