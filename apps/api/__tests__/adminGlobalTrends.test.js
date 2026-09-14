// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { AggregationsService } = require("../src/services/aggregations");
const { buildAdminRouter } = require("../src/routes/admin");

const A = "1-S2-1-100";
const B = "2-S2-1-200";
const PATHS = [
  "timeseries", "timeseries/mmr", "timeseries/matchups", "timeseries/day-hour",
  "length-buckets", "activity-calendar", "momentum", "opp-mmr-buckets",
  "opp-mmr-buckets/games", "timeseries/maps", "timeseries/my-builds",
  "timeseries/opp-strategies", "mmr-by-matchup", "mmr-by-matchup/opponents",
  "players", "filter-options",
];

function game(userId, toon, id, minute, race, mmr, result = "Victory", extra = {}) {
  return {
    userId, gameId: id, myToonHandle: toon, myRace: race, myLadderRace: race,
    date: new Date(`2026-09-01T12:${String(minute).padStart(2, "0")}:00Z`),
    myMmr: mmr, myMmrSource: "replay", isLadderGame: true, playerCount: 2,
    matchFormat: "1v1", result, durationSec: 600, map: "Test Arena",
    myBuild: `${race} opener`, macroScore: 75,
    opponent: { race: "Zerg", displayName: "Opponent", pulseId: "1-S2-1-999", mmr: 4700, strategy: "Roach" },
    ...extra,
  };
}

