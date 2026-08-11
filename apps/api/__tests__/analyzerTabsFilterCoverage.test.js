// @ts-nocheck
"use strict";

/**
 * Coverage: the map_pool / game_size filters must narrow EVERY analyzer
 * tab, not just Opponents. Unlike the Opponents list (which had a
 * cached-counter fast path that bypassed the filter — fixed separately),
 * these tabs always aggregate from games through gamesMatchStage, so
 * this locks in that they keep honouring the new fields.
 *
 *   - Maps        -> /v1/maps
 *   - Maps (mu)   -> /v1/matchups
 *   - Builds      -> /v1/builds
 *   - Strategies  -> /v1/opp-strategies
 *   - Trends      -> /v1/timeseries
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_tabs" };
    throw new Error("invalid");
  }),
}));

describe("analyzer tabs honour map_pool / game_size", () => {
  let mongo;
  let db;
  let app;
  let userId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_tabs",
    clerkSecretKey: "sk_test",
    serverPepper: Buffer.alloc(32, 5),
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
    await db.games.deleteMany({});
    // A: ranked ladder 1v1, ZvT, distinct build + strategy.
    // B: custom team game whose map proxy deliberately disagrees with
    //    the authoritative matchmaking category.
    // C: custom FFA. Its eight players must not make it a team game.
    await db.games.insertMany([
      {
        userId,
        gameId: "A",
        date: new Date("2026-05-10T12:00:00.000Z"),
        result: "Victory",
        myRace: "Zerg",
        map: "Acro Ladder",
        durationSec: 600,
        myBuild: "ZvT Ling Bane",
        isLadderGame: true,
        isLadderMap: true,
        matchFormat: "1v1",
        playerCount: 2,
        opponent: { pulseId: "1-1-1-1", displayName: "Terry", race: "Terran", strategy: "T - Bio" },
      },
      {
        userId,
        gameId: "B",
        date: new Date("2026-05-11T12:00:00.000Z"),
        result: "Defeat",
        myRace: "Zerg",
        map: "Custom Arena",
        durationSec: 700,
        myBuild: "ZvP Macro",
        isLadderGame: false,
        isLadderMap: true,
        matchFormat: "team",
        playerCount: 4,
        opponent: { pulseId: "1-1-1-2", displayName: "Petra", race: "Protoss", strategy: "P - Cannon Rush" },
      },
      {
        userId,
        gameId: "C",
        date: new Date("2026-05-12T12:00:00.000Z"),
        result: "Victory",
        myRace: "Zerg",
        map: "FFA Basin",
        durationSec: 800,
        myBuild: "ZvZ FFA",
        isLadderGame: false,
        isLadderMap: false,
        matchFormat: "ffa",
        playerCount: 8,
        opponent: { pulseId: "1-1-1-3", displayName: "Zara", race: "Zerg", strategy: "Z - FFA" },
      },
    ]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const get = (path) =>
    request(app)
      .get(path)
      .set("authorization", "Bearer test-token")
      .then((r) => {
        expect(r.status).toBe(200);
        return r.body;
      });

  test("/v1/maps narrows by map_pool", async () => {
    expect((await get("/v1/maps")).length).toBe(3);
    const ladder = await get("/v1/maps?map_pool=ladder");
    expect(ladder.length).toBe(1);
    expect(ladder[0].name).toBe("Acro Ladder");
  });

  test("/v1/matchups narrows by game_size", async () => {
    expect((await get("/v1/matchups")).length).toBe(3);
    const team = await get("/v1/matchups?game_size=team");
    expect(team.length).toBe(1); // only the 4-player ZvP game
  });

  test("/v1/maps/matchups cross-tabs map x matchup and narrows by filters", async () => {
    // Three games, three distinct maps, one matchup cell each.
    const all = await get("/v1/maps/matchups");
    expect(all.length).toBe(3);
    const acro = all.find((r) => r.map === "Acro Ladder");
    expect(acro).toMatchObject({
      map: "Acro Ladder",
      matchup: "vs T",
      wins: 1,
      losses: 0,
      total: 1,
      winRate: 1,
    });
    const custom = all.find((r) => r.map === "Custom Arena");
    expect(custom).toMatchObject({
      map: "Custom Arena",
      matchup: "vs P",
      wins: 0,
      losses: 1,
      total: 1,
      winRate: 0,
    });

    // Filters narrow the cross-tab just like the flat endpoints.
    const ladder = await get("/v1/maps/matchups?map_pool=ladder");
    expect(ladder.map((r) => r.map)).toEqual(["Acro Ladder"]);
    const team = await get("/v1/maps/matchups?game_size=team");
    expect(team.map((r) => r.map)).toEqual(["Custom Arena"]);
  });

  test("/v1/builds narrows by map_pool", async () => {
    expect((await get("/v1/builds")).length).toBe(3);
    const ladder = await get("/v1/builds?map_pool=ladder");
    expect(ladder.map((b) => b.name)).toEqual(["ZvT Ling Bane"]);
  });

  test("/v1/opp-strategies narrows by map_pool", async () => {
    expect((await get("/v1/opp-strategies")).length).toBe(3);
    const ladder = await get("/v1/opp-strategies?map_pool=ladder");
    expect(ladder.map((s) => s.name)).toEqual(["T - Bio"]);
  });

  test("/v1/timeseries totals reflect the filter", async () => {
    const sum = (ts) => ts.points.reduce((n, p) => n + p.total, 0);
    expect(sum(await get("/v1/timeseries"))).toBe(3);
    expect(sum(await get("/v1/timeseries?map_pool=ladder"))).toBe(1);
    expect(sum(await get("/v1/timeseries?game_size=team"))).toBe(1);
    expect(sum(await get("/v1/timeseries?game_size=1v1"))).toBe(1);
  });
});
