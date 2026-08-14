// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const { connect } = require("../src/db/connect");
const {
  buildGamesRouter,
  createAnalysisCorpusAdmission,
  holdAnalysisCorpusPermit,
} = require("../src/routes/games");
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
      "durationSec",
      "gameId",
      "macroScore",
      "map",
      "myBuild",
      "myMmr",
      "myRace",
      "myToonHandle",
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

  test("paginates mixed Date, string, number, and null cohorts without gaps", async () => {
    const rows = [
      exhaustiveGame("date-same-a", new Date("2026-08-12T12:00:00Z")),
      exhaustiveGame("date-same-b", new Date("2026-08-12T12:00:00Z")),
      exhaustiveGame("date-older", new Date("2026-08-11T12:00:00Z")),
      exhaustiveGame("string-same-a", "2025-01-02T00:00:00.000Z"),
      exhaustiveGame("string-same-b", "2025-01-02T00:00:00.000Z"),
      exhaustiveGame("string-older", "2024-01-02T00:00:00.000Z"),
      exhaustiveGame("number-same-a", 1_735_776_000_000),
      exhaustiveGame("number-same-b", 1_735_776_000_000),
      exhaustiveGame("number-older", 1_704_153_600_000),
      exhaustiveGame("null-a", null),
      exhaustiveGame("null-b", null),
      exhaustiveGame("null-c", null),
    ];
    await db.games.insertMany([
      ...rows,
      { ...exhaustiveGame("resumed-mixed", null), isResumedFromReplay: true },
      { ...exhaustiveGame("other-mixed", null), userId: "u2" },
    ]);
    const expected = await db.games
      .find(
        { userId: "u1", isResumedFromReplay: { $ne: true } },
        { projection: { _id: 0, gameId: 1 } },
      )
      .sort({ date: -1, _id: -1 })
      .toArray();

    const seen = [];
    const cursors = new Set();
    let cursor;
    let pages = 0;
    do {
      const page = await svc.listAnalysisCorpus("u1", { limit: 2, cursor });
      seen.push(...page.items.map((row) => row.gameId));
      cursor = page.nextCursor || undefined;
      if (cursor) {
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
      }
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(seen).toEqual(expected.map((row) => row.gameId));
    expect(seen).toHaveLength(rows.length);
    expect(new Set(seen).size).toBe(rows.length);
    const byId = new Map(
      (await svc.listAnalysisCorpus("u1", { limit: 100 })).items
        .map((row) => [row.gameId, row.date]),
    );
    expect(typeof byId.get("string-same-a")).toBe("string");
    expect(typeof byId.get("number-same-a")).toBe("number");
    expect(byId.get("null-a")).toBeNull();
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

    const id = "64b64c1f2f9f8a1f9c7a1234";
    const invalidTypedCursors = [
      { v: 2, t: "date", d: "not-a-date", i: id },
      { v: 2, t: "string", d: 123, i: id },
      { v: 2, t: "number", d: "1735776000000", i: id },
      { v: 2, t: "null", d: 0, i: id },
      { v: 2, t: "object", d: {}, i: id },
    ].map((payload) => Buffer.from(JSON.stringify(payload)).toString("base64url"));
    for (const cursor of invalidTypedCursors) {
      await expect(
        svc.listAnalysisCorpus("u1", { cursor }),
      ).rejects.toMatchObject({ status: 400, code: "bad_request" });
    }
  });

  test("continues accepting an in-flight v1 Date cursor after deploy", async () => {
    const newer = await db.games.insertOne(
      exhaustiveGame("v1-newer", new Date("2026-08-12T12:00:00Z")),
    );
    await db.games.insertMany([
      exhaustiveGame("v1-older", new Date("2026-08-11T12:00:00Z")),
      exhaustiveGame("v1-string", "2025-01-02T00:00:00.000Z"),
      exhaustiveGame("v1-null", null),
    ]);
    const cursor = Buffer.from(JSON.stringify({
      v: 1,
      d: "2026-08-12T12:00:00.000Z",
      i: newer.insertedId.toHexString(),
    })).toString("base64url");

    const page = await svc.listAnalysisCorpus("u1", { limit: 10, cursor });
    expect(page.items.map((row) => row.gameId)).toEqual([
      "v1-older",
      "v1-string",
      "v1-null",
    ]);
  });

  test("honours cancellation before allocating a Mongo result page", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      svc.listAnalysisCorpus("u1", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("analysis-corpus admission", () => {
  test("serializes active pages and rejects work beyond the bounded queue", async () => {
    const admission = createAnalysisCorpusAdmission({
      maxActive: 1,
      maxWaiters: 1,
    });
    const first = await admission.acquire(new AbortController().signal);
    expect(first).toEqual(expect.any(Function));

    let secondSettled = false;
    const secondPromise = admission
      .acquire(new AbortController().signal)
      .then((release) => {
        secondSettled = true;
        return release;
      });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    await expect(
      admission.acquire(new AbortController().signal),
    ).resolves.toBeNull();

    first();
    const second = await secondPromise;
    expect(second).toEqual(expect.any(Function));
    second();
  });

  test("removes a disconnected waiter without consuming the next slot", async () => {
    const admission = createAnalysisCorpusAdmission({
      maxActive: 1,
      maxWaiters: 1,
    });
    const first = await admission.acquire(new AbortController().signal);
    const waiting = new AbortController();
    const queued = admission.acquire(waiting.signal);
    waiting.abort();
    await expect(queued).resolves.toBeNull();

    first();
    const next = await admission.acquire(new AbortController().signal);
    expect(next).toEqual(expect.any(Function));
    next();
  });

  test("holds a corpus permit through response finish and releases once", () => {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroy = jest.fn();
    const release = jest.fn();

    const guard = holdAnalysisCorpusPermit(res, release, 10_000);
    expect(release).not.toHaveBeenCalled();

    res.emit("finish");
    expect(release).not.toHaveBeenCalled();
    guard.markComputeSettled();
    res.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  test("releases immediately when the response closed before hand-off", () => {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = true;
    res.destroy = jest.fn();
    const release = jest.fn();

    const guard = holdAnalysisCorpusPermit(res, release, 10_000);

    expect(release).not.toHaveBeenCalled();
    guard.markComputeSettled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
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
    expect(listAnalysisCorpus).toHaveBeenCalledWith(
      "u-route",
      expect.objectContaining({
        limit: 77,
        cursor: "opaque",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
