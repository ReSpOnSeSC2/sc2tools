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

function buildTestApp({ ladderMapPool, customBuilds } = {}) {
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
  app.use(buildGamesRouter({
    games,
    opponents,
    customBuilds,
    ladderMapPool,
    auth,
    testOnlyAllowMissingReplayIngestAdmission: true,
  }));
  return { app, upserts };
}

const baseGame = {
  date: "2026-05-01T00:00:00.000Z",
  result: "Victory",
  myRace: "Zerg",
};

function capturedTagApp(owner) {
  const events = [], spatial = { my_proxies: [], my_proxy_classification_v: 1 };
  const games = {
    gameStatsWrites: { capture: jest.fn(async () => { events.push("capture"); return owner; }) },
    upsertWithRevision: jest.fn(async () => { events.push("upsert"); return { created: true, customBuildRevision: "stored-revision", spatial }; }),
  };
  const customBuilds = { tagSingleGame: jest.fn()
    .mockImplementationOnce(async () => { events.push("tag"); throw new Error("custom_build_tag_superseded"); })
    .mockImplementation(async () => { events.push("tag"); return { gameId: "owner-tag", userSlug: "saved" }; }) };
  const buildIntents = { bindIngestedGame: jest.fn(async () => { events.push("bind"); }) };
  const guideSamples = { capture: jest.fn(() => { events.push("sample"); }) };
  const app = express(); app.use(express.json());
  app.use(buildGamesRouter({ games, customBuilds, buildIntents, guideSamples,
    opponents: { refreshMetadata: jest.fn(async () => ({})) },
    auth: (req, _res, next) => { req.auth = { userId: "u1" }; next(); }, testOnlyAllowMissingReplayIngestAdmission: true }));
  return { app, events, games, customBuilds, buildIntents, guideSamples, spatial };
}

test("ingest reuses its original owner/revision and publishes only after durable tagging", async () => {
  const owner = { userId: "u1", id: "captured-owner", epoch: "00000000-0000-4000-8000-000000000001", compatibility: false }, h = capturedTagApp(owner);
  const payload = { ...baseGame, gameId: "owner-tag", map: "Site Delta" };
  const failed = await request(h.app).post("/games").send(payload);
  expect(failed.status).toBe(202); expect(failed.body.accepted).toEqual([]);
  expect(failed.body.rejected).toEqual([{ gameId: "owner-tag", retryable: true, errors: ["custom_build_tag_retry_required"] }]);
  expect(h.buildIntents.bindIngestedGame).not.toHaveBeenCalled(); expect(h.guideSamples.capture).not.toHaveBeenCalled();
  const healed = await request(h.app).post("/games").send(payload);
  expect(healed.status).toBe(202); expect(healed.body.rejected).toEqual([]);
  expect(healed.body.accepted).toEqual([expect.objectContaining({ gameId: "owner-tag" })]);
  expect(h.events).toEqual(["capture", "upsert", "tag", "capture", "upsert", "tag", "bind", "sample"]);
  expect(h.games.gameStatsWrites.capture).toHaveBeenCalledTimes(2);
  for (const call of h.games.upsertWithRevision.mock.calls) expect(call[2]).toBe(owner);
  for (const call of h.customBuilds.tagSingleGame.mock.calls) {
    expect(call[2]).toEqual({ expectedRevision: "stored-revision", statsOwner: owner }); expect(call[2].statsOwner).toBe(owner);
    expect(call[1].spatial).toBe(h.spatial);
  }
  expect(h.buildIntents.bindIngestedGame.mock.calls[0][2]).toEqual({ created: true, spatial: h.spatial, statsOwner: owner });
  expect(h.guideSamples.capture.mock.calls[0][1]._customBuildSlug).toBe("saved");
});

describe("POST /games ladder-map + player-count stamping", () => {
  test("rejects oversized item batches before validation or storage work", async () => {
    const ladderMapPool = { get: jest.fn(async () => ({ maps: [] })) };
    const { app, upserts } = buildTestApp({ ladderMapPool });

    const res = await request(app)
      .post("/games")
      .send({ games: Array.from({ length: 51 }, () => null) });

    expect(res.status).toBe(413);
    expect(res.body.error).toEqual(expect.objectContaining({
      code: "replay_batch_too_large",
      maxGames: 50,
    }));
    expect(upserts).toHaveLength(0);
    expect(ladderMapPool.get).not.toHaveBeenCalled();
  });

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
    app.use(buildGamesRouter({
      games,
      opponents,
      auth,
      testOnlyAllowMissingReplayIngestAdmission: true,
    }));

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

  test("does not acknowledge a replay until durable custom tagging heals", async () => {
    const customBuilds = {
      tagSingleGame: jest.fn()
        .mockRejectedValueOnce(new Error("mongo write interrupted"))
        .mockResolvedValueOnce({
          gameId: "tag-retry",
          matched: 1,
          chosen: "PvT 3 Gate",
          ruleCount: 2,
        }),
    };
    const { app } = buildTestApp({ customBuilds });
    const payload = {
      ...baseGame,
      gameId: "tag-retry",
      map: "Site Delta",
      buildLog: ["0:20 Pylon"],
    };

    const failed = await request(app).post("/games").send(payload);
    expect(failed.status).toBe(202);
    expect(failed.body.accepted).toEqual([]);
    expect(failed.body.rejected).toEqual([{
      gameId: "tag-retry",
      retryable: true,
      errors: ["custom_build_tag_retry_required"],
    }]);

    const healed = await request(app).post("/games").send(payload);
    expect(healed.status).toBe(202);
    expect(healed.body.accepted).toEqual([
      expect.objectContaining({ gameId: "tag-retry" }),
    ]);
    expect(healed.body.rejected).toEqual([]);
    expect(customBuilds.tagSingleGame).toHaveBeenCalledTimes(2);
  });

  test("quarantines resume markers before competitive ingest side effects", async () => {
    const games = {
      upsert: jest.fn(),
      quarantineResumedReplay: jest
        .fn()
        .mockResolvedValueOnce({
          created: true,
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
      testOnlyAllowMissingReplayIngestAdmission: true,
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
    expect(roomEmit).toHaveBeenCalledWith("games:changed", { count: 1, inserted: 0, bulk: true, reason: "ingest" });
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
    app.use(buildGamesRouter({
      games,
      opponents,
      users,
      auth,
      testOnlyAllowMissingReplayIngestAdmission: true,
    }));
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
