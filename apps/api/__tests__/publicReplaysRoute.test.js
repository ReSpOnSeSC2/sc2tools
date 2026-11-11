"use strict";

const express = require("express");
const request = require("supertest");
const { buildPublicReplaysRouter, publicMacroBreakdown } = require("../src/routes/publicReplays");
const { reviewMacroBreakdown } = require("../src/services/reviewRedaction");
const { sanitiseRequestUrl } = require("../src/middleware/requestLogging");

describe.each([publicMacroBreakdown, reviewMacroBreakdown])("shared casualty redaction (%#)", (redact) => {
  const event = { time: 123.45, owner: "opp", killer: "me", category: "workers", name: "Drone" };

  test("preserves exact relative-owner events and drops arbitrary nested metadata", () => {
    const events = [event, { time: 150, owner: "me", killer: null, category: "units", name: "Marine" },
      { time: 200, owner: "me", killer: "opp", category: "buildings", name: "Nexus" }];
    const out = redact({ ok: true, casualty_events: events.map((entry) => ({ ...entry,
      playerName: "secret", replayHash: "private", nested: { identity: "hidden" },
    })) });
    expect(out?.casualty_events).toEqual(events);
  });

  test("keeps unavailable data distinguishable from verified zero casualties", () => {
    expect(redact({ ok: true })).not.toHaveProperty("casualty_events");
    expect(redact({ ok: true, casualty_events: [] })).toHaveProperty("casualty_events", []);
  });

  test.each([null, [{ ...event, killer: undefined }], [{ ...event, time: -1 }],
    [event, { ...event, name: "X".repeat(65) }], Array(20001).fill(event)])(
    "omits a malformed or oversized ledger entirely (%#)", (casualty_events) => {
      expect(redact({ ok: true, casualty_events })).not.toHaveProperty("casualty_events");
    },
  );
});

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
      neighbors: jest.fn().mockResolvedValue({ olderGameId: null, newerGameId: null }),
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

const REFERENCE = "r-0123456789abcdef01234567";
const OLDER = "r-0123456789abcdef01234568";

