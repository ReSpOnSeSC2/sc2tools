// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");

const { buildReplaysRouter } = require("../src/routes/replays");

function testApp(overrides = {}) {
  const replayLibrary = overrides.replayLibrary || {
    list: jest.fn(async () => ({
      items: [{
        gameId: "g-1",
        date: "2026-08-29T12:00:00.000Z",
        result: "Victory",
        map: "Alcyone LE",
        durationSec: 610,
        myRace: "Protoss",
        myBuild: "Blink",
        myMmr: 4200,
        macroScore: 82,
        opponent: {
          displayName: "Rival",
          race: "Terran",
          mmr: 4250,
          strategy: "2-1-1",
        },
        matchup: "PvT",
        replayAvailable: true,
        replaySizeBytes: 123456,
      }],
      sourceGames: [{
        gameId: "g-1",
        myToonHandle: "private-owner-handle",
        opponent: { toonHandle: "private-opponent-handle" },
      }],
      nextCursor: "cursor-2",
      hasMore: true,
    })),
  };
  const users = overrides.users || {
    getProfile: jest.fn(async () => ({ displayName: "Commander" })),
    getReplaySharing: jest.fn(async () => ({
      enabled: false,
      handle: null,
    })),
    setReplaySharing: jest.fn(async (_userId, enabled) => ({
      enabled,
      handle: enabled ? "A".repeat(32) : null,
    })),
  };
  const gameVods = overrides.gameVods || {
    resolveForGames: jest.fn(async () => ({
      configuredPlatforms: ["twitch"],
      linksByGameId: {
        "g-1": [{
          platform: "twitch",
          videoId: "123",
          url: "https://twitch.tv/videos/123?t=10s",
          offsetSec: 10,
          perspective: "me",
          playerName: "Commander",
        }],
      },
    })),
  };
  const auth = (req, res, next) => {
    if (req.get("Authorization") !== "Bearer test") {
      res.status(401).json({ error: { code: "missing_token" } });
      return;
    }
    req.auth = { userId: "owner-id", source: "clerk" };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use("/v1", buildReplaysRouter({ replayLibrary, users, gameVods, auth }));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { code: err.code || "internal_error", message: err.message },
    });
  });
  return { app, replayLibrary, users, gameVods };
}

describe("authenticated replay-library routes", () => {
  test("returns a compact page with resolved VODs and never serializes VOD source identities", async () => {
    const built = testApp();
    const res = await request(built.app)
      .get(
        "/v1/replays?limit=25&sort=date_asc&search=Rival&result=win"
        + "&matchup=PvT&opp_race=T&map=alcyone&regions=NA,EU",
      )
      .set("Authorization", "Bearer test")
      .expect(200);

    expect(built.replayLibrary.list).toHaveBeenCalledWith(
      "owner-id",
      expect.objectContaining({
        limit: "25",
        sort: "date_asc",
        search: "Rival",
        result: "win",
        matchup: "PvT",
        filters: expect.objectContaining({
          oppRace: "T",
          map: "alcyone",
          regions: ["NA", "EU"],
        }),
      }),
    );
    expect(built.gameVods.resolveForGames).toHaveBeenCalledWith(
      "owner-id",
      expect.arrayContaining([expect.objectContaining({ gameId: "g-1" })]),
      { includeOpponent: true },
    );
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      profile: { handle: "owner-id", displayName: "Commander" },
      items: [{
        gameId: "g-1",
        replayAvailable: true,
        replaySizeBytes: 123456,
        streams: [{ platform: "twitch", perspective: "me" }],
      }],
      page: { nextCursor: "cursor-2", hasMore: true },
    });
    expect(JSON.stringify(res.body)).not.toContain("private-owner-handle");
    expect(JSON.stringify(res.body)).not.toContain("private-opponent-handle");
  });

  test("requires auth and keeps VOD provider failures fail-soft", async () => {
    const gameVods = {
      resolveForGames: jest.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const built = testApp({ gameVods });

    await request(built.app).get("/v1/replays").expect(401);
    const res = await request(built.app)
      .get("/v1/replays")
      .set("Authorization", "Bearer test")
      .expect(200);
    expect(res.body.items[0].streams).toEqual([]);
  });

  test("reads and atomically updates the dedicated sharing switch", async () => {
    const built = testApp();
    const read = await request(built.app)
      .get("/v1/me/replay-sharing")
      .set("Authorization", "Bearer test")
      .expect(200);
    expect(read.body).toEqual({ enabled: false, handle: null });

    const updated = await request(built.app)
      .put("/v1/me/replay-sharing")
      .set("Authorization", "Bearer test")
      .send({ enabled: true })
      .expect(200);
    expect(built.users.setReplaySharing).toHaveBeenCalledWith("owner-id", true);
    expect(updated.body).toEqual({ enabled: true, handle: "A".repeat(32) });

    const malformed = await request(built.app)
      .put("/v1/me/replay-sharing")
      .set("Authorization", "Bearer test")
      .send({ enabled: true, publicProfile: true })
      .expect(400);
    expect(malformed.body.error.code).toBe("invalid_replay_sharing");
    expect(built.users.setReplaySharing).toHaveBeenCalledTimes(1);
  });
});