describe("admin Global Trends", () => {
  let mongo;
  let db;
  let service;
  let app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "admin_global_trends_test" });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.games, db.users, db.opponents, db.pulseAccounts].map((collection) => collection.deleteMany({})));
    service = new AdminGlobalTrendsService({ db });
    app = express();
    app.use("/v1", buildAdminRouter({
      adminGlobalTrends: service,
      auth: (req, res, next) => {
        if (!req.headers.authorization) return res.status(401).json({ error: { code: "auth_required" } });
        req.auth = { userId: "admin", clerkUserId: req.headers.authorization };
        next();
      },
      isAdmin: (req) => req.auth.clerkUserId === "admin-token",
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    await db.users.insertMany([{ userId: "a", displayName: "Alpha" }, { userId: "b", displayName: "Beta" }, { userId: "legacy", displayName: "Old Player" }]
      .map((user) => ({ ...user, clerkUserId: `clerk_${user.userId}` })));
    await db.games.insertMany([
      game("a", A, "a1", 0, "Protoss", 4000),
      game("a", A, "a2", 10, "Protoss", 4020, "Defeat"),
      game("b", B, "b1", 5, "Terran", 5000, "Defeat"),
      game("b", B, "b2", 15, "Terran", 4980),
      game("legacy", undefined, "old", 25, "Zerg", undefined, "Victory", { myMmrSource: "unavailable" }),
      game("copy", A, "a1", 0, "Protoss", 4000),
      game("a", A, "resumed", 30, "Protoss", 4050, "Victory", { isResumedFromReplay: true }),
    ]);
    await db.pulseAccounts.insertMany([
      { toonHandle: A, displayNameSample: "AlphaSC2", mmr: 4100, mmrFetchedAt: new Date("2026-09-10") },
      { toonHandle: B, displayNameSample: "BetaSC2", mmr: 5500, mmrFetchedAt: new Date("2026-08-30") },
    ]);
  });

  test.each(PATHS)("%s rejects anonymous and non-admin callers", async (path) => {
    await request(app).get(`/v1/admin/global-trends/${path}`).expect(401);
    await request(app).get(`/v1/admin/global-trends/${path}`).set("Authorization", "user-token").expect(403);
  });

  test.each(PATHS)("%s has an authenticated complete response", async (path) => {
    const response = await request(app).get(`/v1/admin/global-trends/${path}`)
      .query({ lo: 4500, hi: 5000, tz: "UTC" }).set("Authorization", "admin-token").expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.error).toBeUndefined();
  });

  test("all-player totals deduplicate repeated own-player uploads without weakening normal user scope", async () => {
    const all = await service.run("timeseries", {}, { interval: "day", tz: "UTC" });
    expect(all.points[0]).toMatchObject({ total: 5, wins: 3, losses: 2 });
    const mine = await new AggregationsService(db).timeseries("a", { interval: "day" }, {});
    expect(mine.points[0].total).toBe(2);
    await db.games.insertOne(game("b", B, "a1", 0, "Terran", 4990));
    const opposingPerspective = await service.run("timeseries", {}, { interval: "day" });
    expect(opposingPerspective.points[0].total).toBe(6);
  });

  test("all roster pages/search/sorts include known and legacy identities with latest source-aware MMR", async () => {
    const first = await service.players({ sort: "mmr", order: "desc", limit: 1 });
    expect(first).toMatchObject({ total: 3, selectedTotal: 3, hasMore: true });
    expect(first.items[0]).toMatchObject({ playerId: B, currentMmr: 4980, mmrSource: "replay", gameCount: 2 });
    expect(first.items[0].mmrUpdatedAt).toEqual(new Date("2026-09-01T12:15:00Z"));
    const second = await service.players({ sort: "mmr", order: "desc", limit: 1, page: 1 });
    expect(second.items[0]).toMatchObject({ playerId: A, currentMmr: 4100, mmrSource: "pulse", gameCount: 2 });
    const third = await service.players({ sort: "mmr", order: "desc", limit: 1, page: 2 });
    expect(third.items[0]).toMatchObject({ playerId: "user:legacy", currentMmr: null, mmrSource: null });
    expect(third.hasMore).toBe(false);
    const search = await service.players({ search: "alpha", excluded_players: A });
    expect(search).toMatchObject({ total: 1, rosterTotal: 3, selectedTotal: 2 });
    expect(search.items[0].included).toBe(false);
  });

  test("cohort race/player/rating filters compose with the ordinary filters; empty selection stays empty", async () => {
    const count = async (query) => (await service.run("timeseries", query, { interval: "day" })).points.reduce((sum, p) => sum + p.total, 0);
    expect(await count({ excluded_races: "Protoss" })).toBe(3);
    expect(await count({ excluded_players: B, race: "P" })).toBe(2);
    expect(await count({ player_selection: "include", included_players: A })).toBe(2);
    expect(await count({ player_selection: "include", included_players: "" })).toBe(0);
    expect(await count({ player_selection: "include", included_players: "does-not-exist" })).toBe(0);
    expect(await count({ player_mmr_min: "4500", include_unrated: "false" })).toBe(2);
    expect(await count({ player_mmr_min: "4500", include_unrated: "true" })).toBe(3);
    expect(await count({ player_mmr_max: "4200", include_unrated: "false" })).toBe(2);
    expect(await count({ player_mmr_min: "4500", mmr_min: "4800", include_unrated: "false" })).toBe(0);
    expect(await count({ excluded_players: A, excluded_races: "Terran,Zerg" })).toBe(0);
    expect(await service.filterOptions({ excluded_races: "P" })).toEqual({ maps: ["Test Arena"], builds: ["Terran opener", "Zerg opener"], strategies: ["Roach"] });
  });

  test("momentum never chains neighboring games from different players", async () => {
    const result = await service.run("momentum", {});
    expect(result.baseline.total).toBe(5);
    expect(result.postWin).toMatchObject({ total: 1, wins: 0, losses: 1 });
    expect(result.postLoss).toMatchObject({ total: 1, wins: 1, losses: 0 });
  });

  test("Unknown race exclusion is honored and unknown source ratings stay unrated", async () => {
    await db.games.insertOne(game("unknown", "1-S2-1-unknown", "unknown", 40, "Unknown", 9000, "Victory", { myMmrSource: "unavailable" }));
    const result = await service.run("timeseries", { excluded_races: "U" }, { interval: "day" });
    expect(result.points[0].total).toBe(5);
    const roster = await service.players({ excluded_races: "Unknown" });
    expect(roster.items.find((p) => p.playerId === "1-S2-1-unknown")).toMatchObject({ currentMmr: null, included: false });
  });

  test("identical file copies with renamed game IDs still contribute one player perspective", async () => {
    const sha256 = "a".repeat(64);
    await db.games.updateOne({ userId: "a", gameId: "a2" }, { $set: { replayFile: { sha256 } } });
    await db.games.insertOne(game("copy", A, "renamed-a2", 10, "Protoss", 4020, "Defeat", { replayFile: { sha256 } }));
    const result = await service.run("timeseries", {}, { interval: "day" });
    expect(result.points[0].total).toBe(5);
  });

  test("roster has no silent global cap beyond the HTTP page size", async () => {
    await db.games.insertMany(Array.from({ length: 205 }, (_, i) => game("bulk", `3-S2-1-${i}`, `bulk-${i}`, 0, "Protoss", 4000)));
    const first = await service.players({ limit: 200, sort: "name" });
    const second = await service.players({ limit: 200, sort: "name", page: 1 });
    expect(first).toMatchObject({ total: 208, selectedTotal: 208, hasMore: true });
    expect(first.items).toHaveLength(200);
    expect(second.items).toHaveLength(8);
    expect(new Set([...first.items, ...second.items].map((p) => p.playerId)).size).toBe(208);
  });

  test("MMR progression uses each active account/race close once and reports aggregate extrema", async () => {
    const result = await service.run("mmrProgression", {}, { interval: "day", tz: "UTC" });
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ closeMmr: 4500, avgMmr: 4500, minMmr: 4000, maxMmr: 5000, total: 4, activeSeries: 2 });
    expect(result.latest.mmr).toBe(4500);
    expect(result.coverage).toMatchObject({ filteredGames: 5, eligibleGames: 4, missingAccountGames: 1 });
    expect(result.series).toEqual([]);
  });

  test("net-MMR totals and opponent drilldown retain full-history pairing outside display filters", async () => {
    const query = { until: "2026-09-01T12:00:00Z", included_players: A };
    const result = await service.run("netMmrByMatchup", query, { tz: "UTC" });
    const drilldown = await service.run("netMmrByOpponent", query);
    expect(JSON.stringify(result)).toContain('"netMmr":20');
    expect(drilldown.items[0]).toMatchObject({ netMmr: 20, pairs: 1 });
    const excluded = await service.run("netMmrByOpponent", { ...query, excluded_races: "P" });
    expect(excluded.items).toEqual([]);
  });

  test("MMR bucket games reconcile with totals and identify whose perspective each row represents", async () => {
    const result = await service.run("oppMmrBucketGames", { excluded_races: "Z" }, { lo: 4500, hi: 5000 });
    expect(result).toMatchObject({ total: 4, count: 4 });
    expect(new Set(result.games.map((g) => g.playerId))).toEqual(new Set([A, B]));
    expect(result.games.find((g) => g.playerId === A).playerName).toBe("AlphaSC2");
  });

  test("multi-year matchup and map time series retain the earliest and newest games", async () => {
    await db.games.insertOne(game("a", A, "oldest", 0, "Protoss", 3500, "Victory", { date: new Date("2010-01-01") }));
    for (const method of ["matchupTimeseries", "mapTrend", "myBuildMixOverTime"]) {
      const result = await service.run(method, {}, { interval: "day", tz: "UTC" });
      expect(result.interval).toBe("month");
      expect(result.points.reduce((sum, p) => sum + p.total, 0)).toBe(6);
      expect(result.points[0].bucket.getUTCFullYear()).toBe(2010);
    }
  });

  test("explicit refresh invalidates both chart results and latest-MMR roster once across the request batch", async () => {
    const options = { interval: "day", tz: "UTC" };
    const original = await service.run("timeseries", {}, options);
    await service.players({});
    await db.games.insertOne(game("a", A, "fresh", 50, "Protoss", 4300));
    await db.pulseAccounts.updateOne({ toonHandle: A }, { $set: { mmr: 4400 } });
    expect((await service.run("timeseries", {}, options)).points[0].total).toBe(original.points[0].total);
    const query = { refresh_after: Date.now() };
    const [fresh, roster] = await Promise.all([service.run("timeseries", query, options), service.players(query)]);
    expect(fresh.points[0].total).toBe(6);
    expect(roster.items.find((p) => p.playerId === A).currentMmr).toBe(4400);
    const read = jest.spyOn(db.games, "aggregate");
    await service.run("timeseries", query, options);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});
