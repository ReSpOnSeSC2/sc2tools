// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { LIMITS } = require("../src/config/constants");
const { AggregationsService } = require("../src/services/aggregations");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { buildAdminRouter } = require("../src/routes/admin");

const PERSONAL = "/v1/timeseries/matchups";
const GLOBAL = "/v1/admin/global-trends/timeseries/matchups";
const A = "1-S2-1-100";
const B = "1-S2-1-200";
const RACES = ["Protoss", "Terran", "Zerg"];
const ALL_MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];

function game(id, myRace, opponentRace, result = "Victory", extra = {}) {
  return {
    userId: "a", gameId: id, myToonHandle: A, myRace, myLadderRace: "Random",
    date: new Date("2026-09-01T12:00:00Z"), result, durationSec: 600,
    map: "Arena", isLadderGame: true, playerCount: 2, matchFormat: "1v1",
    myMmr: 4000, myMmrSource: "replay",
    opponent: { race: opponentRace, toonHandle: "1-S2-1-999", mmr: 4200 },
    ...extra,
  };
}

describe("win-rate time series by played matchup", () => {
  let mongo;
  let db;
  let service;
  let app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "matchup_timeseries" });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.games, db.users, db.pulseAccounts].map((collection) => collection.deleteMany({})));
    service = new AggregationsService(db);
    app = express();
    app.use("/v1", buildAdminRouter({
      adminGlobalTrends: new AdminGlobalTrendsService({ db }),
      auth: (req, _res, next) => { req.auth = { userId: "admin" }; next(); },
      isAdmin: () => true,
    }));
    app.use("/v1", buildAggregationsRouter({
      aggregations: service, macroReport: {}, streak: {},
      auth: (req, _res, next) => { req.auth = { userId: "a" }; next(); },
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  });

  test.each([PERSONAL, GLOBAL])("%s keeps all nine played matchups separate within the same bucket", async (path) => {
    await db.games.insertMany(RACES.flatMap((own) => RACES.map((opp) =>
      game(`${own}-${opp}`, own, opp, own === "Zerg" ? "Defeat" : "Victory"))));
    const result = (await request(app).get(path).query({ group_by: "matchup", interval: "day", tz: "UTC" }).expect(200)).body;
    expect(result.points.map((point) => point.matchup).sort()).toEqual(ALL_MATCHUPS);
    expect(result.points.reduce((sum, point) => sum + point.total, 0)).toBe(9);
    expect(result.points.find((point) => point.matchup === "PvT")).toMatchObject({
      myRace: "P", race: "T", wins: 1, losses: 0, total: 1, winRate: 1,
    });
    expect(result.points.find((point) => point.matchup === "ZvT")).toMatchObject({
      myRace: "Z", race: "T", wins: 0, losses: 1, total: 1, winRate: 0,
    });
    // All source games selected Random at queue time. Only actual played races group here.
    expect(result.points.some((point) => point.myRace === "R")).toBe(false);
  });

  test.each([PERSONAL, GLOBAL])("%s preserves legacy opponent-only responses unless grouping is requested", async (path) => {
    await db.games.insertMany([
      game("p-win", "Protoss", "Terran"),
      game("p-draw", "Protoss", "Terran", "Tie"),
      game("z-loss", "Zerg", "Terran", "Defeat"),
    ]);
    const legacy = (await request(app).get(path).query({ interval: "day", tz: "UTC" }).expect(200)).body;
    expect(legacy.points).toEqual([{
      bucket: "2026-09-01T00:00:00.000Z", race: "T", wins: 1, losses: 1, total: 3, winRate: 1 / 3,
    }]);
    const grouped = (await request(app).get(path).query({ group_by: "matchup", interval: "day", tz: "UTC" }).expect(200)).body;
    expect(grouped.points.find((point) => point.matchup === "PvT")).toMatchObject({ wins: 1, losses: 0, total: 2, winRate: 0.5 });
    expect(grouped.points.find((point) => point.matchup === "ZvT")).toMatchObject({ wins: 0, losses: 1, total: 1, winRate: 0 });
  });

  test("personal grouping preserves date, race, opponent, map and timezone filters", async () => {
    const extra = { date: new Date("2026-09-02T01:30:00Z") };
    await db.games.insertMany([
      game("included-win", "Protoss", "Terran", "Victory", extra),
      game("included-loss", "Protoss", "Terran", "Defeat", extra),
      game("other-own", "Zerg", "Terran", "Victory", extra),
      game("other-opp", "Protoss", "Zerg", "Victory", extra),
      game("other-map", "Protoss", "Terran", "Victory", { ...extra, map: "Other" }),
      game("other-date", "Protoss", "Terran"),
      game("other-user", "Protoss", "Terran", "Victory", { ...extra, userId: "b", myToonHandle: B }),
    ]);
    const result = (await request(app).get(PERSONAL).query({
      group_by: "matchup", interval: "day", tz: "America/New_York", race: "P", opp_race: "T", map: "Arena",
      since: "2026-09-02T01:00:00Z", until: "2026-09-02T02:00:00Z",
    }).expect(200)).body;
    expect(result.points).toEqual([{
      bucket: "2026-09-01T04:00:00.000Z", matchup: "PvT", myRace: "P", race: "T",
      wins: 1, losses: 1, total: 2, winRate: 0.5,
    }]);
  });

  test("global grouping respects player and played-race exclusions and deduplicates uploads", async () => {
    await db.games.insertMany([
      game("p", "Protoss", "Terran"),
      game("z", "Zerg", "Terran", "Defeat"),
      game("p", "Protoss", "Terran", "Victory", { userId: "copy" }),
      game("other-player", "Terran", "Terran", "Victory", { userId: "b", myToonHandle: B }),
    ]);
    const result = (await request(app).get(GLOBAL).query({
      group_by: "matchup", interval: "day", tz: "UTC", excluded_players: B, excluded_races: "Z",
    }).expect(200)).body;
    expect(result.points).toEqual([{
      bucket: "2026-09-01T00:00:00.000Z", matchup: "PvT", myRace: "P", race: "T",
      wins: 1, losses: 0, total: 1, winRate: 1,
    }]);
  });

  test("Random and unknown played/opponent races remain distinct coverage groups", async () => {
    await db.games.insertMany([
      game("random", "Random", "Terran"),
      game("unknown", null, "Terran"),
      game("unknown-opp", "Protoss", null),
      game("random-opp", "Protoss", "Random"),
    ]);
    const result = await service.matchupTimeseries("a", { interval: "day", groupByOwnRace: true }, {});
    expect(result.points.map((point) => point.matchup).sort()).toEqual(["PvR", "PvU", "RvT", "UvT"]);
    expect(result.points.reduce((sum, point) => sum + point.total, 0)).toBe(4);
  });

  test("the row limit allows every race pair for every supported time bucket", async () => {
    const races = [...RACES, "Random", "Unknown"];
    const rows = Array.from({ length: LIMITS.TIMESERIES_MAX_BUCKETS }, (_, day) =>
      races.flatMap((own) => races.map((opp) => game(`${day}-${own}-${opp}`, own, opp, "Victory", {
        date: new Date(Date.UTC(2025, 0, 1 + day, 12)),
      })))).flat();
    await db.games.insertMany(rows);
    const result = await service.matchupTimeseries("a", { interval: "day", groupByOwnRace: true }, {});
    expect(result.points).toHaveLength(LIMITS.TIMESERIES_MAX_BUCKETS * 25);
    expect(result.points.reduce((sum, point) => sum + point.total, 0)).toBe(rows.length);
    expect(result.points.at(-1).bucket.toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });
});
