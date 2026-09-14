// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { AggregationsService } = require("../src/services/aggregations");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { buildAdminRouter } = require("../src/routes/admin");
const { parseExplorerOptions, VIEWS } = require("../src/services/trendsExplorer");
const { extractDetailSummary } = require("../src/services/trendsExplorerDetail");

const A = "1-S2-1-100", B = "2-S2-1-200";
function game(userId, id, minute, extra = {}) {
  return { userId, gameId: id, myToonHandle: userId === "a" ? A : B,
    date: new Date(Date.UTC(2026, 8, 1, 12, minute)),
    durationSec: 600, result: "Victory", myRace: "Protoss", myLadderRace: "Protoss",
    myMmr: 4100, myMmrSource: "replay", isLadderGame: true, playerCount: 2, matchFormat: "1v1",
    map: "Arena", myBuild: "Expand",
    opponent: { race: "Zerg", displayName: "Opponent", toonHandle: "1-S2-1-999", mmr: 4200, mmrSource: "replay" }, ...extra };
}

describe("Trends explorer authorization, real Mongo filters and drilldowns", () => {
  let mongo, client, db, personal, global, app;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    const database = client.db("explorer");
    db = { db: database, games: database.collection("games"), gameDetails: database.collection("game_details"),
      users: database.collection("users"), opponents: database.collection("opponents"), pulseAccounts: database.collection("pulse_accounts") };
    await db.gameDetails.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    for (const collection of [db.games, db.gameDetails, db.users, db.pulseAccounts]) await collection.deleteMany({});
    personal = new AggregationsService(db);
    global = new AdminGlobalTrendsService({ db });
    const auth = (req, res, next) => {
      if (!req.headers.authorization) return res.sendStatus(401);
      req.auth = { userId: req.headers.authorization, clerkUserId: req.headers.authorization };
      next();
    };
    app = express();
    app.use("/v1", buildAdminRouter({ adminGlobalTrends: global, auth, isAdmin: (req) => req.auth.userId === "admin" }));
    app.use("/v1", buildAggregationsRouter({ aggregations: personal, auth }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    await db.games.insertMany([
      game("a", "a1", 0), game("a", "a2", 12, { result: "Defeat", map: "Other" }),
      game("a", "a3", 28), game("b", "b1", 8, { myRace: "Terran", myLadderRace: "Terran", myMmr: 5100 }),
      game("copy", "a1", 0, { myToonHandle: A }),
      game("a", "resumed", 40, { isResumedFromReplay: true }),
    ]);
    const summary = extractDetailSummary({ buildLog: ["[03:00] Stalker"], macroBreakdown: {
      bases: [{ name: "Nexus", unit_id: 1, born_time: 0, died_time: 1000 },
        { name: "Nexus", unit_id: 2, born_time: 150, died_time: 1000 }, { name: "Nexus", unit_id: 3, born_time: 300, died_time: 1000 }],
      stats_events: [{ time: 480, food_workers: 60, army_value: 4000 }],
      opp_stats_events: [{ time: 480, food_workers: 50, army_value: 3500 }],
    } });
    for (const userId of ["a", "b", "copy"]) {
      await db.gameDetails.insertOne({ userId, gameId: userId === "b" ? "b1" : "a1", trendsExplorerDetail: summary,
        // A source fact from another user's same game ID must never join.
        buildLog: ["large irrelevant raw data"], mapPlayback: { irrelevant: true } });
    }
  });

  const query = { a_since: "2026-09-01", a_until: "2026-09-01", b_since: "2026-08-01", b_until: "2026-08-31", a_min: 4000, a_max: 5000, b_min: 5000, b_max: 6000 };
  test.each([...VIEWS])("%s has independently authorized personal/global endpoints", async (view) => {
    await request(app).get(`/v1/trends/explorer/${view}`).expect(401);
    await request(app).get(`/v1/admin/global-trends/trends/explorer/${view}`).set("Authorization", "a").expect(403);
    const own = await request(app).get(`/v1/trends/explorer/${view}`).query(query).set("Authorization", "a").expect(200);
    expect(own.body.totalGames).toBe(3);
    expect(own.body.rows.every((row) => !row.gameKeys)).toBe(true);
    expect(own.body.breakdown.every((row) => !row.gameKeys)).toBe(true);
    expect(own.headers["cache-control"]).toBe("private, no-store");
    const all = await request(app).get(`/v1/admin/global-trends/trends/explorer/${view}`).query(query).set("Authorization", "admin").expect(200);
    expect(all.body.totalGames).toBe(4);
  });

  test("global player/race exclusions and empty include selection apply to every new view", async () => {
    for (const view of VIEWS) {
      const opts = parseExplorerOptions(view, query);
      expect((await global.run("explorer", { excluded_players: B }, opts)).totalGames).toBe(3);
      expect((await global.run("explorer", { excluded_races: "P" }, opts)).totalGames).toBe(1);
      expect((await global.run("explorer", { player_selection: "include", included_players: "" }, opts)).totalGames).toBe(0);
    }
  });

  test("drilldowns preserve user/filter scope and exactly match the selected row", async () => {
    const opts = parseExplorerOptions("mmr-gap", {});
    const response = await personal.explorer("a", { map: "Arena" }, opts);
    expect(response.eligibleGames).toBe(2);
    const games = await personal.explorer("a", { map: "Arena" }, { ...opts, games: true, segment: response.rows[0].key, limit: 1 });
    expect(games).toMatchObject({ total: response.rows[0].games, limit: 1, offset: 0 });
    expect(games.games[0]).toMatchObject({ id: "a3", playerId: A });
    expect(games.games[0].userId).toBeUndefined();
    const next = await personal.explorer("a", { map: "Arena" }, { ...opts, games: true, segment: response.rows[0].key, limit: 1, offset: 1 });
    expect(next.games[0].id).toBe("a1");
  });

  test("filtered-out games establish actual previous game for breaks and rematches", async () => {
    const opts = parseExplorerOptions("breaks", { after: "loss" });
    const response = await personal.explorer("a", { map: "Arena" }, opts);
    expect(response.totalGames).toBe(2);
    expect(response.rows.find((r) => r.key === "5-15").games).toBe(1);
    const rematches = await personal.explorer("a", { map: "Arena" }, parseExplorerOptions("rematches", { after: "loss" }));
    expect(rematches.rows.find((r) => r.key === "third").games).toBe(1);
    expect(rematches.eligibleGames).toBe(1);
  });

  test("comparison dates override only outer date filter and retain map filter", async () => {
    const response = await personal.explorer("a", { since: new Date("2027-01-01"), map: "Arena" }, parseExplorerOptions("periods", query));
    expect(response).toMatchObject({ totalGames: 2, eligibleGames: 2 });
    expect(response.rows[0].games).toBe(2);
    expect(response.rows[1].games).toBe(0);
  });

  test("replay summaries join by BOTH uploader and game identity", async () => {
    await db.gameDetails.deleteMany({ userId: "a" });
    const result = await personal.explorer("a", {}, parseExplorerOptions("execution", {}));
    expect(result).toMatchObject({ totalGames: 3, eligibleGames: 0 });
  });

  test("explicit account comparisons cannot reach another user's history", async () => {
    const result = await personal.explorer("a", {}, parseExplorerOptions("groups", { group_mode: "players", a_players: A, b_players: B }));
    expect(result.rows.map((r) => r.games)).toEqual([3, 0]);
    expect(result.options.players.map((p) => p.id)).toEqual([A]);
  });

  test("partial summaries keep polling until the active source branch is prepared", async () => {
    await db.gameDetails.updateOne({ userId: "a", gameId: "a1" }, { $set: { trendsExplorerDetail: { version: 1, ratings: {} } } });
    for (const view of ["execution", "leads"]) {
      const result = await personal.explorer("a", {}, parseExplorerOptions(view, {}));
      expect(result.preparation.pendingGames).toBe(1);
      expect(result.eligibleGames).toBe(0);
    }
  });

  test.each([{ a_since: "2026-02-30" }, { a_since: "2026-10-01", a_until: "2026-09-01" },
    { group_mode: "arbitrary" }, { a_min: "5000", a_max: "4000" }, { limit: "100000" }, { milestone: { $ne: null } }])("invalid controls fail closed: %j", async (bad) => {
    await request(app).get("/v1/trends/explorer/groups").query(bad).set("Authorization", "a").expect(400);
  });
});
