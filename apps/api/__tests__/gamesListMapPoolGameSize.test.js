// @ts-nocheck
"use strict";

/**
 * End-to-end: the FilterBar's map_pool (ladder/custom) and game_size
 * (1v1/team) params actually narrow the /v1/games-list response. Proves
 * the parseFilters -> gamesMatchStage -> aggregation path is wired, and
 * documents that games WITHOUT the stored fields drop out of either
 * bucket (the "old data can't be filtered" case).
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
    // Insert slim game rows directly so the test controls the stored
    // classification fields (the ingest route stamps isLadderMap from
    // the live pool, which we don't want to depend on here).
    await db.games.insertMany([
      mkGame("ladder-1v1", { isLadderMap: true, playerCount: 2 }),
      mkGame("ladder-team", { isLadderMap: true, playerCount: 4 }),
      mkGame("custom-1v1", { isLadderMap: false, playerCount: 2 }),
      // Legacy row: neither field present (pre-feature upload).
      mkGame("legacy", {}),
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
      ["custom-1v1", "ladder-1v1", "ladder-team", "legacy"].sort(),
    );
  });

  test("map_pool=ladder keeps only isLadderMap:true rows", async () => {
    expect(await listIds("?map_pool=ladder")).toEqual(
      ["ladder-1v1", "ladder-team"].sort(),
    );
  });

  test("map_pool=nonladder keeps only isLadderMap:false rows (legacy excluded)", async () => {
    expect(await listIds("?map_pool=nonladder")).toEqual(["custom-1v1"]);
  });

  test("game_size=1v1 keeps only playerCount:2 rows", async () => {
    expect(await listIds("?game_size=1v1")).toEqual(
      ["custom-1v1", "ladder-1v1"].sort(),
    );
  });

  test("game_size=team keeps only playerCount>2 rows", async () => {
    expect(await listIds("?game_size=team")).toEqual(["ladder-team"]);
  });

  test("combined ladder + team narrows to the intersection", async () => {
    expect(await listIds("?map_pool=ladder&game_size=team")).toEqual([
      "ladder-team",
    ]);
  });
});
