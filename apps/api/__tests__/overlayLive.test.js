// @ts-nocheck
"use strict";

/**
 * Pure-helper + ``buildFromGame`` coverage for the cloud-side
 * overlay-live derivation pipeline.
 *
 * Related test files (split out to keep this one under the project's
 * 800-line ceiling):
 *
 *   - ``overlayLive.buildFromOpponentName.test.js`` — the pre-game
 *     enrichment path (three-tier identity lookup, first-meeting
 *     signal, oppMmr fallback).
 *   - ``overlayLive.enrichEnvelope.test.js`` — the broker-side
 *     envelope merge + cache.
 *   - ``overlayLive.routes.test.js`` — HTTP route tests for
 *     ``POST /v1/overlay-events/test`` and ``POST /v1/games``.
 *   - ``overlayLive.firstMeeting.test.js`` — the confirmed-first-
 *     meeting signal that the voice readout uses to say "First
 *     meeting." instead of staying silent on the H2H clause.
 *   - ``overlayLive.regionAwareCache.test.js`` — region-aware cache
 *     key isolation.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  OverlayLiveService,
  leagueFromMmr,
  cheeseProbability,
  matchupLabel,
  bucketResult,
} = require("../src/services/overlayLive");

describe("services/overlayLive — pure helpers", () => {
  test("matchupLabel composes 'PvZ'-style labels from race initials", () => {
    expect(matchupLabel("Protoss", "Zerg")).toBe("PvZ");
    expect(matchupLabel("Terran", "Random")).toBe("TvR");
    expect(matchupLabel("", "Zerg")).toBeUndefined();
    expect(matchupLabel(undefined, "Zerg")).toBeUndefined();
  });

  test("bucketResult normalises legacy + canonical result strings", () => {
    expect(bucketResult("Victory")).toBe("win");
    expect(bucketResult("win")).toBe("win");
    expect(bucketResult("Defeat")).toBe("loss");
    expect(bucketResult("loss")).toBe("loss");
    expect(bucketResult("Tie")).toBeNull();
    expect(bucketResult(null)).toBeNull();
    expect(bucketResult("")).toBeNull();
  });

  test("cheeseProbability lights cheese-y openings above the 0.4 widget threshold", () => {
    expect(cheeseProbability("Pool first")).toBeGreaterThanOrEqual(0.4);
    expect(cheeseProbability("Proxy 2 Gate")).toBeGreaterThanOrEqual(0.4);
    expect(cheeseProbability("Cannon rush")).toBeGreaterThanOrEqual(0.4);
    expect(cheeseProbability("All-in 4 Gate")).toBeGreaterThanOrEqual(0.4);
    // Non-cheese strategies stay below the threshold so the widget hides.
    expect(cheeseProbability("Macro")).toBeLessThan(0.4);
    expect(cheeseProbability("Standard")).toBeLessThan(0.4);
    expect(cheeseProbability("")).toBeLessThan(0.4);
    expect(cheeseProbability(null)).toBeLessThan(0.4);
  });

  test("leagueFromMmr buckets MMR into Blizzard ladder leagues", () => {
    expect(leagueFromMmr(6800)).toEqual({ league: "Grandmaster", tier: 1 });
    expect(leagueFromMmr(5500)).toEqual({ league: "Master", tier: 1 });
    expect(leagueFromMmr(4200)).toEqual({ league: "Diamond", tier: 1 });
    expect(leagueFromMmr(3000)).toEqual({ league: "Platinum", tier: 2 });
    expect(leagueFromMmr(0)).toEqual({ league: "Bronze", tier: 3 });
    expect(leagueFromMmr(undefined)).toBeNull();
    expect(leagueFromMmr(NaN)).toBeNull();
  });
});

describe("services/overlayLive — sample payloads", () => {
  test("buildSamplePayload(undefined) returns every widget's fields populated", () => {
    const p = OverlayLiveService.buildSamplePayload();
    // Universal context.
    expect(p.myRace).toBeTruthy();
    expect(p.oppRace).toBeTruthy();
    expect(p.matchup).toBeTruthy();
    // Per-widget keys — every renderer's primary field needs to be present
    // so the Test-all button lights every panel.
    expect(p.headToHead).toBeDefined();
    expect(p.streak).toBeDefined();
    expect(p.cheeseProbability).toBeGreaterThanOrEqual(0.4);
    expect(p.session).toBeDefined();
    expect(p.rank).toBeDefined();
    expect(p.meta).toBeDefined();
    expect(p.topBuilds).toBeDefined();
    expect(p.favOpening).toBeDefined();
    expect(p.bestAnswer).toBeDefined();
    expect(p.scouting).toBeDefined();
    expect(p.rival).toBeDefined();
    expect(p.rematch).toBeDefined();
  });

  test("buildSamplePayload(<widget>) narrows to that widget's keys", () => {
    const p = OverlayLiveService.buildSamplePayload("session");
    expect(p.session).toBeDefined();
    // No streak/topBuilds bleed through — the per-widget Test button
    // probes one panel at a time.
    expect(p.streak).toBeUndefined();
    expect(p.topBuilds).toBeUndefined();
  });

  test("buildSamplePayload('opponent') carries the opponent dossier fields", () => {
    const p = OverlayLiveService.buildSamplePayload("opponent");
    expect(p.oppName).toBeTruthy();
    expect(p.oppMmr).toBeGreaterThan(0);
    expect(p.headToHead).toBeDefined();
  });

  test("unknown widget falls back to the full sample payload", () => {
    const p = OverlayLiveService.buildSamplePayload("nope-not-a-widget");
    expect(p.session).toBeDefined();
    expect(p.streak).toBeDefined();
  });
});

describe("services/overlayLive.buildFromGame", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_live",
    });
    svc = new OverlayLiveService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function game(overrides = {}) {
    return {
      gameId: "g1",
      userId: "u1",
      date: new Date(),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Goldenaura",
      durationSec: 700,
      myMmr: 4310,
      opponent: {
        displayName: "Foe",
        race: "Zerg",
        mmr: 4250,
        pulseId: "pulse-1",
        strategy: "Pool first",
      },
      ...overrides,
    };
  }

  test("returns a payload with universal context fields populated", async () => {
    const p = await svc.buildFromGame("u1", game());
    expect(p).toBeTruthy();
    expect(p.myRace).toBe("Protoss");
    expect(p.oppRace).toBe("Zerg");
    expect(p.matchup).toBe("PvZ");
    expect(p.result).toBe("win");
    expect(p.durationSec).toBe(700);
    expect(p.myMmr).toBe(4310);
    expect(p.oppMmr).toBe(4250);
    expect(p.map).toBe("Goldenaura");
    expect(p.oppName).toBe("Foe");
  });

  test("derives league + tier from myMmr without an external rank service", async () => {
    const p = await svc.buildFromGame("u1", game({ myMmr: 4310 }));
    expect(p.rank).toEqual({ league: "Diamond", tier: 1, mmr: 4310 });
  });

  test("triggers cheese alert when the opponent strategy is cheese-y", async () => {
    const p = await svc.buildFromGame("u1", game({ opponent: {
      ...game().opponent,
      strategy: "Cannon rush",
    } }));
    expect(p.cheeseProbability).toBeGreaterThanOrEqual(0.4);
  });

  test("hides cheese alert when the strategy is macro/standard", async () => {
    const p = await svc.buildFromGame("u1", game({ opponent: {
      ...game().opponent,
      strategy: "Macro",
    } }));
    expect(p.cheeseProbability).toBeUndefined();
  });

  test("hydrates H2H, rival, openings, scouting from the opponents row", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      gameCount: 6,
      wins: 4,
      losses: 2,
      lastSeen: new Date(Date.now() - 2 * 60 * 60 * 1000),
      openings: { "Pool first": 4, Macro: 1, "Roach All-in": 1 },
    });
    const p = await svc.buildFromGame("u1", game());
    expect(p.headToHead).toEqual({ wins: 4, losses: 2 });
    expect(p.rival.name).toBe("Foe");
    expect(p.rival.headToHead).toEqual({ wins: 4, losses: 2 });
    expect(p.rematch.isRematch).toBe(true);
    expect(p.rematch.lastResult).toBe("win");
    expect(p.favOpening.name).toBe("Pool first");
    expect(p.favOpening.samples).toBe(4);
    expect(p.predictedStrategies).toHaveLength(3);
    expect(p.predictedStrategies[0].name).toBe("Pool first");
    expect(p.scouting).toHaveLength(3);
    expect(p.scouting[0].label).toBe("Pool first");
  });

  test("hides rival when the opponent is a one-off encounter", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      gameCount: 1,
      wins: 1,
      losses: 0,
      lastSeen: new Date(),
      openings: { Macro: 1 },
    });
    const p = await svc.buildFromGame("u1", game());
    expect(p.rival).toBeUndefined();
    // H2H is still there because the opponents row was found — but
    // at 1-0 a rival panel would just be noise.
    expect(p.headToHead).toEqual({ wins: 1, losses: 0 });
  });

  test("hides rematch when the last encounter was over 24h ago", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      gameCount: 4,
      wins: 2,
      losses: 2,
      lastSeen: new Date(Date.now() - 48 * 60 * 60 * 1000),
      openings: { "Pool first": 4 },
    });
    const p = await svc.buildFromGame("u1", game());
    expect(p.rematch).toBeUndefined();
  });

  test("computes streak from games when run is 3+ same-result", async () => {
    const now = Date.now();
    await db.games.insertMany([
      { userId: "u1", gameId: "old1", result: "Defeat", date: new Date(now - 10 * 60000) },
      { userId: "u1", gameId: "win-a", result: "Victory", date: new Date(now - 5 * 60000) },
      { userId: "u1", gameId: "win-b", result: "Victory", date: new Date(now - 3 * 60000) },
      { userId: "u1", gameId: "g1",     result: "Victory", date: new Date(now) },
    ]);
    const p = await svc.buildFromGame("u1", game());
    expect(p.streak).toEqual({ kind: "win", count: 3 });
  });

  test("omits streak when the run is too short to surface", async () => {
    const now = Date.now();
    await db.games.insertMany([
      { userId: "u1", gameId: "old", result: "Defeat", date: new Date(now - 10 * 60000) },
      { userId: "u1", gameId: "g1",  result: "Victory", date: new Date(now) },
    ]);
    const p = await svc.buildFromGame("u1", game());
    expect(p.streak).toBeUndefined();
  });

  test("computes mmrDelta from the previous game's myMmr", async () => {
    await db.games.insertOne({
      userId: "u1",
      gameId: "earlier",
      result: "Victory",
      myMmr: 4280,
      date: new Date(Date.now() - 10 * 60 * 1000),
    });
    const p = await svc.buildFromGame("u1", game({ myMmr: 4310 }));
    expect(p.mmrDelta).toBe(30);
  });

  test("omits mmrDelta when no prior game carries myMmr", async () => {
    const p = await svc.buildFromGame("u1", game({ myMmr: 4310 }));
    expect(p.mmrDelta).toBeUndefined();
  });

  test("ranks topBuilds and bestAnswer from the user's matchup history", async () => {
    const now = Date.now();
    // 4 Stargate games in PvZ, 3 wins → 75% winRate, 4 total.
    // 2 4-Gate games in PvZ, 1 win → 50% winRate, 2 total.
    // 1 Stargate game in PvT (different matchup, must NOT bleed in).
    await db.games.insertMany([
      { userId: "u1", gameId: "pvz-sg-1", result: "Victory", myRace: "Protoss", myBuild: "P - Stargate", date: new Date(now - 60000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "pvz-sg-2", result: "Victory", myRace: "Protoss", myBuild: "P - Stargate", date: new Date(now - 50000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "pvz-sg-3", result: "Victory", myRace: "Protoss", myBuild: "P - Stargate", date: new Date(now - 40000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "pvz-sg-4", result: "Defeat",  myRace: "Protoss", myBuild: "P - Stargate", date: new Date(now - 30000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "pvz-4g-1", result: "Victory", myRace: "Protoss", myBuild: "P - 4 Gate",    date: new Date(now - 20000), opponent: { race: "Zerg", strategy: "Macro" } },
      { userId: "u1", gameId: "pvz-4g-2", result: "Defeat",  myRace: "Protoss", myBuild: "P - 4 Gate",    date: new Date(now - 10000), opponent: { race: "Zerg", strategy: "Macro" } },
      { userId: "u1", gameId: "pvt-sg-1", result: "Victory", myRace: "Protoss", myBuild: "P - Stargate", date: new Date(now - 5000),  opponent: { race: "Terran", strategy: "Marine drop" } },
    ]);
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      gameCount: 4,
      wins: 3,
      losses: 1,
      lastSeen: new Date(),
      openings: { "Pool first": 4 },
    });
    const p = await svc.buildFromGame("u1", game());
    expect(p.topBuilds).toBeDefined();
    expect(p.topBuilds[0].name).toBe("P - Stargate");
    expect(p.topBuilds[0].total).toBe(4);
    expect(p.topBuilds[0].winRate).toBeCloseTo(0.75);
    // Best answer pulls the favOpening (Pool first) winners.
    expect(p.bestAnswer).toBeTruthy();
    expect(p.bestAnswer.build).toBe("P - Stargate");
    expect(p.bestAnswer.total).toBe(4);
    expect(p.bestAnswer.winRate).toBeCloseTo(0.75);
  });

  test("recentGames lists prior matchup-scoped meetings vs this opponent", async () => {
    const now = Date.now();
    await db.games.insertMany([
      // Three prior PvZ games vs the same opponent — drawn in
      // ascending date so the service's reverse-sort surfaces the
      // newest first.
      {
        userId: "u1",
        gameId: "rg-1",
        result: "Defeat",
        myRace: "Protoss",
        myBuild: "P - Stargate",
        map: "Map A",
        durationSec: 421,
        date: new Date(now - 4000),
        opponent: { race: "Zerg", pulseId: "pulse-1", strategy: "12 Pool" },
      },
      {
        userId: "u1",
        gameId: "rg-2",
        result: "Victory",
        myRace: "Protoss",
        myBuild: "P - 4 Gate",
        map: "Map B",
        durationSec: 660,
        date: new Date(now - 2000),
        opponent: { race: "Zerg", pulseId: "pulse-1", strategy: "Hatch first" },
      },
      // Different matchup — must not appear (TvZ instead of PvZ).
      {
        userId: "u1",
        gameId: "rg-tvz",
        result: "Victory",
        myRace: "Terran",
        durationSec: 500,
        date: new Date(now - 1000),
        opponent: { race: "Zerg", pulseId: "pulse-1" },
      },
      // Different opponent — must not appear.
      {
        userId: "u1",
        gameId: "rg-other",
        result: "Victory",
        myRace: "Protoss",
        date: new Date(now - 500),
        opponent: { race: "Zerg", pulseId: "pulse-2" },
      },
    ]);
    const p = await svc.buildFromGame("u1", game({ gameId: "g-current" }));
    expect(Array.isArray(p.recentGames)).toBe(true);
    expect(p.recentGames).toHaveLength(2);
    // Newest first.
    expect(p.recentGames[0].result).toBe("Win");
    expect(p.recentGames[0].lengthText).toBe("11:00");
    expect(p.recentGames[0].map).toBe("Map B");
    expect(p.recentGames[0].myBuild).toBe("P - 4 Gate");
    expect(p.recentGames[0].oppBuild).toBe("Hatch first");
    expect(p.recentGames[1].result).toBe("Loss");
    expect(p.recentGames[1].lengthText).toBe("7:01");
  });

  test("recentGames excludes the just-uploaded game so the widget shows priors only", async () => {
    const now = Date.now();
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "g-current",
        result: "Victory",
        myRace: "Protoss",
        durationSec: 700,
        date: new Date(now),
        opponent: { race: "Zerg", pulseId: "pulse-1" },
      },
      {
        userId: "u1",
        gameId: "g-prior",
        result: "Defeat",
        myRace: "Protoss",
        durationSec: 420,
        date: new Date(now - 5000),
        opponent: { race: "Zerg", pulseId: "pulse-1" },
      },
    ]);
    const p = await svc.buildFromGame("u1", game({ gameId: "g-current" }));
    expect(p.recentGames).toHaveLength(1);
    expect(p.recentGames[0].result).toBe("Loss");
  });

  test("meta widget surfaces top opponent strategies in this matchup", async () => {
    const now = Date.now();
    await db.games.insertMany([
      { userId: "u1", gameId: "m1", result: "Victory", myRace: "Protoss", date: new Date(now - 5000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "m2", result: "Defeat",  myRace: "Protoss", date: new Date(now - 4000), opponent: { race: "Zerg", strategy: "Pool first" } },
      { userId: "u1", gameId: "m3", result: "Victory", myRace: "Protoss", date: new Date(now - 3000), opponent: { race: "Zerg", strategy: "Macro" } },
    ]);
    const p = await svc.buildFromGame("u1", game());
    expect(p.meta).toBeTruthy();
    expect(p.meta.matchup).toBe("PvZ");
    expect(p.meta.topBuilds[0].name).toBe("Pool first");
    expect(p.meta.topBuilds[0].share).toBeCloseTo(2 / 3);
  });
});
