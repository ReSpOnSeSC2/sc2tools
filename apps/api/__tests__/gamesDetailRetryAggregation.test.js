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

function buildTestApp(gameDetails, opponents, replayFiles = null) {
  const games = new GamesService(db, { gameDetails });
  const auth = (req, _res, next) => {
    req.auth = { userId: "u-detail-retry" };
    next();
  };
  const app = express();
  app.use(express.json());
  const archiveVerifier = replayFiles || {
    verifyAvailableMarker: jest.fn(async () => true),
  };
  app.use(buildGamesRouter({
    games,
    opponents,
    replayFiles: archiveVerifier,
    auth,
  }));
  app.locals.gamesService = games;
  app.locals.replayFiles = archiveVerifier;
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
      {
        gameId: payload.gameId,
        created: true,
        replayArchive: { available: false },
      },
    ]);
    expect(opponents.recordGame).toHaveBeenCalledTimes(1);
    expect(opponents.refreshMetadata).not.toHaveBeenCalled();

    const duplicate = await request(app).post("/games").send(payload);

    expect(duplicate.status).toBe(202);
    expect(duplicate.body.accepted).toEqual([
      {
        gameId: payload.gameId,
        created: false,
        replayArchive: { available: false },
      },
    ]);
    expect(opponents.recordGame).toHaveBeenCalledTimes(1);
    expect(opponents.refreshMetadata).toHaveBeenCalledTimes(1);
    const storedAt = new Date("2026-08-12T16:00:00.000Z");
    await db.games.updateOne(
      { userId: "u-detail-retry", gameId: payload.gameId },
      {
        $set: {
          replayFile: {
            storedAt,
            sizeBytes: 123456,
            sha256: "a".repeat(64),
            uploadId: "private-upload-nonce",
          },
        },
      },
    );

    const archivedDuplicate = await request(app).post("/games").send(payload);

    expect(archivedDuplicate.status).toBe(202);
    expect(archivedDuplicate.body.accepted).toEqual([
      {
        gameId: payload.gameId,
        created: false,
        replayArchive: {
          available: true,
          sizeBytes: 123456,
          sha256: "a".repeat(64),
          storedAt: storedAt.toISOString(),
        },
      },
    ]);
    expect(archivedDuplicate.body.accepted[0].replayArchive).not.toHaveProperty(
      "uploadId",
    );
    expect(opponents.recordGame).toHaveBeenCalledTimes(1);
    expect(opponents.refreshMetadata).toHaveBeenCalledTimes(2);
    expect(gameDetails.upsert).toHaveBeenCalledTimes(4);
  });

  test("an archive-marker lookup failure never reports a replay as stored", async () => {
    const gameDetails = { upsert: jest.fn(async () => undefined) };
    const opponents = {
      recordGame: jest.fn(async () => ({})),
      refreshMetadata: jest.fn(async () => ({})),
    };
    const app = buildTestApp(gameDetails, opponents);
    app.locals.gamesService.replayArchiveMarkers = jest
      .fn()
      .mockRejectedValue(new Error("Mongo temporarily unavailable"));

    const response = await request(app).post("/games").send({
      gameId: "marker-lookup-failure",
      date: "2026-08-12T17:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Site Delta",
      buildLog: [],
    });

    expect(response.status).toBe(202);
    expect(response.body.accepted).toEqual([
      { gameId: "marker-lookup-failure", created: true },
    ]);
    expect(response.body.rejected).toEqual([]);
  });

  test("a stale archive marker falls back to upload after verification", async () => {
    const gameDetails = { upsert: jest.fn(async () => undefined) };
    const opponents = {
      recordGame: jest.fn(async () => ({})),
      refreshMetadata: jest.fn(async () => ({})),
    };
    const replayFiles = {
      verifyAvailableMarker: jest.fn(async () => false),
    };
    const app = buildTestApp(gameDetails, opponents, replayFiles);
    const gameId = "stale-archive-marker";
    const storedAt = new Date("2026-08-12T16:00:00.000Z");
    await db.games.insertOne({
      userId: "u-detail-retry",
      gameId,
      date: storedAt,
      replayFile: {
        storedAt,
        sizeBytes: 8,
        sha256: "a".repeat(64),
      },
    });

    const response = await request(app).post("/games").send({
      gameId,
      date: storedAt.toISOString(),
      result: "Victory",
      myRace: "Protoss",
      map: "Site Delta",
      buildLog: [],
    });

    expect(response.status).toBe(202);
    expect(response.body.accepted[0].replayArchive).toEqual({
      available: false,
    });
    expect(replayFiles.verifyAvailableMarker).toHaveBeenCalledTimes(1);
  });

  test("an archive HEAD error omits the shortcut and preserves normal repair", async () => {
    const gameDetails = { upsert: jest.fn(async () => undefined) };
    const opponents = {
      recordGame: jest.fn(async () => ({})),
      refreshMetadata: jest.fn(async () => ({})),
    };
    const replayFiles = {
      verifyAvailableMarker: jest.fn(async () => {
        throw new Error("R2 temporarily unavailable");
      }),
    };
    const app = buildTestApp(gameDetails, opponents, replayFiles);
    const gameId = "archive-head-error";
    const storedAt = new Date("2026-08-12T16:00:00.000Z");
    await db.games.insertOne({
      userId: "u-detail-retry",
      gameId,
      date: storedAt,
      replayFile: {
        storedAt,
        sizeBytes: 8,
        sha256: "a".repeat(64),
      },
    });

    const response = await request(app).post("/games").send({
      gameId,
      date: storedAt.toISOString(),
      result: "Victory",
      myRace: "Protoss",
      map: "Site Delta",
      buildLog: [],
    });

    expect(response.status).toBe(202);
    expect(response.body.accepted[0]).not.toHaveProperty("replayArchive");
    expect(response.body.rejected).toEqual([]);
  });

  test("one R2 outage stops marker HEAD retries for the rest of the batch", async () => {
    const gameDetails = { upsert: jest.fn(async () => undefined) };
    const opponents = {
      recordGame: jest.fn(async () => ({})),
      refreshMetadata: jest.fn(async () => ({})),
    };
    const replayFiles = {
      verifyAvailableMarker: jest.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    };
    const app = buildTestApp(gameDetails, opponents, replayFiles);
    const storedAt = new Date("2026-08-12T16:00:00.000Z");
    const games = ["r2-outage-1", "r2-outage-2", "r2-outage-3"];
    await db.games.insertMany(games.map((gameId) => ({
      userId: "u-detail-retry",
      gameId,
      date: storedAt,
      replayFile: {
        storedAt,
        sizeBytes: 8,
        sha256: "a".repeat(64),
      },
    })));

    const response = await request(app).post("/games").send({
      games: games.map((gameId) => ({
        gameId,
        date: storedAt.toISOString(),
        result: "Victory",
        myRace: "Protoss",
        map: "Site Delta",
        buildLog: [],
      })),
    });

    expect(response.status).toBe(202);
    expect(response.body.accepted).toHaveLength(3);
    expect(replayFiles.verifyAvailableMarker).toHaveBeenCalledTimes(1);
    expect(response.body.accepted.every(
      (item) => item.replayArchive === undefined,
    )).toBe(true);
  });
});
