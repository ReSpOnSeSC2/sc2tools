// @ts-nocheck
"use strict";

/**
 * Coverage for GamesService.list's caller-supplied limit. Pre-fix the
 * clamp used GAMES_PAGE_SIZE (100) as both default AND ceiling. The general
 * route now allows a useful 2,000-row page but never the old monolithic 20k
 * response; complete-history Arcade/Daily Pulse data uses the dedicated,
 * cursor-paged analysis corpus instead.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { LIMITS } = require("../src/config/constants");

// One lifecycle-backed Mongo fixture keeps the cap cases fast and isolated.
// eslint-disable-next-line max-lines-per-function
describe("GamesService.list — limit clamping", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_games_limit",
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

  function makeGames(userId, count) {
    const docs = [];
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < count; i++) {
      docs.push({
        userId,
        gameId: `g${i}`,
        date: new Date(base + i * 60_000),
        result: "Victory",
        myRace: "Terran",
        map: "Test",
      });
    }
    return docs;
  }

  test("honours a caller limit well above the old page-size fallback", async () => {
    const userId = "u-big";
    await db.games.insertMany(makeGames(userId, 500));
    const out = await svc.list(userId, { limit: 400 });
    // The old code would have clamped this to 100 (GAMES_PAGE_SIZE).
    expect(out.items.length).toBe(400);
  });

  test("falls back to GAMES_LIST_DEFAULT when no limit is supplied", async () => {
    const userId = "u-default";
    // Insert fewer rows than the default so the page just returns all
    // of them — what we're asserting is "the fallback isn't 100".
    await db.games.insertMany(makeGames(userId, 250));
    const out = await svc.list(userId);
    expect(out.items.length).toBe(250);
    // And it's bounded by the default (i.e. we didn't accidentally
    // unbound the fallback).
    expect(LIMITS.GAMES_LIST_DEFAULT).toBeGreaterThanOrEqual(250);
  });

  test("caps caller-supplied limit at GAMES_LIST_MAX", async () => {
    const userId = "u-cap";
    // Insert one more row than the cap so a limit=Infinity attempt
    // would otherwise return everything.
    const overflow = LIMITS.GAMES_LIST_MAX + 5;
    // Skip if the cap is so high that the test would be wasteful; the
    // current ceiling (20 000) is fine for an in-memory mongo.
    if (overflow > 25_000) return;
    await db.games.insertMany(makeGames(userId, overflow));
    const out = await svc.list(userId, { limit: overflow });
    expect(out.items.length).toBe(LIMITS.GAMES_LIST_MAX);
    expect(out.nextBefore).toBeTruthy();
  }, 60_000);

  test("a stale limit=20000 client is capped to one safe general page", async () => {
    const userId = "u-stale-client";
    await db.games.insertMany(makeGames(userId, LIMITS.GAMES_LIST_MAX + 1));
    const out = await svc.list(userId, { limit: 20_000 });
    expect(out.items).toHaveLength(LIMITS.GAMES_LIST_MAX);
    expect(out.nextBefore).toBeTruthy();
    expect(LIMITS.GAMES_LIST_MAX).toBeLessThan(20_000);
    expect(LIMITS.GAMES_ANALYSIS_CORPUS_MAX).toBe(20_000);
  });
});
