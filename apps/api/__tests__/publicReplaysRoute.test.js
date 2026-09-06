"use strict";

const express = require("express");
const request = require("supertest");
const { buildPublicReplaysRouter } = require("../src/routes/publicReplays");

function makeDeps(overrides = {}) {
  return {
    users: {
      resolveReplaySharing: jest.fn().mockResolvedValue({
        userId: "owner-1",
        profile: { handle: "owner-1", displayName: "Maru" },
      }),
    },
    replayLibrary: {
      list: jest.fn().mockResolvedValue({
        items: [],
        sourceGames: [],
        hasMore: false,
        nextCursor: null,
      }),
      getDetail: jest.fn().mockResolvedValue(null),
    },
    gameVods: {
      resolveForGames: jest.fn().mockResolvedValue({ linksByGameId: {} }),
    },
    perGame: {
      macroBreakdown: jest.fn().mockResolvedValue(null),
      buildOrder: jest.fn().mockResolvedValue(null),
    },
    replayFiles: {
      prepareDownload: jest.fn(),
    },
    auth: (
      /** @type {import("express").Request} */ req,
      /** @type {import("express").Response} */ res,
      /** @type {import("express").NextFunction} */ next,
    ) => {
      if (req.get("Authorization") !== "Bearer viewer") {
        res.status(401).json({ error: { code: "missing_token" } });
        return;
      }
      req.auth = { userId: "signed-in-viewer", source: "clerk" };
      next();
    },
    rateLimitPerMinute: 1_000,
    ...overrides,
  };
}

/** @param {any} deps */
function makeApp(deps) {
  const app = express();
  app.use(express.json());
  app.use("/v1", buildPublicReplaysRouter(deps));
  app.use(testErrorHandler);
  return app;
}

/** @type {import('express').ErrorRequestHandler} */
const testErrorHandler = (err, _req, res, _next) => {
  res.status(err.status || 500).json({
    error: { code: err.code || "internal_error", message: err.message },
  });
};

