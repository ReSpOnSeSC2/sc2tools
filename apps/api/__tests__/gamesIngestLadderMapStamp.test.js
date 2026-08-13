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

  test("classifies a retired ladder map as ladder (current pool need not list it)", async () => {
    // Catalyst LE hasn't been in the rotation for years; the live pool
    // stub doesn't list it, but the baked-in all-seasons set does — so
    // it must still classify as ladder rather than leaking into Custom.
    const ladderMapPool = {
      get: jest.fn(async () => ({ maps: ["Site Delta"], teamMaps: [] })),
    };
    const { app, upserts } = buildTestApp({ ladderMapPool });
    const res = await request(app)
      .post("/games")
      .send({ ...baseGame, gameId: "gRetired", map: "Catalyst LE" });
    expect(res.status).toBe(202);
    expect(upserts[0].isLadderMap).toBe(true);
  });

  test("classifies from the baked-in list even without a live pool", async () => {
    const { app, upserts } = buildTestApp({ ladderMapPool: undefined });
    const res = await request(app)
      .post("/games")
      .send({
        games: [
          { ...baseGame, gameId: "g3", map: "Site Delta" },
          { ...baseGame, gameId: "g3b", map: "My Custom Arcade Box" },
        ],
      });
    expect(res.status).toBe(202);
    const byId = Object.fromEntries(upserts.map((g) => [g.gameId, g]));
    expect(byId.g3.isLadderMap).toBe(true);
    expect(byId.g3b.isLadderMap).toBe(false);
  });

  test("isLadderGame (authoritative) overrides the map-name proxy", async () => {
    const ladderMapPool = {
      get: jest.fn(async () => ({ maps: ["Site Delta"], teamMaps: [] })),
    };
    const { app, upserts } = buildTestApp({ ladderMapPool });
    const res = await request(app)
      .post("/games")
      .send({
        games: [
          // Custom game ON a ladder map → proxy says ladder, flag says custom.
          { ...baseGame, gameId: "customOnLadder", map: "Site Delta LE", isLadderGame: false },
          // Ladder game on an unknown/new map → proxy says custom, flag says ladder.
          { ...baseGame, gameId: "ladderOnUnknown", map: "Brand New Unlisted Map", isLadderGame: true },
        ],
      });
    expect(res.status).toBe(202);
    const byId = Object.fromEntries(upserts.map((g) => [g.gameId, g]));
    expect(byId.customOnLadder.isLadderMap).toBe(false);
    expect(byId.ladderOnUnknown.isLadderMap).toBe(true);
  });

  test("ingest still succeeds (and classifies) when the pool lookup throws", async () => {
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
    // Falls back to the baked-in list, so it's still classified.
    expect(upserts[0].isLadderMap).toBe(true);
  });

  test("marks post-validation storage failures as retryable", async () => {
    const games = {
      upsert: jest.fn(async () => {
        throw new Error("r2 temporarily unavailable");
      }),
    };
    const opponents = { refreshMetadata: jest.fn(async () => ({})) };
    const auth = (req, _res, next) => {
      req.auth = { userId: "u1" };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(buildGamesRouter({ games, opponents, auth }));

    const res = await request(app)
      .post("/games")
      .send({ ...baseGame, gameId: "r2-retry", map: "Site Delta" });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected).toEqual([
      expect.objectContaining({
        gameId: "r2-retry",
        retryable: true,
        errors: [expect.stringMatching(/upsert_failed.*r2 temporarily/i)],
      }),
    ]);
  });

  test("quarantines resume markers before competitive ingest side effects", async () => {
    const games = {
      upsert: jest.fn(),
      quarantineResumedReplay: jest
        .fn()
        .mockResolvedValueOnce({
          created: false,
          newlyFlaggedExisting: 3,
          gameIds: ["resume-3", "resume-1", "resume-2"],
        })
        .mockResolvedValueOnce({
          created: false,
          newlyFlaggedExisting: 0,
          gameIds: ["resume-3", "resume-1", "resume-2"],
        }),
    };
    const opponents = {
      recordGame: jest.fn(),
      refreshMetadata: jest.fn(),
      repairResumedReplayCountersForUser: jest.fn(async () => 3),
    };
    const users = {
      addPulseId: jest.fn(),
      repairLastKnownMmrAfterResumedReplay: jest.fn(async () => true),
    };
    const customBuilds = { tagSingleGame: jest.fn() };
    const roomEmit = jest.fn();
    const io = {
      to: jest.fn(() => ({ emit: roomEmit })),
      in: jest.fn(() => ({ fetchSockets: jest.fn(async () => []) })),
    };
    const auth = (req, _res, next) => {
      req.auth = { userId: "u1" };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(buildGamesRouter({
      games,
      opponents,
      users,
      customBuilds,
      io,
      auth,
    }));
    const marker = {
      ...baseGame,
      gameId: "resume-3",
      map: "Old Sun Temple LE",
      opponent: { pulseId: "zulrah", displayName: "Zulrah", race: "Zerg" },
      myToonHandle: "1-S2-1-123",
      isResumedFromReplay: true,
      resumedReplayGameIds: ["resume-1", "resume-2"],
    };

    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).post("/games").send(marker);
      expect(res.status).toBe(202);
      expect(res.body.accepted).toEqual([
        expect.objectContaining({ gameId: "resume-3", quarantined: true }),
      ]);
    }
    expect(games.quarantineResumedReplay).toHaveBeenCalledTimes(2);
    expect(opponents.repairResumedReplayCountersForUser).toHaveBeenCalledTimes(2);
    expect(users.repairLastKnownMmrAfterResumedReplay).toHaveBeenCalledTimes(2);
    expect(users.repairLastKnownMmrAfterResumedReplay).toHaveBeenCalledWith("u1");
    expect(games.upsert).not.toHaveBeenCalled();
    expect(opponents.recordGame).not.toHaveBeenCalled();
    expect(opponents.refreshMetadata).not.toHaveBeenCalled();
    expect(users.addPulseId).not.toHaveBeenCalled();
    expect(customBuilds.tagSingleGame).not.toHaveBeenCalled();
    expect(roomEmit).toHaveBeenCalledWith("games:changed", { count: 1 });
    expect(io.in).not.toHaveBeenCalled();
  });

  test("a failed quarantine counter rebuild is retryable and heals on retry", async () => {
    const games = {
      upsert: jest.fn(),
      quarantineResumedReplay: jest.fn(async () => ({
        created: false,
        newlyFlaggedExisting: 0,
        gameIds: ["resume-retry"],
      })),
    };
    const opponents = {
      refreshMetadata: jest.fn(),
      repairResumedReplayCountersForUser: jest
        .fn()
        .mockRejectedValueOnce(new Error("mongo temporarily unavailable"))
        .mockResolvedValueOnce(1),
    };
    const users = {
      repairLastKnownMmrAfterResumedReplay: jest.fn(async () => false),
    };
    const auth = (req, _res, next) => {
      req.auth = { userId: "u1" };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(buildGamesRouter({ games, opponents, users, auth }));
    const marker = {
      ...baseGame,
      gameId: "resume-retry",
      map: "Old Sun Temple LE",
      isResumedFromReplay: true,
    };

    const failed = await request(app).post("/games").send(marker);
    expect(failed.body.accepted).toEqual([]);
    expect(failed.body.rejected).toEqual([
      expect.objectContaining({
        gameId: "resume-retry",
        retryable: true,
        errors: [expect.stringMatching(/quarantine_repair_failed/)],
      }),
    ]);

    const retried = await request(app).post("/games").send(marker);
    expect(retried.body.rejected).toEqual([]);
    expect(retried.body.accepted).toEqual([
      expect.objectContaining({ gameId: "resume-retry", quarantined: true }),
    ]);
    expect(opponents.repairResumedReplayCountersForUser).toHaveBeenCalledTimes(2);
    expect(users.repairLastKnownMmrAfterResumedReplay).toHaveBeenCalledTimes(1);
  });
});
