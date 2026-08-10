// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");

function buildTestApp({ rows = [], single = null, withService = true } = {}) {
  const games = {
    list: jest.fn(async () => ({ items: rows, nextBefore: null })),
    get: jest.fn(async () => single),
    findMany: jest.fn(async (_userId, ids) =>
      ids.map((id) => rows.find((row) => row.gameId === id)).filter(Boolean),
    ),
  };
  const gameVods = withService
    ? {
        resolveForGames: jest.fn(async (_userId, candidates) => ({
          configuredPlatforms: ["twitch"],
          linksByGameId: Object.fromEntries(
            candidates.map((game) => [game.gameId, []]),
          ),
        })),
      }
    : undefined;
  const opponents = { refreshMetadata: jest.fn(async () => ({})) };
  const auth = (req, _res, next) => {
    req.auth = { userId: "u1" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(buildGamesRouter({ games, opponents, gameVods, auth }));
  return { app, games, gameVods };
}

describe("GET /games/vod-links", () => {
  test("resolves one game by id for the detail page", async () => {
    const single = {
      gameId: "game/42",
      date: new Date("2026-08-10T19:11:20.000Z"),
      durationSec: 780,
    };
    const { app, games, gameVods } = buildTestApp({ single });

    const res = await request(app).get(
      "/games/vod-links?gameId=game%2F42",
    );

    expect(res.status).toBe(200);
    expect(games.get).toHaveBeenCalledWith("u1", "game/42");
    expect(gameVods.resolveForGames).toHaveBeenCalledWith("u1", [single], {
      includeOpponent: true,
    });
    expect(res.body.configuredPlatforms).toEqual(["twitch"]);
  });

  test("filters a visible date range and resolves it in one batch", async () => {
    const rows = [
      { gameId: "new", date: new Date("2026-08-10T20:00:00.000Z") },
      { gameId: "visible", date: new Date("2026-08-10T19:00:00.000Z") },
      { gameId: "old", date: new Date("2026-08-09T19:00:00.000Z") },
    ];
    const { app, games, gameVods } = buildTestApp({ rows });

    const res = await request(app).get(
      "/games/vod-links" +
        "?since=2026-08-10T18%3A00%3A00.000Z" +
        "&until=2026-08-10T20%3A00%3A00.000Z",
    );

    expect(res.status).toBe(200);
    expect(games.list).toHaveBeenCalledWith("u1", {
      before: new Date("2026-08-10T20:00:00.001Z"),
      limit: 2000,
    });
    expect(gameVods.resolveForGames).toHaveBeenCalledWith(
      "u1",
      [rows[0], rows[1]],
      { includeOpponent: false },
    );
    expect(Object.keys(res.body.linksByGameId)).toEqual(["new", "visible"]);
  });

  test("rejects a missing or reversed range before scanning games", async () => {
    const { app, games, gameVods } = buildTestApp();
    const missing = await request(app).get("/games/vod-links");
    const reversed = await request(app).get(
      "/games/vod-links" +
        "?since=2026-08-11T00%3A00%3A00.000Z" +
        "&until=2026-08-10T00%3A00%3A00.000Z",
    );

    expect(missing.status).toBe(400);
    expect(reversed.status).toBe(400);
    expect(games.list).not.toHaveBeenCalled();
    expect(gameVods.resolveForGames).not.toHaveBeenCalled();
  });

  test("degrades to an empty response when the optional resolver is absent", async () => {
    const { app } = buildTestApp({
      single: { gameId: "g1", date: new Date(), durationSec: 60 },
      withService: false,
    });
    const res = await request(app).get("/games/vod-links?gameId=g1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configuredPlatforms: [], linksByGameId: {} });
  });

  test("resolves exactly the visible opponent-dossier games in one batch", async () => {
    const rows = [
      { gameId: "merged-a", date: new Date("2026-08-10T19:00:00Z") },
      { gameId: "merged-b", date: new Date("2026-08-09T19:00:00Z") },
      { gameId: "not-visible", date: new Date("2026-08-08T19:00:00Z") },
    ];
    const { app, games, gameVods } = buildTestApp({ rows });

    const res = await request(app)
      .post("/games/vod-links")
      .send({ gameIds: ["merged-b", "merged-a"], includeOpponent: true });

    expect(res.status).toBe(200);
    expect(games.findMany).toHaveBeenCalledWith("u1", [
      "merged-b",
      "merged-a",
    ]);
    expect(gameVods.resolveForGames).toHaveBeenCalledWith(
      "u1",
      [rows[1], rows[0]],
      { includeOpponent: true },
    );
  });

  test("rejects an empty, duplicate, or oversized explicit game-id batch", async () => {
    const { app, games, gameVods } = buildTestApp();
    const empty = await request(app).post("/games/vod-links").send({ gameIds: [] });
    const duplicate = await request(app)
      .post("/games/vod-links")
      .send({ gameIds: ["g1", "g1"] });
    const oversized = await request(app)
      .post("/games/vod-links")
      .send({ gameIds: Array.from({ length: 1001 }, (_, i) => `g${i}`) });

    expect(empty.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(games.findMany).not.toHaveBeenCalled();
    expect(gameVods.resolveForGames).not.toHaveBeenCalled();
  });
});
