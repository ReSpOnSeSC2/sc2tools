// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const request = require("supertest");

const { connect } = require("../src/db/connect");
const { buildGamesRouter } = require("../src/routes/games");
const { GamesService } = require("../src/services/games");
const { LIMITS } = require("../src/config/constants");

// A single lifecycle-backed Mongo fixture covers projection, cursor and cap
// behavior together; keeping it in one describe avoids starting four mongods.
// eslint-disable-next-line max-lines-per-function
describe("GamesService.listAnalysisCorpus", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_analysis_corpus",
    });
    svc = new GamesService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function exhaustiveGame(gameId, date) {
    return {
      userId: "u1",
      gameId,
      date,
      result: "Victory",
      myToonHandle: "1-S2-1-123",
      myRace: "Protoss",
      myMmr: 4321,
      oppMmr: 4400,
      duration: 601,
      durationSec: 602,
      map: "Test Map LE",
      myBuild: "PvT - Blink",
      oppRace: "T",
      opp_strategy: "legacy strategy",
      oppPulseId: "legacy-pulse",
      macro_score: 78,
      macroScore: 79,
      opponent: {
        displayName: "Opponent",
        mmr: 4401,
        race: "Terran",
        pulseCharacterId: "9988",
        pulseId: "1-S2-1-9988",
        strategy: "Cyclone push",
        // Not consumed by Daily Pulse or any Arcade mode.
        privateEnrichment: { huge: "x".repeat(100_000) },
      },
      // These are intentionally outside the analysis contract. The corpus is
      // unfiltered, exactly as the old /games?limit=20000 call was; no current
      // Daily Pulse/Arcade flow reads ladder/team classification fields.
      isLadderGame: true,
      playerCount: 2,
      matchFormat: "1v1",
      replayFile: { storedAt: new Date(), secret: "do-not-serialize" },
      top3Leaks: [{ name: "also unrelated" }],
      futureLargeField: "y".repeat(100_000),
    };
  }

  test("returns the exhaustive consumer contract and nothing else", async () => {
    await db.games.insertOne(
      exhaustiveGame("g-contract", new Date("2026-08-12T12:00:00Z")),
    );

    const out = await svc.listAnalysisCorpus("u1", { limit: 10 });
    expect(out.nextCursor).toBeNull();
    expect(out.items).toHaveLength(1);
    const row = out.items[0];
    expect(Object.keys(row).sort()).toEqual([
      "date",
      "duration",
      "durationSec",
      "gameId",
      "macroScore",
      "macro_score",
      "map",
      "myBuild",
      "myMmr",
      "myRace",
      "myToonHandle",
      "oppMmr",
      "oppPulseId",
      "oppRace",
      "opp_strategy",
      "opponent",
      "result",
    ].sort());
    expect(row.date).toBe("2026-08-12T12:00:00.000Z");
    expect(row.opponent).toEqual({
      displayName: "Opponent",
      mmr: 4401,
      race: "Terran",
      pulseCharacterId: "9988",
      pulseId: "1-S2-1-9988",
      strategy: "Cyclone push",
    });
    expect(JSON.stringify(row)).not.toContain("do-not-serialize");
    expect(JSON.stringify(row)).not.toContain("privateEnrichment");
    expect(Buffer.byteLength(JSON.stringify(row), "utf8")).toBeLessThan(2_000);
    expect(row).not.toHaveProperty("isLadderGame");
    expect(row).not.toHaveProperty("playerCount");
    expect(row).not.toHaveProperty("matchFormat");
  });

  test("paginates identical timestamps without skips or duplicates", async () => {
    const same = new Date("2026-08-12T12:00:00Z");
    await db.games.insertMany([
      exhaustiveGame("same-a", same),
      exhaustiveGame("same-b", same),
      exhaustiveGame("same-c", same),
      exhaustiveGame("older", new Date("2026-08-11T12:00:00Z")),
      { ...exhaustiveGame("resumed", same), isResumedFromReplay: true },
      { ...exhaustiveGame("other-user", same), userId: "u2" },
    ]);

    const ids = [];
    let cursor;
    do {
      const page = await svc.listAnalysisCorpus("u1", { limit: 2, cursor });
      ids.push(...page.items.map((row) => row.gameId));
      cursor = page.nextCursor || undefined;
    } while (cursor);

    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(
      new Set(["same-a", "same-b", "same-c", "older"]),
    );
  });

  test("caps every response well below the complete-corpus ceiling", async () => {
    expect(LIMITS.GAMES_ANALYSIS_PAGE_MAX).toBeLessThan(
      LIMITS.GAMES_ANALYSIS_CORPUS_MAX,
    );
    expect(LIMITS.GAMES_LIST_MAX).toBeLessThanOrEqual(
      LIMITS.GAMES_ANALYSIS_PAGE_MAX,
    );
    expect(LIMITS.GAMES_FILTERED_LIST_MAX).toBe(5_000);
    const same = new Date("2026-08-12T12:00:00Z");
    await db.games.insertMany(
      Array.from({ length: LIMITS.GAMES_ANALYSIS_PAGE_MAX + 1 }, (_, index) => ({
        userId: "u1",
        gameId: `g-${index}`,
        date: same,
        result: "Victory",
      })),
    );
    const out = await svc.listAnalysisCorpus("u1", { limit: 99_999 });
    expect(out.items).toHaveLength(LIMITS.GAMES_ANALYSIS_PAGE_MAX);
    expect(out.nextCursor).toBeTruthy();
  }, 30_000);

  test("legacy GET /games cannot materialise a stale 20k request", async () => {
    const userId = "u-legacy-route";
    const base = Date.UTC(2026, 0, 1);
    await db.games.insertMany(
      Array.from({ length: LIMITS.GAMES_LIST_MAX + 1 }, (_, index) => ({
        userId,
        gameId: `legacy-${index}`,
        date: new Date(base + index * 1_000),
        result: "Victory",
      })),
    );

    const app = express();
    app.use(
      buildGamesRouter({
        auth: (req, _res, next) => {
          req.auth = { userId };
          next();
        },
        games: svc,
        opponents: { refreshMetadata: jest.fn() },
      }),
    );

    const res = await request(app)
      .get("/games")
      .query({ limit: "20000" })
      .expect(200);

    expect(res.body.items).toHaveLength(LIMITS.GAMES_LIST_MAX);
    expect(res.body.nextBefore).toBeTruthy();
    expect(res.body.items).toHaveLength(2_000);
  }, 30_000);

  test("rejects malformed cursors instead of restarting at page one", async () => {
    await expect(
      svc.listAnalysisCorpus("u1", { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});

describe("GET /games/analysis-corpus", () => {
  test("auth-scopes and forwards the bounded page request", async () => {
    const listAnalysisCorpus = jest.fn().mockResolvedValue({
      items: [{ gameId: "g1" }],
      nextCursor: "next",
    });
    const app = express();
    app.use(
      buildGamesRouter({
        auth: (req, _res, next) => {
          req.auth = { userId: "u-route" };
          next();
        },
        games: { listAnalysisCorpus },
        opponents: { refreshMetadata: jest.fn() },
      }),
    );

    const res = await request(app)
      .get("/games/analysis-corpus")
      .query({ limit: "77", cursor: "opaque" })
      .expect(200);

    expect(res.body).toEqual({
      items: [{ gameId: "g1" }],
      nextCursor: "next",
    });
    expect(listAnalysisCorpus).toHaveBeenCalledWith("u-route", {
      limit: 77,
      cursor: "opaque",
    });
  });
});
