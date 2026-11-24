// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { buildAggregationsRouter } = require("../src/routes/aggregations");
const { buildAdminRouter } = require("../src/routes/admin");

const A = "1-S2-1-100";
const B = "1-S2-1-200";
const GLOBAL = "/v1/admin/global-trends/mmr-by-matchup";

describe("concrete Net MMR matchups across personal and global routes", () => {
  let mongo;
  let db;
  let app;

  const game = (userId, toon, gameId, minute, race, mmr, result = "Victory", ladderRace = "Random") => ({
    userId, gameId, myToonHandle: toon, myRace: race, myLadderRace: ladderRace,
    date: new Date(Date.UTC(2026, 8, 1, 12, minute)), myMmr: mmr, myMmrSource: "replay",
    isLadderGame: true, playerCount: 2, result, durationSec: 500, map: "Arena",
    opponent: { race: "Zerg", toonHandle: "1-S2-1-999", displayName: "Same Zerg" },
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "net_mmr_matchup_routes" });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.games, db.users, db.pulseAccounts].map((collection) => collection.deleteMany({})));
    await db.games.insertMany([
      game("a", A, "random-p", 0, "Protoss", 4000),
      game("a", A, "random-t", 10, "Terran", 4020, "Defeat"),
      game("a", A, "random-z", 20, "Zerg", 4010),
      game("b", B, "other-p", 0, "Protoss", 5000, "Victory", "Protoss"),
      game("b", B, "other-next", 10, "Protoss", 5040, "Victory", "Protoss"),
      game("copy", A, "random-p", 0, "Protoss", 4000),
    ]);
    app = express();
    app.use("/v1", buildAdminRouter({
      adminGlobalTrends: new AdminGlobalTrendsService({ db }),
      auth: (req, _res, next) => { req.auth = { userId: "admin" }; next(); },
      isAdmin: () => true,
    }));
    app.use("/v1", buildAggregationsRouter({
      aggregations: new AggregationsService(db), macroReport: {}, streak: {},
      auth: (req, _res, next) => { req.auth = { userId: "a" }; next(); },
    }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  });

  test("both endpoints return actual matchups while personal results stay within the uploader", async () => {
    const personal = (await request(app).get("/v1/mmr-by-matchup").query({ group_by: "matchup" }).expect(200)).body;
    expect(personal.matchups).toEqual([
      expect.objectContaining({ matchup: "PvZ", netMmr: 20, pairs: 1 }),
      expect.objectContaining({ matchup: "TvZ", netMmr: -10, pairs: 1 }),
    ]);
    expect(personal.coverage.find((row) => row.matchup === "ZvZ")).toMatchObject({ totalGames: 1, measuredGames: 0 });
    const global = (await request(app).get(GLOBAL).query({ group_by: "matchup" }).expect(200)).body;
    expect(global.matchups).toEqual([
      expect.objectContaining({ matchup: "PvZ", netMmr: 60, pairs: 2 }),
      expect.objectContaining({ matchup: "TvZ", netMmr: -10, pairs: 1 }),
    ]);
    expect(global.totalGames).toBe(5);
    expect(global.dailySwings.measuredGames).toBe(3);
    for (const bar of global.matchups) {
      const drilldown = (await request(app).get(`${GLOBAL}/opponents`).query({ my_race: bar.myRace, opp_race: bar.opponentRace }).expect(200)).body;
      expect(drilldown.summary).toMatchObject({ netMmr: bar.netMmr, pairs: bar.pairs });
    }
    const mine = (await request(app).get("/v1/mmr-by-matchup/opponents").query({ my_race: "P", opp_race: "Z" }).expect(200)).body;
    expect(mine.summary).toMatchObject({ netMmr: 20, pairs: 1 });
  });

  test("older open clients retain opponent-race response shapes until they request matchup grouping", async () => {
    const personal = (await request(app).get("/v1/mmr-by-matchup").expect(200)).body;
    expect(personal.matchups).toEqual([expect.objectContaining({ race: "Z", netMmr: 10, pairs: 2 })]);
    const global = (await request(app).get(GLOBAL).expect(200)).body;
    expect(global.matchups).toEqual([expect.objectContaining({ race: "Z", netMmr: 50, pairs: 3 })]);
  });

  test("global race, player, current-MMR and date filters preserve hidden next readings", async () => {
    const query = {
      excluded_players: B, excluded_races: "T", player_mmr_max: "4500", include_unrated: "false",
      until: "2026-09-01T12:00:00Z", race: "P", map: "Arena",
    };
    const chart = (await request(app).get(GLOBAL).query({ ...query, group_by: "matchup" }).expect(200)).body;
    expect(chart.matchups).toEqual([expect.objectContaining({ matchup: "PvZ", netMmr: 20, pairs: 1 })]);
    const drilldown = (await request(app).get(`${GLOBAL}/opponents`).query({ ...query, my_race: "P", opp_race: "Z" }).expect(200)).body;
    expect(drilldown.summary).toMatchObject({ netMmr: 20, pairs: 1 });
    const excluded = (await request(app).get(`${GLOBAL}/opponents`).query({ ...query, my_race: "T", opp_race: "Z" }).expect(200)).body;
    expect(excluded.items).toEqual([]);
  });

  // The global history can keep one replay for two accounts, so two kept
  // rows of one opponent can tie on (date, gameId). The label then comes
  // from the greater account's row, as the old $sort + $last chose.
  const tied = (userId, toon, gameId, minute, ladderRace, mmr, result, opponent) => ({
    userId, gameId, myToonHandle: toon, myRace: ladderRace, myLadderRace: ladderRace,
    date: new Date(Date.UTC(2026, 8, 1, 12, minute)), myMmr: mmr, myMmrSource: "replay",
    isLadderGame: true, playerCount: 2, matchFormat: "1v1", result, durationSec: 600, map: "Arena", opponent,
  });

  test("global opponent labels on tied replays come from the greater account", async () => {
    await db.games.deleteMany({});
    // One SC2 account uploaded by two users under the S2 and s2 spellings.
    const tagged = (displayName) => ({ displayName, race: "Zerg", toonHandle: "2-S2-1-300", pulseId: "2-S2-1-300" });
    const later = { displayName: "Z1", race: "Zerg", toonHandle: "2-S2-1-301" };
    await db.games.insertMany([
      tied("a", "1-S2-1-100", "r1", 10, "Protoss", 4020, "Victory", tagged("[TAG]Opp")),
      tied("a", "1-S2-1-100", "r2", 20, "Protoss", 4040, "Victory", later),
      tied("alt", "1-s2-1-100", "r1", 10, "Protoss", 4020, "Victory", tagged("Opp")),
      tied("alt", "1-s2-1-100", "r2", 20, "Protoss", 4040, "Victory", later),
    ]);
    const spellings = await new AdminGlobalTrendsService({ db }).run("netMmrByOpponent", {}, {});
    expect(spellings.items).toEqual([expect.objectContaining({ name: "Opp", opponentRace: "Z", netMmr: 40, pairs: 2 })]);
  });

  test("global opponent labels on a replay uploaded by both players come from the greater account", async () => {
    await db.games.deleteMany({});
    // Neither row has opponent ids, so both get the identity "game:shared".
    await db.games.insertMany([
      tied("a", "1-S2-1-100", "shared", 10, "Protoss", 4020, "Victory", { displayName: "PlayerB", race: "Terran" }),
      tied("a", "1-S2-1-100", "a-next", 20, "Protoss", 4040, "Victory", { displayName: "X", race: "Zerg", toonHandle: "2-S2-1-9" }),
      tied("b", "1-S2-1-200", "shared", 10, "Terran", 5000, "Defeat", { displayName: "PlayerA", race: "Protoss" }),
      tied("b", "1-S2-1-200", "b-next", 20, "Terran", 4980, "Victory", { displayName: "Y", race: "Zerg", toonHandle: "2-S2-1-8" }),
    ]);
    const shared = await new AdminGlobalTrendsService({ db }).run("netMmrByOpponent", {}, {});
    expect(shared.items).toEqual([expect.objectContaining({ name: "PlayerA", opponentRace: "P", netMmr: 0, pairs: 2 })]);
  });
});