describe("public replay archive routes", () => {
  test("serves an opaque card without auth, analysis data, or opponent identity", async () => {
    const deps = makeDeps();
    deps.replayLibrary.getDetail.mockResolvedValue({
      game: {
        gameId: "legacy|private-rival|Map", publicReference: REFERENCE, result: "Victory", matchup: "TvZ",
        map: "Alcyone LE", durationSec: 600, myBuild: "2-1-1", date: "2026-09-01T00:00:00Z",
        opponent: { displayName: "private-rival", pulseId: "private-pulse", strategy: "Roach pressure" },
      },
    });
    const app = makeApp(deps);
    const base = "/v1/public/replays/owner-1/";
    const response = await request(app).get(base + REFERENCE + "/card").expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({ profile: { handle: "owner-1", displayName: "Maru" }, game: {
      result: "Victory", matchup: "TvZ", map: "Alcyone LE", durationSec: 600,
      myBuild: "2-1-1", oppStrategy: "Roach pressure", date: "2026-09-01T00:00:00.000Z", replayAvailable: false,
    } });
    expect(deps.replayLibrary.getDetail).toHaveBeenCalledWith("owner-1", REFERENCE, { view: "detector", publicReference: true });
    expect(deps.perGame.macroBreakdown).not.toHaveBeenCalled();
    await request(app).get(base + "legacy/card").expect(404);
    deps.replayLibrary.getDetail.mockResolvedValue(null);
    await request(app).get(base + REFERENCE + "/card").expect(404);
    deps.users.resolveReplaySharing.mockResolvedValue(null);
    await request(app).get(base + REFERENCE + "/card").expect(404);
  });
  test("analysis neighbors contain only shareable game IDs and ignore pagination", async () => {
    const deps = makeDeps(); deps.replayLibrary.getDetail.mockResolvedValue({ game: { gameId: "g1", publicReference: REFERENCE }, sourceGame: { gameId: "g1" } });
    deps.replayLibrary.neighbors.mockResolvedValue({ olderGameId: OLDER, newerGameId: null, userId: "secret", _id: "secret" });
    const response = await request(makeApp(deps)).get("/v1/public/replays/owner-1/g1?map=Alcyone&result=loss&matchup=PvZ&search=Blink&cursor=ignore&page=3").set("Authorization", "Bearer viewer").expect(200);
    expect(response.body.neighbors).toEqual({ olderGameId: OLDER, newerGameId: null }); expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(deps.replayLibrary.neighbors).toHaveBeenCalledWith("owner-1", "g1", { filters: { map: "alcyone" }, result: "loss", matchup: "PvZ", search: "Blink", publicReferences: true });
  });
  test("summary and facets are strictly allow-listed, numeric and bounded", async () => {
    const deps = makeDeps();
    deps.replayLibrary.list.mockResolvedValue({ items: [], sourceGames: [], hasMore: false, nextCursor: null,
      summary: { total: 312, wins: 180, losses: 129, ties: 3, avgDurationSec: 785, userId: "secret", opponentNames: ["secret"] },
      facets: { maps: ["Alcyone LE", { name: "secret" }, "Alcyone LE"], matchups: ["PvZ", "secret", { userId: "secret" }], owner: "secret" },
    });
    const response = await request(makeApp(deps)).get("/v1/public/replays/owner-1?map=Alcyone&build=Blink").expect(200);
    expect(response.body.summary).toEqual({ total: 312, wins: 180, losses: 129, ties: 3, avgDurationSec: 785 });
    expect(response.body.total).toBe(312); expect(response.body.facets).toEqual({ maps: ["Alcyone LE"], matchups: ["PvZ"] }); expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(deps.replayLibrary.list).toHaveBeenCalledWith("owner-1", expect.objectContaining({ withSummary: true, view: "detector", filters: { map: "alcyone", build: "Blink" } }));
  });
  test("profile-only reads resolve sharing without listing rows or resolving VODs", async () => {
    const deps = makeDeps();
    const response = await request(makeApp(deps)).get("/v1/public/replays/owner-1?limit=1&fields=profile").expect(200);
    expect(response.body).toEqual({ profile: { handle: "owner-1", displayName: "Maru" }, items: [], page: { hasMore: false } });
    expect(deps.replayLibrary.list).not.toHaveBeenCalled();
    expect(deps.gameVods.resolveForGames).not.toHaveBeenCalled();
  });

  test("does not add generic channel buttons to replays without a matching recording", async () => {
    const deps = makeDeps();
    deps.replayLibrary.list.mockResolvedValue({
      items: [{ gameId: "g1", publicReference: REFERENCE }], sourceGames: [{ gameId: "g1", myToonHandle: "server-only" }], hasMore: false, nextCursor: null,
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
          gameId: "g1", publicReference: REFERENCE,
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
      gameId: REFERENCE,
      playerCount: 4,
      matchFormat: "team",
      opponent: { displayName: "Opponent", race: "Zerg", mmr: 6100 },
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
        gameId: "g1", publicReference: REFERENCE,
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
      game_id: "date|Serral|Map", opponent: "Serral",
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
    expect(deps.replayLibrary.getDetail).toHaveBeenCalledWith("owner-1", "g1", { view: "detector" });
    expect(deps.perGame.macroBreakdown).toHaveBeenCalledWith("owner-1", "g1");
    expect(deps.perGame.buildOrder).toHaveBeenCalledWith("owner-1", "g1");
    expect(response.body.game).toMatchObject({
      gameId: REFERENCE,
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
    expect(response.body.buildOrder).toMatchObject({ game_id: REFERENCE, opponent: "Opponent" });
    expect(JSON.stringify(response.body)).not.toContain("Serral");
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
      game: { gameId: "g1", publicReference: REFERENCE, replayAvailable: true },
      sourceGame: { gameId: "g1" },
    });
    deps.replayFiles.prepareDownload.mockResolvedValue({
      url: "https://r2.example.test/signed",
      filename: "Maru-vs-Serral.SC2Replay",
      expiresIn: 60,
    });

    const app = makeApp(deps);
    const response = await request(app).get("/v1/public/replays/owner-1/g1/download");
    expect(response.status).toBe(200);
    expect(response.body.expiresIn).toBe(60);
    expect(response.body.filename).toBe("sc2tools-replay.SC2Replay");
    expect(response.body.url).toMatch(/^\/v1\/public\/replays\/owner-1\/r-[a-f0-9]{24}\/file\?token=/);
    expect(JSON.stringify(response.body)).not.toMatch(/r2\.example|Serral|\/g1\//);
    expect(deps.replayLibrary.getDetail).toHaveBeenCalledWith("owner-1", "g1", { view: "detector" });
    expect(deps.replayFiles.prepareDownload).toHaveBeenCalledWith("owner-1", "g1", { filename: "sc2tools-replay.SC2Replay" });

    const fetchOriginal = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(Buffer.from("MPQ!"), { headers: { "Content-Length": "4" } }),
    );
    try {
      const file = await request(app).get(response.body.url).expect(200);
      expect(file.headers["content-disposition"]).toBe('attachment; filename="sc2tools-replay.SC2Replay"');
      expect(file.body.toString()).toBe("MPQ!");
      expect(fetchOriginal).toHaveBeenCalledTimes(1);
      await request(app).get(response.body.url.replace("token=", "token=x")).expect(404);
      deps.users.resolveReplaySharing.mockResolvedValue(null);
      await request(app).get(response.body.url).expect(404);
      expect(fetchOriginal).toHaveBeenCalledTimes(1);
    } finally { fetchOriginal.mockRestore(); }
    const logged = sanitiseRequestUrl("/v1/public/replays/owner-1/date%7Csecret-opponent%7CMap/download?token=private");
    expect(logged).not.toMatch(/secret-opponent|private/);
  });
});