describe("public replay archive routes", () => {
  test("does not add generic channel buttons to replays without a matching recording", async () => {
    const deps = makeDeps();
    deps.replayLibrary.list.mockResolvedValue({
      items: [{ gameId: "g1" }], sourceGames: [{ gameId: "g1", myToonHandle: "server-only" }], hasMore: false, nextCursor: null,
    });
    deps.gameVods.resolveForGames.mockResolvedValue({
      linksByGameId: {}, channelsByGameId: { g1: [{
        perspective: "opponent", playerName: "Harstem", userId: "secret", identities: ["secret"],
        channels: { youtube: "https://www.youtube.com/@Harstem", twitch: "javascript:alert(1)", accessToken: "secret" },
      }] },
    });
    const response = await request(makeApp(deps)).get("/v1/public/replays/owner-1").expect(200);
    expect(response.body.items[0]).not.toHaveProperty("playerChannels");
    expect(response.body.items[0].streams).toEqual([]);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|server-only|identities|userId/);
  });

  test("private, unknown and malformed handles share one neutral 404", async () => {
    const deps = makeDeps();
    deps.users.resolveReplaySharing.mockResolvedValue(null);
    const response = await request(makeApp(deps)).get(
      "/v1/public/replays/private-player",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("replay_library_not_found");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(deps.replayLibrary.list).not.toHaveBeenCalled();
  });

  test("lists only allow-listed replay fields and safe VOD links", async () => {
    const deps = makeDeps();
    deps.replayLibrary.list.mockResolvedValue({
      items: [
        {
          gameId: "g1",
          date: "2026-08-29T14:00:00.000Z",
          result: "Victory",
          map: "Ultralove LE",
          durationSec: 754,
          playerCount: 4,
          matchFormat: "team",
          myRace: "Terran",
          myBuild: "2-1-1",
          myMmr: 6100,
          macroScore: 88,
          opponent: {
            displayName: "Dark",
            race: "Zerg",
            mmr: 6050,
            strategy: "Roach pressure",
            toonHandle: "must-not-leak",
          },
          matchup: "TvZ",
          replayAvailable: true,
          replaySizeBytes: 456789,
          replayFile: { sha256: "must-not-leak", key: "must-not-leak" },
          userId: "must-not-leak",
        },
      ],
      sourceGames: [{ gameId: "g1", myToonHandle: "server-only" }],
      hasMore: true,
      nextCursor: "next-page",
    });
    deps.gameVods.resolveForGames.mockResolvedValue({
      linksByGameId: {
        g1: [
          {
            platform: "twitch",
            perspective: "me",
            playerName: "Maru",
            url: "https://twitch.tv/videos/123",
            offsetSec: 90,
          },
          {
            platform: "youtube",
            perspective: "opponent",
            url: "javascript:alert(1)",
            offsetSec: 0,
          },
        ],
      },
    });

    const response = await request(makeApp(deps)).get(
      "/v1/public/replays/owner-1?limit=25&result=win&matchup=TvZ&search=Dark",
    );

    expect(response.status).toBe(200);
    expect(response.body.profile).toEqual({
      handle: "owner-1",
      displayName: "Maru",
    });
    expect(response.body.page).toEqual({
      nextCursor: "next-page",
      hasMore: true,
    });
    expect(response.body.items[0]).toMatchObject({
      gameId: "g1",
      playerCount: 4,
      matchFormat: "team",
      opponent: { displayName: "Dark", race: "Zerg" },
      replayAvailable: true,
      replaySizeBytes: 456789,
      streams: [
        expect.objectContaining({
          platform: "twitch",
          perspective: "me",
        }),
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /must-not-leak|toonHandle|sha256|replayFile|userId/,
    );
    expect(deps.gameVods.resolveForGames).toHaveBeenCalledWith(
      "owner-1",
      [{ gameId: "g1", myToonHandle: "server-only" }],
      { includeOpponent: true },
    );
  });

  test("requires sign-in for analysis and reads the shared owner's data", async () => {
    const deps = makeDeps();
    deps.replayLibrary.getDetail.mockResolvedValue({
      game: {
        gameId: "g1",
        result: "Defeat",
        opponent: { displayName: "Serral", race: "Zerg" },
        replayAvailable: true,
        replaySizeBytes: 1234,
        replayFile: { key: "secret" },
      },
      sourceGame: { gameId: "g1", myToonHandle: "server-only" },
    });
    deps.perGame.macroBreakdown.mockResolvedValue({
      ok: true,
      macro_score: 71,
      raw: { sq: 88, private_blob: "secret" },
      top_3_leaks: [{ name: "Supply block", penalty: 5, internal: "secret" }],
      stats_events: [{ time: 60, army_value: 300, internal: "secret" }],
      unit_timeline: [{ internal: "secret" }],
    });
    deps.perGame.buildOrder.mockResolvedValue({
      ok: true,
      game_id: "g1",
      events: [
        {
          time: 45,
          name: "Barracks",
          display: "Barracks",
          category: "building",
          internal: "secret",
        },
      ],
      opp_events: [],
      my_status: "ok",
      opp_status: "empty",
      raw_log: "secret",
    });

    await request(makeApp(deps))
      .get("/v1/public/replays/owner-1/g1")
      .expect(401);

    const response = await request(makeApp(deps))
      .get("/v1/public/replays/owner-1/g1")
      .set("Authorization", "Bearer viewer");

    expect(response.status).toBe(200);
    expect(deps.replayLibrary.getDetail).toHaveBeenCalledWith("owner-1", "g1");
    expect(deps.perGame.macroBreakdown).toHaveBeenCalledWith("owner-1", "g1");
    expect(deps.perGame.buildOrder).toHaveBeenCalledWith("owner-1", "g1");
    expect(response.body.game).toMatchObject({
      gameId: "g1",
      replayAvailable: true,
      replaySizeBytes: 1234,
    });
    expect(response.body.macroBreakdown).toMatchObject({
      ok: true,
      macro_score: 71,
      raw: { sq: 88 },
      top_3_leaks: [{ name: "Supply block", penalty: 5 }],
      stats_events: [{ time: 60, army_value: 300 }],
    });
    expect(response.body.buildOrder.events[0]).toMatchObject({
      time: 45,
      name: "Barracks",
      category: "building",
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private_blob|unit_timeline|raw_log|internal|secret|server-only/,
    );
  });

  test("issues a short-lived download only while sharing is enabled", async () => {
    const deps = makeDeps();
    deps.replayLibrary.getDetail.mockResolvedValue({
      game: { gameId: "g1", replayAvailable: true },
      sourceGame: { gameId: "g1" },
    });
    deps.replayFiles.prepareDownload.mockResolvedValue({
      url: "https://r2.example.test/signed",
      filename: "Maru-vs-Serral.SC2Replay",
      expiresIn: 60,
    });

    const response = await request(makeApp(deps)).get(
      "/v1/public/replays/owner-1/g1/download",
    );
    expect(response.status).toBe(200);
    expect(response.body.expiresIn).toBe(60);
    expect(deps.replayFiles.prepareDownload).toHaveBeenCalledWith(
      "owner-1",
      "g1",
    );

    deps.users.resolveReplaySharing.mockResolvedValue(null);
    const revoked = await request(makeApp(deps)).get(
      "/v1/public/replays/owner-1/g1/download",
    );
    expect(revoked.status).toBe(404);
  });
});
