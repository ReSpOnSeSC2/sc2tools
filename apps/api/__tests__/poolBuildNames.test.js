// @ts-nocheck
"use strict";

/**
 * util/poolBuildNames.js + POST /games — the pool-first openers are
 * "8 Pool" on the 8-worker patch 5.0.16 and "12 Pool" before it and from
 * 5.0.17 on. Older agents send one name for every patch; ingest stores the
 * name of the game's own patch.
 */

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");
const {
  TWELVE_POOL_NAMES,
  EIGHT_POOL_NAMES,
  poolNameForGame,
  normalizePoolBuildNames,
} = require("../src/util/poolBuildNames");
const { buildNamesForMatchup, strategyNamesForMatchup } = require("../src/config/guideSlugs");

const TWELVE = {
  myBuild: "ZvZ - 12 Pool Speedling", opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" }, opp_strategy: "ZvP - 12 Pool Rush",
};
const EIGHT = {
  myBuild: "ZvZ - 8 Pool Speedling", opponent: { race: "Zerg", strategy: "Zerg - 8 Pool" }, opp_strategy: "ZvP - 8 Pool Rush",
};

describe("util/poolBuildNames", () => {
  test("the 12 Pool names are the catalog's; the 8 Pool names are the 8-worker patch's", () => {
    const live = new Set([
      ...buildNamesForMatchup("ZvP"), ...buildNamesForMatchup("ZvZ"), ...strategyNamesForMatchup("PvZ"),
    ]);
    for (const name of Object.values(TWELVE_POOL_NAMES)) expect(live.has(name)).toBe(true);
    for (const name of Object.keys(TWELVE_POOL_NAMES)) expect(live.has(name)).toBe(false);
    for (const [eight, twelve] of Object.entries(TWELVE_POOL_NAMES)) expect(EIGHT_POOL_NAMES[twelve]).toBe(eight);
  });

  test.each([
    ["5.0.17", { gameVersion: "5.0.17.98000" }, TWELVE],
    ["5.0.15", { gameVersion: "5.0.15.96883" }, TWELVE],
    ["date-only from 30 Sep 2026", { date: "2026-10-01T12:00:00.000Z" }, TWELVE],
    ["5.0.16", { gameVersion: "5.0.16.97425" }, EIGHT],
    ["date-only 8-worker", { date: "2026-07-01T12:00:00.000Z" }, EIGHT],
  ])("a %s game gets its patch's names from either spelling", (_label, era, expected) => {
    for (const sent of [TWELVE, EIGHT]) {
      const game = { ...era, ...structuredClone(sent) };
      expect(normalizePoolBuildNames(game)).toBe(sent !== expected);
      expect(game).toMatchObject(expected);
    }
  });

  test("a game with no era signal keeps what it was sent", () => {
    for (const sent of [TWELVE, EIGHT]) {
      const game = structuredClone(sent);
      expect(normalizePoolBuildNames(game)).toBe(false);
      expect(game).toEqual(sent);
    }
  });

  test("other labels, missing fields and junk are untouched", () => {
    const game = { gameVersion: "5.0.16.97425", myBuild: "ZvZ - Ling Bane All-in", opponent: { strategy: "toString" } };
    expect(normalizePoolBuildNames(game)).toBe(false);
    expect(game).toEqual({ gameVersion: "5.0.16.97425", myBuild: "ZvZ - Ling Bane All-in", opponent: { strategy: "toString" } });
    expect(normalizePoolBuildNames({ gameVersion: "5.0.17.98000", opponent: null })).toBe(false);
    expect(normalizePoolBuildNames(null)).toBe(false);
    expect(poolNameForGame(undefined, { gameVersion: "5.0.16.97425" })).toBeUndefined();
  });
});

describe("POST /games stores each pool opener under its patch's name", () => {
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

  test("a 5.0.17 upload is stored as 12 Pool and a 5.0.16 upload as 8 Pool", async () => {
    const { app, upserts } = buildTestApp();
    const game = {
      date: "2026-10-01T12:00:00.000Z",
      result: "Victory",
      myRace: "Zerg",
      map: "Site Delta LE",
    };
    const res = await request(app).post("/games").send({
      games: [
        {
          ...game, gameId: "g17", gameVersion: "5.0.17.98000", gameBuild: 98000,
          myBuild: "Zerg - 8 Pool", opponent: { race: "Zerg", strategy: "ZvZ - 8 Pool into Baneling" },
        },
        {
          ...game, gameId: "g16", gameVersion: "5.0.16.97425", gameBuild: 97425,
          myBuild: "Zerg - 12 Pool", opponent: { race: "Zerg", strategy: "ZvZ - 12 Pool into Baneling" },
        },
      ],
    });
    expect(res.status).toBe(202);
    const byId = Object.fromEntries(upserts.map((g) => [g.gameId, g]));
    expect(byId.g17).toMatchObject({ myBuild: "Zerg - 12 Pool", opponent: { strategy: "ZvZ - 12 Pool into Baneling" } });
    expect(byId.g16).toMatchObject({ myBuild: "Zerg - 8 Pool", opponent: { strategy: "ZvZ - 8 Pool into Baneling" } });
  });
});
