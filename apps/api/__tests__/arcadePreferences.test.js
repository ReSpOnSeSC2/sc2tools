// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

/**
 * Arcade preferences round-trip. The web SPA (useArcadeState hook)
 * PUTs the entire ArcadeState blob to /v1/me/preferences/arcade on
 * every mutation and GETs it on every mount. If this round-trip
 * doesn't preserve fields, Stock Market portfolios / XP / minerals /
 * unlocked cards all silently reset between sessions — which is
 * exactly the bug a user reported.
 */
jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-x") return { sub: "clerk_user_x" };
    throw new Error("invalid");
  }),
}));

describe("/v1/me/preferences/arcade round-trip", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_arcade_prefs",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7),
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
    });
    app = built.app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("GET on a fresh user returns {}", async () => {
    const res = await request(app)
      .get("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  test("PUT then GET returns the exact ArcadeState blob the SPA sent", async () => {
    // Mirror the real ArcadeState shape from
    // apps/web/components/analyzer/arcade/types.ts so a future field
    // rename can't quietly drop sub-blobs (Stock Market portfolio,
    // Buildle history, etc.) through the round-trip.
    const blob = {
      xp: { total: 1234, level: 5 },
      minerals: 87,
      streak: { count: 12, lastPlayedDay: "2026-05-10" },
      records: {
        "stock-market": {
          attempts: 4,
          correct: 3,
          bestRaw: 1,
          bestXp: 15,
          lastPlayedAt: "2026-05-10T18:00:00Z",
        },
      },
      stockMarket: {
        weekKey: "2026-W19",
        lockedAt: "2026-05-09T12:00:00Z",
        picks: [
          { slug: "own:PvZ - 3 Stargate Phoenix", alloc: 40, entryPrice: 70 },
          { slug: "community:dt-into-void", alloc: 35, entryPrice: 83 },
          { slug: "catalog:protoss-4-gate-rush", alloc: 25, entryPrice: 0 },
        ],
      },
      leaderboardOptIn: true,
      leaderboardDisplayName: "ResponseSC2",
      buildleByDay: {
        "2026-05-09": { questionType: "duration", solved: true, guess: 2 },
      },
      unlockedCards: {
        "reaper-fe": { unlockedAt: "2026-05-08T20:15:00Z" },
      },
      badges: {
        "buildle-brain": { earnedAt: "2026-05-10T19:00:00Z" },
      },
      cosmetics: { mascotSkin: "default" },
    };
    const put = await request(app)
      .put("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x")
      .send(blob);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(blob);

    const get = await request(app)
      .get("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x");
    expect(get.status).toBe(200);
    expect(get.body).toEqual(blob);
  });

  test("PUT then PUT replaces (does not deep-merge) — the SPA always sends the full state", async () => {
    await request(app)
      .put("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x")
      .send({ minerals: 100, badges: { a: { earnedAt: "x" } } });

    // Send a second smaller blob. Server must store *this* shape, not
    // a deep-merge of both — useArcadeState reconciles defaults
    // client-side via { ...ARCADE_STATE_DEFAULT, ...remote }.
    const put = await request(app)
      .put("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x")
      .send({ minerals: 5 });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x");
    expect(get.body).toEqual({ minerals: 5 });
    expect(get.body.badges).toBeUndefined();
  });

  test("PUT rejects arrays at the top level", async () => {
    const put = await request(app)
      .put("/v1/me/preferences/arcade")
      .set("authorization", "Bearer user-x")
      .send([{ minerals: 5 }]);
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("invalid_body");
  });

  test("GET/PUT on an unknown preference type 404s", async () => {
    const get = await request(app)
      .get("/v1/me/preferences/not_a_real_type")
      .set("authorization", "Bearer user-x");
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe("unknown_preference_type");
  });

  test("Auth required — anonymous request is 401", async () => {
    const res = await request(app).get("/v1/me/preferences/arcade");
    expect(res.status).toBe(401);
  });
});
