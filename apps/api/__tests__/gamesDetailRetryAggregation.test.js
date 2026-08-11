// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildGamesRouter } = require("../src/routes/games");
const { GamesService } = require("../src/services/games");

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({
    uri: mongo.getUri(),
    dbName: "sc2tools_test_game_detail_retry_aggregation",
  });
});

afterEach(async () => {
  await db.games.deleteMany({});
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

function buildTestApp(gameDetails, opponents) {
  const games = new GamesService(db, { gameDetails });
  const auth = (req, _res, next) => {
    req.auth = { userId: "u-detail-retry" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(buildGamesRouter({ games, opponents, auth }));
  return app;
}

describe("POST /games detail-store retry aggregation", () => {
  test("a failed detail write leaves creation and opponent aggregation for the successful retry", async () => {
    const gameDetails = {
      upsert: jest.fn()
        .mockRejectedValueOnce(new Error("r2 temporarily unavailable"))
        .mockResolvedValue(undefined),
    };
    const opponents = {
      recordGame: jest.fn(async () => ({})),
      refreshMetadata: jest.fn(async () => ({})),
    };
    const app = buildTestApp(gameDetails, opponents);
    const payload = {
      gameId: "game-detail-retry",
      date: "2026-08-10T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Site Delta",
      buildLog: [],
      opponent: {
        pulseId: "1-S2-1-12345",
        displayName: "RetryOpponent",
        race: "Terran",
        opening: "Bio",
      },
    };

    const failed = await request(app).post("/games").send(payload);

    expect(failed.status).toBe(202);
    expect(failed.body.accepted).toEqual([]);
    expect(failed.body.rejected).toEqual([
      expect.objectContaining({
        gameId: payload.gameId,
        retryable: true,
      }),
    ]);
    expect(
      await db.games.findOne({
        userId: "u-detail-retry",
        gameId: payload.gameId,
      }),
    ).toBeNull();
    expect(opponents.recordGame).not.toHaveBeenCalled();

    const retried = await request(app).post("/games").send(payload);

    expect(retried.status).toBe(202);
    expect(retried.body.accepted).toEqual([
      { gameId: payload.gameId, created: true },
    ]);
    expect(opponents.recordGame).toHaveBeenCalledTimes(1);
    expect(opponents.refreshMetadata).not.toHaveBeenCalled();

    const duplicate = await request(app).post("/games").send(payload);

    expect(duplicate.status).toBe(202);
    expect(duplicate.body.accepted).toEqual([
      { gameId: payload.gameId, created: false },
    ]);
    expect(opponents.recordGame).toHaveBeenCalledTimes(1);
    expect(opponents.refreshMetadata).toHaveBeenCalledTimes(1);
    expect(gameDetails.upsert).toHaveBeenCalledTimes(3);
  });
});
