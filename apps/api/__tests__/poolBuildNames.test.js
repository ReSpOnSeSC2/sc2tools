// @ts-nocheck
"use strict";

/**
 * util/poolBuildNames.js + POST /games — agents from the 8-worker patch
 * still send "8 Pool" labels; ingest renames them to "12 Pool" on
 * 12-worker games (5.0.17 on, or before 5.0.16) and leaves 5.0.16 games
 * alone.
 */

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");
const { TWELVE_POOL_NAMES, normalizePoolBuildNames } = require("../src/util/poolBuildNames");
const { buildNamesForMatchup, strategyNamesForMatchup } = require("../src/config/guideSlugs");

describe("util/poolBuildNames", () => {
  test("every 12 Pool target is a live catalog name", () => {
    const live = new Set([
      ...buildNamesForMatchup("ZvP"), ...buildNamesForMatchup("ZvZ"), ...strategyNamesForMatchup("PvZ"),
    ]);
    for (const name of Object.values(TWELVE_POOL_NAMES)) expect(live.has(name)).toBe(true);
    for (const name of Object.keys(TWELVE_POOL_NAMES)) expect(live.has(name)).toBe(false);
  });

  test.each([
    ["5.0.17", { gameVersion: "5.0.17.98000" }, true],
    ["5.0.15", { gameVersion: "5.0.15.96883" }, true],
    ["a date from 30 Sep 2026", { date: "2026-10-01T12:00:00.000Z" }, true],
    ["5.0.16", { gameVersion: "5.0.16.97425" }, false],
    ["a date in the 8-worker window", { date: "2026-07-01T12:00:00.000Z" }, false],
    ["no era signal", {}, false],
  ])("a %s game is renamed: %s", (_label, era, renamed) => {
    const game = {
      ...era,
      myBuild: "ZvZ - 8 Pool Speedling",
      opponent: { race: "Zerg", strategy: "Zerg - 8 Pool" },
      opp_strategy: "ZvP - 8 Pool Rush",
    };
    expect(normalizePoolBuildNames(game)).toBe(renamed);
    expect(game).toMatchObject(renamed
      ? { myBuild: "ZvZ - 12 Pool Speedling", opponent: { strategy: "Zerg - 12 Pool" }, opp_strategy: "ZvP - 12 Pool Rush" }
      : { myBuild: "ZvZ - 8 Pool Speedling", opponent: { strategy: "Zerg - 8 Pool" }, opp_strategy: "ZvP - 8 Pool Rush" });
  });

  test("other labels, missing fields and junk are untouched", () => {
    const game = { gameVersion: "5.0.17.98000", myBuild: "ZvZ - 12 Pool Speedling", opponent: { strategy: "toString" } };
    expect(normalizePoolBuildNames(game)).toBe(false);
    expect(game).toEqual({ gameVersion: "5.0.17.98000", myBuild: "ZvZ - 12 Pool Speedling", opponent: { strategy: "toString" } });
    expect(normalizePoolBuildNames({ gameVersion: "5.0.17.98000", opponent: null })).toBe(false);
    expect(normalizePoolBuildNames(null)).toBe(false);
  });
});

describe("POST /games renames 8 Pool labels on 12-worker games", () => {
  function buildTestApp() {
    const upserts = [];
    const games = {
      upsert: jest.fn(async (_userId, game) => {
        upserts.push(game);
        return true;
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(buildGamesRouter({
      games,
      opponents: { refreshMetadata: jest.fn(async () => ({})) },
      auth: (req, _res, next) => {
        req.auth = { userId: "u1" };
        next();
      },
      testOnlyAllowMissingReplayIngestAdmission: true,
    }));
    return { app, upserts };
  }

  test("a 5.0.17 upload is stored as 12 Pool; a 5.0.16 upload keeps 8 Pool", async () => {
    const { app, upserts } = buildTestApp();
    const game = {
      date: "2026-10-01T12:00:00.000Z",
      result: "Victory",
      myRace: "Zerg",
      map: "Site Delta LE",
      myBuild: "Zerg - 8 Pool",
      opponent: { race: "Zerg", strategy: "ZvZ - 8 Pool into Baneling" },
    };
    const res = await request(app).post("/games").send({
      games: [
        { ...game, gameId: "g17", gameVersion: "5.0.17.98000", gameBuild: 98000 },
        { ...game, gameId: "g16", gameVersion: "5.0.16.97425", gameBuild: 97425 },
      ],
    });
    expect(res.status).toBe(202);
    const byId = Object.fromEntries(upserts.map((g) => [g.gameId, g]));
    expect(byId.g17).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "ZvZ - 12 Pool into Baneling" } });
    expect(byId.g16).toMatchObject({ myBuild: "Zerg - 8 Pool", opponent: { strategy: "ZvZ - 8 Pool into Baneling" } });
  });
});
