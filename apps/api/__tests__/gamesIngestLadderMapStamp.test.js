// @ts-nocheck
"use strict";

/**
 * Ingest stamps ``isLadderMap`` on each game from the live ladder pool
 * and round-trips the agent's ``playerCount``. These two fields back
 * the FilterBar's ladder/non-ladder and 1v1/team filters; without the
 * stamp the ladder filter matches nothing.
 */

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");

function buildTestApp({ ladderMapPool } = {}) {
  const upserts = [];
  const games = {
    upsert: jest.fn(async (userId, game) => {
      upserts.push(game);
      return true;
    }),
  };
  const opponents = { refreshMetadata: jest.fn(async () => ({})) };
  const auth = (req, _res, next) => {
    req.auth = { userId: "u1" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(buildGamesRouter({ games, opponents, ladderMapPool, auth }));
  return { app, upserts };
}

const baseGame = {
  date: "2026-05-01T00:00:00.000Z",
  result: "Victory",
  myRace: "Zerg",
};

describe("POST /games ladder-map + player-count stamping", () => {
  test("stamps isLadderMap true/false against the resolved pool", async () => {
    const ladderMapPool = {
      get: jest.fn(async () => ({ maps: ["Site Delta", "Goldenaura"] })),
    };
    const { app, upserts } = buildTestApp({ ladderMapPool });

    const res = await request(app)
      .post("/games")
      .send({
        games: [
          { ...baseGame, gameId: "g1", map: "Site Delta LE", playerCount: 2 },
          { ...baseGame, gameId: "g2", map: "Some Arcade Map", playerCount: 6 },
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toHaveLength(2);
    const byId = Object.fromEntries(upserts.map((g) => [g.gameId, g]));
    expect(byId.g1.isLadderMap).toBe(true);
    expect(byId.g1.playerCount).toBe(2);
    expect(byId.g2.isLadderMap).toBe(false);
    expect(byId.g2.playerCount).toBe(6);
  });

  test("leaves isLadderMap unset when no pool is available", async () => {
    const { app, upserts } = buildTestApp({ ladderMapPool: undefined });
    const res = await request(app)
      .post("/games")
      .send({ ...baseGame, gameId: "g3", map: "Site Delta" });
    expect(res.status).toBe(202);
    expect(upserts[0]).not.toHaveProperty("isLadderMap");
  });

  test("ingest still succeeds when the pool lookup throws", async () => {
    const ladderMapPool = {
      get: jest.fn(async () => {
        throw new Error("liquipedia down");
      }),
    };
    const { app, upserts } = buildTestApp({ ladderMapPool });
    const res = await request(app)
      .post("/games")
      .send({ ...baseGame, gameId: "g4", map: "Site Delta" });
    expect(res.status).toBe(202);
    expect(upserts[0].gameId).toBe("g4");
    expect(upserts[0]).not.toHaveProperty("isLadderMap");
  });
});
