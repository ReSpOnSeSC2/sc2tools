// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { buildOpponentsRouter } = require("../src/routes/opponents");

const OWNER = "dossier-owner";
const PULSE = "1-S2-1-991";
const HEAVY_KEYS = ["medianTimings", "medianTimingsLegacy", "medianTimingsOrder",
  "matchupTimings", "matchupTimingsLegacy", "phases", "transitions",
  "gamesScouting", "last5GamesScouting", "playerCard", "analysisSampleSize"];

describe("private dossier brief and explicit analysis", () => {
  let mongo;
  let db;
  let service;
  let gameDetails;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "dossier_analysis_split" });
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({}), db.opponentNotes.deleteMany({})]);
    await db.opponents.insertOne({
      userId: OWNER, pulseId: PULSE, displayNameSample: "Dossier rival", race: "Z",
      firstSeen: new Date("2020-01-01"), lastSeen: new Date("2026-07-09"),
      gameCount: 9, wins: 5, losses: 4,
    });
    await db.opponentNotes.insertOne({ userId: OWNER, pulseId: PULSE, notes: "Private scout", notesReadAloud: true });
    await db.games.insertMany(Array.from({ length: 9 }, (_, i) => ({
      userId: OWNER, gameId: `sample-${i}`, date: new Date(Date.UTC(2026, 6, i + 1)),
      myRace: "Protoss", myBuild: "Gateway Expand", map: i === 0 ? "Other LE" : "Exact LE",
      result: i % 2 === 0 ? "Victory" : "Defeat", durationSec: 600,
      isLadderGame: true, isLadderMap: true, matchFormat: "1v1", playerCount: 2,
      opponent: { pulseId: PULSE, displayName: "Dossier rival", race: "Zerg", strategy: "Macro" },
      buildLog: ["legacy detail must not enter brief"],
      macroBreakdown: { secret: "legacy-heavy" },
    })));
    gameDetails = {
      findMany: jest.fn(() => { throw new Error("bulk detail hydration forbidden"); }),
      findOne: jest.fn(async (_owner, id) => ({
        buildLog: Number(id.slice(-1)) < 5 ? ["[0:20] Pylon", "[0:45] Gateway"] : [],
        oppBuildLog: Number(id.slice(-1)) < 4 ? ["[0:17] SpawningPool", "[0:50] Hatchery"] : [],
        macroBreakdown: { bases: [], production_buildings: [], stats_events: [], unit_timeline: [] },
      })),
    };
    service = new OpponentsService(db, Buffer.alloc(32, 1), { gameDetails });
  });

  function appFor(owner = OWNER) {
    const app = express();
    app.use(buildOpponentsRouter({
      opponents: service,
      auth: (req, res, next) => {
        if (!owner) return res.status(401).json({ error: { code: "auth_required" } });
        req.auth = { userId: owner };
        next();
      },
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "unexpected" } }));
    return app;
  }

  test("default authenticated response never reads detail and preserves all-time series under filtering", async () => {
    const inlineRead = jest.spyOn(db.games, "findOne");
    const hydrate = jest.spyOn(service, "_hydrateProfileAnalyticalSample");
    const full = await request(appFor()).get(`/opponents/${PULSE}`);
    const scoped = await request(appFor()).get(`/opponents/${PULSE}?since=2026-07-08&map=Exact&map_pool=ladder&game_size=1v1`);
    expect(full.status).toBe(200);
    expect(scoped.status).toBe(200);
    expect(full.headers["cache-control"]).toBe("private, no-store");
    expect(scoped.body.totals.total).toBe(2);
    expect(scoped.body.series).toEqual(full.body.series);
    expect(full.body.notes).toBe("Private scout");
    for (const key of HEAVY_KEYS) expect(full.body).not.toHaveProperty(key);
    expect(full.body.games).toHaveLength(9);
    expect(JSON.stringify(full.body)).not.toContain("legacy-heavy");
    expect(gameDetails.findOne).not.toHaveBeenCalled();
    expect(gameDetails.findMany).not.toHaveBeenCalled();
    expect(inlineRead).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  test("analysis exposes honest build-order coverage and exact date-scoped sample IDs", async () => {
    const briefGet = jest.spyOn(service, "get");
    const res = await request(appFor()).get(`/opponents/${PULSE}/analysis`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      analysisSampleSize: 9, analysisSampleLimit: 100, analysisSampleTruncated: false,
      analysisCohortSize: 9, buildOrdersAvailable: 4, buildOrdersTotal: 9, yourBuildOrdersAvailable: 5,
    });
    expect(res.body.analyzedGameIds).toEqual(Array.from({ length: 9 }, (_, i) => `sample-${8 - i}`));
    expect(res.body.medianTimingsLegacy).toBeDefined();
    expect(res.body.phases).toBeDefined();
    expect(res.body.transitions).toBeDefined();
    expect(res.body.games).toBeUndefined();
    expect(res.body.notes).toBeUndefined();
    expect(briefGet).not.toHaveBeenCalled();
    expect(gameDetails.findOne).toHaveBeenCalledTimes(9);
    expect(gameDetails.findOne.mock.calls.every(([owner]) => owner === OWNER)).toBe(true);
    const rich = await service.getAnalysis(OWNER, PULSE, { includeProfile: true, since: new Date("2026-07-08") });
    expect(rich.games).toHaveLength(2);
    expect(rich.last5GamesScouting).toHaveLength(5);
    expect(rich.analyzedGameIds).toEqual(["sample-8", "sample-7"]);
    expect(rich.buildOrdersTotal).toBe(2);
    expect(rich.buildOrdersAvailable).toBe(0);
    expect(rich.notes).toBe("Private scout");
  });

  test("brief and analyzed samples retain the exact account cohort across legacy separator case", async () => {
    await db.games.updateMany({ userId: OWNER }, { $set: { myToonHandle: "1-S2-1-999" } });
    await db.games.updateOne({ userId: OWNER, gameId: "sample-0" }, { $set: { myToonHandle: "1-s2-1-111" } });
    await db.games.updateOne({ userId: OWNER, gameId: "sample-1" }, { $set: { myToonHandle: "1-S2-1-111" } });
    const brief = await request(appFor()).get(`/opponents/${PULSE}?accounts=1-S2-1-111`);
    expect(brief.status).toBe(200); expect(brief.body.totals.total).toBe(2);
    expect(brief.body.games.map(row => row.id)).toEqual(["sample-1", "sample-0"]);
    const analysis = await request(appFor()).get(`/opponents/${PULSE}/analysis?accounts=1-s2-1-111`);
    expect(analysis.status).toBe(200); expect(analysis.body.analyzedGameIds).toEqual(["sample-1", "sample-0"]);
    expect(gameDetails.findOne.mock.calls.map(([, id]) => id)).toEqual(["sample-1", "sample-0"]);
  });

  test("analysis forwards the complete facet scope and retryable admission failure without calling get", async () => {
    const briefGet = jest.spyOn(service, "get");
    const analysis = jest.spyOn(service, "getAnalysis").mockRejectedValue(Object.assign(new Error("busy"), {
      status: 503, code: "opponent_profile_busy",
    }));
    const res = await request(appFor()).get(`/opponents/${PULSE}/analysis`).query({
      mergeLinked: "1", includeProfile: "1", since: "2026-07-08", opp_race: "Z", map_pool: "ladder", game_size: "1v1",
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("opponent_profile_busy");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(analysis).toHaveBeenCalledWith(OWNER, PULSE, {
      mergeLinked: true, includeProfile: true,
      filters: expect.objectContaining({ since: new Date("2026-07-08"), oppRace: "Z", mapPool: "ladder", gameSize: "1v1" }),
    });
    expect(briefGet).not.toHaveBeenCalled();
  });

  test.each(["", "/analysis", "/analysis?includeProfile=1", "/games?analysisGameIds=%5B%22sample-1%22%5D"])(
    "rejects other owners and signed-out callers before replay detail work: %s", async (suffix) => {
      const find = jest.spyOn(db.games, "find");
      expect((await request(appFor("different-owner")).get(`/opponents/${PULSE}${suffix}`)).status).toBe(404);
      expect((await request(appFor(null)).get(`/opponents/${PULSE}${suffix}`)).status).toBe(401);
      expect(find).not.toHaveBeenCalled();
      expect(gameDetails.findOne).not.toHaveBeenCalled();
    },
  );

  test("timing membership performs one indexed metadata read and keeps owner, identity, result and facet scope", async () => {
    await db.games.insertMany([
      { userId: "other-owner", gameId: "foreign-owner", date: new Date("2026-07-09"), opponent: { pulseId: PULSE } },
      { userId: OWNER, gameId: "other-rival", date: new Date("2026-07-09"), opponent: { pulseId: "other" } },
    ]);
    const find = jest.spyOn(db.games, "find");
    const aggregate = jest.spyOn(db.games, "aggregate");
    const ids = ["sample-8", "sample-7", "sample-0", "foreign-owner", "other-rival"];
    const res = await request(appFor()).get(`/opponents/${PULSE}/games`).query({
      analysisGameIds: JSON.stringify(ids), result: "Victory", map: "Exact", map_pool: "ladder", game_size: "1v1",
    });
    expect(res.status).toBe(200);
    expect(res.body.items.map((game) => game.id)).toEqual(["sample-8"]);
    expect(res.body.items[0].analysisSampleMember).toBe(true);
    expect(res.body.membership).toEqual({ scope: "analysis_sample", requestedGameCount: 5 });
    expect(res.body.nextCursor).toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
    expect(aggregate).not.toHaveBeenCalled();
    expect(gameDetails.findOne).not.toHaveBeenCalled();
    const [filter, options] = find.mock.calls[0];
    expect(options.projection.buildLog).toBeUndefined();
    const explain = await db.games.find(filter, options).hint({ userId: 1, gameId: 1 }).explain("executionStats");
    expect(explain.executionStats.totalDocsExamined).toBeLessThanOrEqual(ids.length);
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain("userId_1_gameId_1");
  });

  test("empty membership matches nothing and absence keeps ordinary history semantics", async () => {
    expect((await service.listGames(OWNER, PULSE, { analysisGameIds: [] })).items).toEqual([]);
    const all = await service.listGames(OWNER, PULSE);
    expect(all.items).toHaveLength(9);
    expect(all).not.toHaveProperty("membership");
    expect(all.items[0]).not.toHaveProperty("analysisSampleMember");
  });

  test("selected sample pages retain membership across equal timestamps without duplicates", async () => {
    await db.games.updateMany({ userId: OWNER }, { $set: { date: new Date("2026-07-09") } });
    const selected = ["sample-8", "sample-6", "sample-4"];
    const first = await service.listGames(OWNER, PULSE, { analysisGameIds: selected, limit: 2 });
    const second = await service.listGames(OWNER, PULSE, { analysisGameIds: selected, limit: 2, cursor: first.nextCursor });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((game) => game.id)).toEqual(selected);
    expect(second.items.every((game) => game.analysisSampleMember)).toBe(true);
    expect(second.membership).toEqual(first.membership);
  });

  test.each([
    "not-json", "null", "{}", '["sample-1",null]', '[" sample-1"]', '["a\\u0000b"]',
    JSON.stringify(Array.from({ length: 101 }, (_, i) => `sample-${i}`)),
    JSON.stringify(["x".repeat(257)]),
  ])("malformed or unbounded membership fails closed before database reads: %s", async (analysisGameIds) => {
    const find = jest.spyOn(db.games, "find");
    const res = await request(appFor()).get(`/opponents/${PULSE}/games`).query({ analysisGameIds });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_analysis_game_ids");
    expect(find).not.toHaveBeenCalled();
    expect(gameDetails.findOne).not.toHaveBeenCalled();
  });
});
