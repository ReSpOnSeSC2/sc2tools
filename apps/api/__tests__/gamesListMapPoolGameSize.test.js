// @ts-nocheck
"use strict";

/**
 * End-to-end: the FilterBar's map_pool (ladder/custom) and game_size
 * (1v1/team) params actually narrow the /v1/games-list response. Ranked
 * vs custom comes from authoritative ``isLadderGame``; team vs FFA
 * comes from normalized ``matchFormat``. A two-player count is retained
 * only as the safe legacy fallback for 1v1.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_filters" };
    throw new Error("invalid");
  }),
}));

describe("/v1/games-list honours map_pool and game_size", () => {
  let mongo;
  let db;
  let app;
  let userId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_filters",
    clerkSecretKey: "sk_test",
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
    app = buildApp({ db, logger: pino({ level: "silent" }), config }).app;
    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    userId = me.body.userId;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    // Insert slim game rows directly so the test controls canonical
    // matchmaking/format fields and deliberately conflicting legacy
    // map-proxy values without depending on ingest-time classification.
    await db.games.insertMany([
      mkGame("ladder-1v1", {
        isLadderGame: true,
        isLadderMap: true,
        matchFormat: "1v1",
        playerCount: 2,
      }),
      mkGame("ladder-team", {
        isLadderGame: true,
        isLadderMap: true,
        matchFormat: "team",
        playerCount: 4,
      }),
      mkGame("custom-1v1", {
        isLadderGame: false,
        isLadderMap: false,
        matchFormat: "1v1",
        playerCount: 2,
      }),
      mkGame("custom-team", {
        isLadderGame: false,
        isLadderMap: false,
        matchFormat: "team",
        playerCount: 4,
      }),
      // Canonical matchmaking category must win over the old map proxy.
      mkGame("custom-on-ladder-map", {
        isLadderGame: false,
        isLadderMap: true,
        matchFormat: "1v1",
        playerCount: 2,
      }),
      mkGame("ladder-on-nonladder-map", {
        isLadderGame: true,
        isLadderMap: false,
        matchFormat: "1v1",
        playerCount: 2,
      }),
      // More than two players does not imply a team game.
      mkGame("custom-ffa", {
        isLadderGame: false,
        isLadderMap: false,
        matchFormat: "ffa",
        playerCount: 8,
      }),
      // Legacy format fallback: exactly two players may still be 1v1.
      mkGame("legacy-1v1", { isLadderMap: true, playerCount: 2 }),
      // No matchFormat means a large lobby is not safely classifiable as team.
      mkGame("legacy-many", { isLadderMap: true, playerCount: 8 }),
      // Fully unknown pre-feature row.
      mkGame("unknown", {}),
    ]);
  });

  function mkGame(id, extra) {
    return {
      userId,
      gameId: id,
      date: new Date("2026-05-01T00:00:00.000Z"),
      result: "Victory",
      myRace: "Zerg",
      map: id,
      durationSec: 600,
      ...extra,
    };
  }

  function listIds(query) {
    return request(app)
      .get(`/v1/games-list${query}`)
      .set("authorization", "Bearer test-token")
      .then((r) => {
        expect(r.status).toBe(200);
        return (r.body.games || []).map((g) => g.id).sort();
      });
  }

  test("no filter returns every game", async () => {
    expect(await listIds("")).toEqual(
      [
        "custom-1v1",
        "custom-team",
        "custom-on-ladder-map",
        "ladder-1v1",
        "ladder-team",
        "ladder-on-nonladder-map",
        "custom-ffa",
        "legacy-1v1",
        "legacy-many",
        "unknown",
      ].sort(),
    );
  });

  test("map_pool=ladder keeps only authoritative ladder rows", async () => {
    expect(await listIds("?map_pool=ladder")).toEqual(
      ["ladder-1v1", "ladder-team", "ladder-on-nonladder-map"].sort(),
    );
  });

  test("map_pool=nonladder keeps authoritative custom rows", async () => {
    expect(await listIds("?map_pool=nonladder")).toEqual(
      ["custom-1v1", "custom-team", "custom-on-ladder-map", "custom-ffa"].sort(),
    );
  });

  test("game_size=1v1 uses matchFormat plus the two-player legacy fallback", async () => {
    expect(await listIds("?game_size=1v1")).toEqual(
      [
        "custom-1v1",
        "custom-on-ladder-map",
        "ladder-1v1",
        "ladder-on-nonladder-map",
        "legacy-1v1",
      ].sort(),
    );
  });

  test("game_size=team uses matchFormat and excludes FFA/unknown large lobbies", async () => {
    expect(await listIds("?game_size=team")).toEqual(
      ["custom-team", "ladder-team"].sort(),
    );
  });

  test("combined ladder + team narrows to the intersection", async () => {
    expect(await listIds("?map_pool=ladder&game_size=team")).toEqual([
      "ladder-team",
    ]);
  });

  test("combined ladder + 1v1 is the strict product-default cohort", async () => {
    expect(await listIds("?map_pool=ladder&game_size=1v1")).toEqual(
      ["ladder-1v1", "ladder-on-nonladder-map"].sort(),
    );
  });

  test("combined custom + 1v1 includes custom games on ladder-map names", async () => {
    expect(await listIds("?map_pool=nonladder&game_size=1v1")).toEqual(
      ["custom-1v1", "custom-on-ladder-map"].sort(),
    );
  });

  test("all sentinels remain an explicit no-op", async () => {
    expect(await listIds("?map_pool=all&game_size=all")).toEqual(
      await listIds(""),
    );
  });
});
