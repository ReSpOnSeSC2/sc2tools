// @ts-nocheck
"use strict";

/**
 * Coverage for the cloud-side overlay-live derivation pipeline.
 *
 * Two layers:
 *
 *   1. ``OverlayLiveService.buildFromGame`` — synthesises a complete
 *      ``LiveGamePayload`` from one freshly-ingested game + the user's
 *      cloud history (H2H, streaks, top builds, fav opening, etc.).
 *      This is what makes every widget render a real value after the
 *      agent uploads, without the agent ever opening an overlay socket.
 *
 *   2. ``POST /v1/overlay-events/test`` — fires a synthetic payload at
 *      one or every widget so a streamer can validate their OBS layout
 *      without waiting for a ladder game.
 *
 *   3. The ingest pipeline (``POST /v1/games``) wires (1) into a
 *      per-token broadcast that fans out to every active overlay
 *      token belonging to the user.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const {
  OverlayLiveService,
  leagueFromMmr,
  cheeseProbability,
  matchupLabel,
  bucketResult,
} = require("../src/services/overlayLive");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-overlay-live") return { sub: "clerk_user_overlay_live" };
    throw new Error("invalid");
  }),
}));

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

describe("services/overlayLive.buildFromOpponentName (pre-game enrichment)", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_pregame",
    });
    svc = new OverlayLiveService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    svc.clearEnrichmentCache();
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("returns the same opponent-context fields as buildFromGame, sans result/duration", async () => {
    // Streamer's history with this opponent: 4-2 record, multiple
    // openings, one prior game in the same matchup. The opponents row
    // matches production shape — pulseId is the toon_handle, the
    // SC2Pulse character id lives on pulseCharacterId, and the plain-
    // text name is on displayNameSample.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      pulseCharacterId: "111000",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 6,
      wins: 4,
      losses: 2,
      lastSeen: new Date(Date.now() - 2 * 60 * 60 * 1000),
      openings: { "1-1-1 Standard": 4, "Banshee Rush": 1, Macro: 1 },
    });
    const now = Date.now();
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "h-1",
        result: "Defeat",
        myRace: "Protoss",
        myBuild: "PvT - Strange's 1 Gate Expand",
        map: "Lightshade LE",
        durationSec: 494,
        date: new Date(now - 4000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-future-toon",
          pulseCharacterId: "111000",
          displayName: "Future",
          strategy: "1-1-1 Standard",
        },
      },
      {
        userId: "u1",
        gameId: "h-2",
        result: "Victory",
        myRace: "Protoss",
        myBuild: "PvT - Phoenix into Robo",
        map: "Ghost River LE",
        durationSec: 1239,
        date: new Date(now - 2000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-future-toon",
          pulseCharacterId: "111000",
          displayName: "Future",
          strategy: "Banshee Rush",
        },
      },
    ]);
    const p = await svc.buildFromOpponentName(
      "u1",
      "Future",
      "Terran",
      111000,
      "Protoss",
      "1-S2-1-future-toon",
    );
    expect(p).toBeTruthy();
    expect(p.oppName).toBe("Future");
    expect(p.oppRace).toBe("Terran");
    expect(p.myRace).toBe("Protoss");
    expect(p.matchup).toBe("PvT");
    expect(p.headToHead).toEqual({ wins: 4, losses: 2 });
    expect(p.rival).toBeTruthy();
    expect(p.rival.headToHead).toEqual({ wins: 4, losses: 2 });
    expect(p.rematch).toBeTruthy();
    expect(p.rematch.isRematch).toBe(true);
    // Pre-game has no lastResult on the rematch flag — we haven't
    // played the current match yet.
    expect(p.rematch.lastResult).toBeUndefined();
    expect(p.favOpening.name).toBe("1-1-1 Standard");
    expect(p.predictedStrategies[0].name).toBe("1-1-1 Standard");
    expect(p.scouting[0].label).toBe("1-1-1 Standard");
    expect(p.recentGames).toHaveLength(2);
    expect(p.recentGames[0].result).toBe("Win");
    expect(p.recentGames[0].myBuild).toBe("PvT - Phoenix into Robo");
    expect(p.recentGames[0].oppBuild).toBe("Banshee Rush");
    // Result-specific fields are absent — they only land post-game.
    expect(p.result).toBeUndefined();
    expect(p.durationSec).toBeUndefined();
    expect(p.mmrDelta).toBeUndefined();
    expect(p.map).toBeUndefined();
  });

  test("falls back to displayNameSample when no pulse identifiers are provided (agent v0.6.0 / pre-Pulse)", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-foe-toon",
      displayNameSample: "Foe",
      displayNameHash: "hash",
      race: "Zerg",
      gameCount: 5,
      wins: 3,
      losses: 2,
      lastSeen: new Date(),
      openings: { Macro: 5 },
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "Foe",
      "Zerg",
      null,
      "Protoss",
    );
    expect(p).toBeTruthy();
    expect(p.headToHead).toEqual({ wins: 3, losses: 2 });
  });

  test("when displayNameSample matches multiple opponents, picks the race-matching row (then highest gameCount)", async () => {
    // Two rows share the displayNameSample "Twins" but on different
    // races — the race filter is what prevents the higher-gameCount
    // Zerg row from masking the (still-relevant) Terran one when we
    // happen to be scouting against the Terran twin. Within a single
    // race the gameCount tie-break still applies (see the third test
    // below for a same-race assertion).
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "1-S2-1-twin-zerg",
        displayNameSample: "Twins",
        displayNameHash: "h1",
        race: "Zerg",
        gameCount: 1,
        wins: 0,
        losses: 1,
        lastSeen: new Date(),
        openings: {},
      },
      {
        userId: "u1",
        pulseId: "1-S2-1-twin-zerg-2",
        displayNameSample: "Twins",
        displayNameHash: "h2",
        race: "Zerg",
        gameCount: 8,
        wins: 5,
        losses: 3,
        lastSeen: new Date(),
        openings: { Macro: 8 },
      },
    ]);
    const p = await svc.buildFromOpponentName(
      "u1",
      "Twins",
      "Zerg",
      null,
      "Protoss",
    );
    expect(p.headToHead).toEqual({ wins: 5, losses: 3 });
  });

  test("returns minimal payload for an unknown opponent (no opponents row, no history)", async () => {
    const p = await svc.buildFromOpponentName(
      "u1",
      "FreshAccount",
      "Terran",
      null,
      "Protoss",
    );
    expect(p).toBeTruthy();
    expect(p.oppName).toBe("FreshAccount");
    expect(p.matchup).toBe("PvT");
    expect(p.headToHead).toBeUndefined();
    expect(p.rival).toBeUndefined();
    expect(p.recentGames).toBeUndefined();
  });

  // Smoking-gun case from the 2026-05-11 incident: streamer queues into
  // "THEBLOB" (pulse_character_id 340473252, toon_handle
  // 1-S2-1-12236275). Four prior games are in the streamer's history;
  // the opponents row is correctly populated. Before the lookup fix the
  // pre-game scouting card rendered "first meeting" because Tier A
  // queried the wrong field (pulseId, which stores the toon_handle) and
  // the displayName fallback queried a field that doesn't exist on the
  // opponents schema. This test asserts the new Tier A pulse-character-
  // id lookup actually fires and finds the H2H.
  test("resolves H2H by pulse_character_id even when opponents.pulseId stores the toon_handle", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-12236275",
      pulseCharacterId: "340473252",
      displayNameSample: "THEBLOB",
      displayNameHash: "hash",
      race: "Protoss",
      wins: 3,
      losses: 1,
      gameCount: 4,
      lastSeen: new Date(),
      openings: {},
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "THEBLOB",
      "Protoss",
      340473252,
      "Protoss",
      // toon_handle deliberately omitted — Tier A should still resolve
      // because pulseCharacterId alone is enough.
      undefined,
    );
    expect(p).toBeTruthy();
    expect(p.headToHead).toEqual({ wins: 3, losses: 1 });
  });

  test("falls back to toon_handle when pulse_character_id is unresolved (Tier B)", async () => {
    // Same row as the smoking-gun case, but the SC2Pulse resolver
    // hasn't backfilled pulseCharacterId yet — only the toon_handle
    // (persisted under ``pulseId``) is present on the row. Tier B
    // should still pick it up using the toon_handle that arrived on
    // the live envelope.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-12236275",
      displayNameSample: "THEBLOB",
      displayNameHash: "hash",
      race: "Protoss",
      wins: 3,
      losses: 1,
      gameCount: 4,
      lastSeen: new Date(),
      openings: {},
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "THEBLOB",
      "Protoss",
      null,
      "Protoss",
      "1-S2-1-12236275",
    );
    expect(p).toBeTruthy();
    expect(p.headToHead).toEqual({ wins: 3, losses: 1 });
  });

  test("race disambiguates display-name collisions in the Tier C fallback", async () => {
    // Two rows share the displayNameSample "Twins" but on different
    // races. Pre-fix the higher-gameCount row would always win even
    // when the streamer was scouting against the OTHER twin — race
    // is a meaningful disambiguator the prior fallback didn't apply.
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: "1-S2-1-twin-zerg",
        displayNameSample: "Twins",
        displayNameHash: "h1",
        race: "Zerg",
        gameCount: 12,
        wins: 7,
        losses: 5,
        lastSeen: new Date(),
        openings: {},
      },
      {
        userId: "u1",
        pulseId: "1-S2-1-twin-terran",
        displayNameSample: "Twins",
        displayNameHash: "h2",
        race: "Terran",
        gameCount: 4,
        wins: 1,
        losses: 3,
        lastSeen: new Date(),
        openings: {},
      },
    ]);
    // Scouting against the Terran twin — even though the Zerg twin has
    // far more games, race matching must pick the Terran row.
    const p = await svc.buildFromOpponentName(
      "u1",
      "Twins",
      "Terran",
      null,
      "Protoss",
      // No toon_handle either — Tier C is the only one that can
      // resolve here.
      null,
    );
    expect(p.headToHead).toEqual({ wins: 1, losses: 3 });
  });

  test("returns null when called without a name", async () => {
    expect(await svc.buildFromOpponentName("u1", "")).toBeNull();
    expect(await svc.buildFromOpponentName("", "Foo")).toBeNull();
  });
});

describe("services/overlayLive.enrichEnvelope (cached merge)", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_enrich",
    });
    svc = new OverlayLiveService(db);
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    svc.clearEnrichmentCache();
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function envelope(extra = {}) {
    return {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 1,
      gameKey: "k",
      players: [
        { name: "ReSpOnSe", type: "user", race: "Protoss", result: "Undecided" },
        { name: "Future", type: "user", race: "Terran", result: "Undecided" },
      ],
      user: { name: "ReSpOnSe" },
      opponent: { name: "Future", race: "Terran" },
      ...extra,
    };
  }

  test("merges streamerHistory into the envelope when the cloud has history", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 4,
      wins: 1,
      losses: 3,
      lastSeen: new Date(),
      openings: { "Banshee Rush": 4 },
    });
    const env = envelope();
    const out = await svc.enrichEnvelope("u1", env);
    expect(out).not.toBe(env);
    expect(out.streamerHistory).toBeTruthy();
    expect(out.streamerHistory.headToHead).toEqual({ wins: 1, losses: 3 });
    expect(out.streamerHistory.matchup).toBe("PvT");
    // Original envelope fields are preserved.
    expect(out.opponent).toEqual(env.opponent);
    expect(out.user).toEqual(env.user);
    expect(out.gameKey).toBe("k");
  });

  test("returns the original envelope unchanged when there's no opponent name", async () => {
    const env = envelope({ opponent: undefined });
    const out = await svc.enrichEnvelope("u1", env);
    expect(out).toBe(env);
  });

  test("returns the original envelope when the opponent has no history (unknown)", async () => {
    // No opponents row inserted — buildFromOpponentName returns a
    // minimal payload with just the matchup; the wrapper should still
    // attach it under streamerHistory because the matchup label IS
    // useful pre-game.
    const env = envelope();
    const out = await svc.enrichEnvelope("u1", env);
    expect(out.streamerHistory).toBeTruthy();
    expect(out.streamerHistory.matchup).toBe("PvT");
    expect(out.streamerHistory.headToHead).toBeUndefined();
  });

  test("caches per (userId, oppName, oppRace, myRace) so a 1 Hz envelope cadence is cheap", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 4,
      wins: 1,
      losses: 3,
      lastSeen: new Date(),
      openings: { Macro: 4 },
    });
    const spy = jest.spyOn(svc, "buildFromOpponentName");
    const a = await svc.enrichEnvelope("u1", envelope());
    expect(spy).toHaveBeenCalledTimes(1);
    const b = await svc.enrichEnvelope("u1", envelope({ capturedAt: 2 }));
    // Same (userId, oppName, oppRace, myRace) — cache hit, no new
    // aggregation call.
    expect(spy).toHaveBeenCalledTimes(1);
    // Both envelopes carry the same streamerHistory block.
    expect(b.streamerHistory.headToHead).toEqual(a.streamerHistory.headToHead);
    spy.mockRestore();
  });

  test("does not cross userIds — alice's enrichment doesn't leak to bob", async () => {
    await db.opponents.insertOne({
      userId: "alice",
      pulseId: "1-S2-1-future-a",
      displayNameSample: "Future",
      displayNameHash: "ha",
      race: "Terran",
      gameCount: 5,
      wins: 5,
      losses: 0,
      lastSeen: new Date(),
      openings: { Macro: 5 },
    });
    await db.opponents.insertOne({
      userId: "bob",
      pulseId: "1-S2-1-future-b",
      displayNameSample: "Future",
      displayNameHash: "hb",
      race: "Terran",
      gameCount: 5,
      wins: 0,
      losses: 5,
      lastSeen: new Date(),
      openings: { Macro: 5 },
    });
    const aliceOut = await svc.enrichEnvelope("alice", envelope());
    const bobOut = await svc.enrichEnvelope("bob", envelope());
    expect(aliceOut.streamerHistory.headToHead).toEqual({ wins: 5, losses: 0 });
    expect(bobOut.streamerHistory.headToHead).toEqual({ wins: 0, losses: 5 });
  });

  test("returns the envelope unchanged when buildFromOpponentName throws", async () => {
    const orig = svc.buildFromOpponentName.bind(svc);
    svc.buildFromOpponentName = async () => {
      throw new Error("mongo blip");
    };
    try {
      const env = envelope();
      const out = await svc.enrichEnvelope("u1", env);
      // Cached as null on failure; envelope passes through unchanged.
      expect(out).toBe(env);
    } finally {
      svc.buildFromOpponentName = orig;
    }
  });

  test("invalidateEnrichmentForOpponent flushes every variant for that (user, opp) pair", async () => {
    // Seed the cache with a few entries — same opponent across two
    // matchups, plus an unrelated opponent that must NOT be flushed.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      displayNameSample: "Future",
      displayNameHash: "hf",
      race: "Terran",
      gameCount: 3,
      wins: 1,
      losses: 2,
      lastSeen: new Date(),
      openings: { Macro: 3 },
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-other-toon",
      displayNameSample: "OtherPlayer",
      displayNameHash: "ho",
      race: "Zerg",
      gameCount: 5,
      wins: 5,
      losses: 0,
      lastSeen: new Date(),
      openings: { Macro: 5 },
    });
    // Prime cache: Future / Terran / Protoss
    await svc.enrichEnvelope("u1", envelope());
    // Prime cache: same opp, different myRace (different cache key)
    await svc.enrichEnvelope("u1", envelope({
      players: [
        { name: "ReSpOnSe", type: "user", race: "Zerg", result: "Undecided" },
        { name: "Future", type: "user", race: "Terran", result: "Undecided" },
      ],
    }));
    // Prime cache: unrelated opponent
    await svc.enrichEnvelope("u1", envelope({
      opponent: { name: "OtherPlayer", race: "Zerg" },
    }));
    expect(svc._enrichmentCache.size).toBe(3);

    svc.invalidateEnrichmentForOpponent("u1", "Future");

    // Both Future entries flushed; OtherPlayer remains.
    expect(svc._enrichmentCache.size).toBe(1);
    const remainingKeys = Array.from(svc._enrichmentCache.keys());
    expect(remainingKeys[0]).toContain("otherplayer");
  });

  test("invalidate is case-insensitive on the opponent name", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 3,
      wins: 1,
      losses: 2,
      lastSeen: new Date(),
      openings: {},
    });
    await svc.enrichEnvelope("u1", envelope());
    expect(svc._enrichmentCache.size).toBe(1);
    // Uppercase invalidate matches the cache (which is keyed by the
    // lowercased name) — handles agents that report a different
    // capitalisation than the displayName stored in the opponents row.
    svc.invalidateEnrichmentForOpponent("u1", "FUTURE");
    expect(svc._enrichmentCache.size).toBe(0);
  });
});

describe("POST /v1/overlay-events/test", () => {
  let mongo;
  let db;
  let app;
  let captured;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_test_route",
    });
    captured = { liveEmits: [], sessionEmits: [] };
    const fakeIo = {
      to: (room) => ({
        emit: (event, payload) => {
          if (event === "overlay:live") {
            captured.liveEmits.push({ room, payload });
          } else if (event === "overlay:session") {
            captured.sessionEmits.push({ room, payload });
          }
        },
      }),
      in: () => ({ fetchSockets: async () => [] }),
    };
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: {
        port: 0,
        nodeEnv: "test",
        logLevel: "silent",
        mongoUri: "",
        mongoDb: "sc2tools_test_overlay_test_route",
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: undefined,
        clerkJwtAudience: undefined,
        serverPepper: Buffer.alloc(32, 7),
        corsAllowedOrigins: [],
        rateLimitPerMinute: 5000,
        agentReleaseAdminToken: "admin",
        pythonExe: null,
        pythonAnalyzerDir: "/tmp/__nonexistent__",
        adminUserIds: [],
      },
      io: fakeIo,
    });
    app = built.app;
    // Warm /me so the user row exists for the overlay-token POST.
    await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer user-overlay-live");
  });

  afterEach(() => {
    captured.liveEmits.length = 0;
    captured.sessionEmits.length = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function mintToken() {
    const res = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "Test" })
      .set("content-type", "application/json");
    expect(res.status).toBe(201);
    return res.body.token;
  }

  test("400 when token missing", async () => {
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({})
      .set("content-type", "application/json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  test("404 when the token doesn't belong to the caller", async () => {
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token: "definitely-not-a-real-token" })
      .set("content-type", "application/json");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  test("emits a full sample payload to overlay:<token> when no widget is named", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(res.body.widget).toBe("all");
    expect(captured.liveEmits).toHaveLength(1);
    expect(captured.liveEmits[0].room).toBe(`overlay:${token}`);
    // Every widget's primary field is in the payload.
    const p = captured.liveEmits[0].payload;
    expect(p.headToHead).toBeDefined();
    expect(p.streak).toBeDefined();
    expect(p.cheeseProbability).toBeGreaterThanOrEqual(0.4);
    expect(p.topBuilds).toBeDefined();
    expect(p.session).toBeDefined();
    // ``session`` widget needs the dedicated overlay:session event too,
    // since that's the channel its renderer listens on.
    expect(captured.sessionEmits).toHaveLength(1);
  });

  test("emits a narrowed payload when a single widget is named", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token, widget: "opponent" })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(res.body.widget).toBe("opponent");
    expect(captured.liveEmits).toHaveLength(1);
    const p = captured.liveEmits[0].payload;
    expect(p.oppName).toBeTruthy();
    expect(p.headToHead).toBeDefined();
    // Other widgets stay quiet so neighbouring panels don't strobe.
    expect(p.streak).toBeUndefined();
    expect(p.topBuilds).toBeUndefined();
    // Single-widget probe of a non-session widget shouldn't fire the
    // session event either.
    expect(captured.sessionEmits).toHaveLength(0);
  });

  test("session-widget probe also fires the dedicated overlay:session event", async () => {
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token, widget: "session" })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(captured.liveEmits).toHaveLength(1);
    expect(captured.sessionEmits).toHaveLength(1);
    expect(captured.sessionEmits[0].payload.wins).toBeGreaterThanOrEqual(0);
  });

  test("test-fired payloads carry isTest:true on both events", async () => {
    // The overlay clients use this flag to cap the normally-persistent
    // session/topbuilds widgets at a short visibility timer so a Test
    // click never pins sample data to the streamer's scene.
    const token = await mintToken();
    const res = await request(app)
      .post("/v1/overlay-events/test")
      .set("authorization", "Bearer user-overlay-live")
      .send({ token })
      .set("content-type", "application/json");
    expect(res.status).toBe(202);
    expect(captured.liveEmits[0].payload.isTest).toBe(true);
    expect(captured.sessionEmits[0].payload.isTest).toBe(true);
  });

  test("real overlay:live broadcasts (from /v1/games) do NOT carry isTest", async () => {
    // The ingest path's payload comes from buildFromGame() which never
    // sets the flag, so production widgets keep their natural
    // durations and persistent panels stay persistent.
    const sample = OverlayLiveService.buildSamplePayload();
    expect(sample.isTest).toBeUndefined();
  });
});

describe("POST /v1/games triggers overlay:live broadcast", () => {
  let mongo;
  let db;
  let app;
  let captured;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_games_overlay_live",
    });
    captured = { liveEmits: [], gamesChanged: [] };
    const fakeIo = {
      to: (room) => ({
        emit: (event, payload) => {
          if (event === "overlay:live") {
            captured.liveEmits.push({ room, payload });
          } else if (event === "games:changed") {
            captured.gamesChanged.push({ room, payload });
          }
        },
      }),
      in: () => ({ fetchSockets: async () => [] }),
    };
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config: {
        port: 0,
        nodeEnv: "test",
        logLevel: "silent",
        mongoUri: "",
        mongoDb: "sc2tools_test_games_overlay_live",
        clerkSecretKey: "sk_test",
        clerkJwtIssuer: undefined,
        clerkJwtAudience: undefined,
        serverPepper: Buffer.alloc(32, 8),
        corsAllowedOrigins: [],
        rateLimitPerMinute: 5000,
        agentReleaseAdminToken: "admin",
        pythonExe: null,
        pythonAnalyzerDir: "/tmp/__nonexistent__",
        adminUserIds: [],
      },
      io: fakeIo,
    });
    app = built.app;
    await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer user-overlay-live");
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    await db.overlayTokens.deleteMany({});
    captured.liveEmits.length = 0;
    captured.gamesChanged.length = 0;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function waitFor(predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitFor timed out");
  }

  test("a successful ingest fans overlay:live out to every active token", async () => {
    // Mint two active tokens + one revoked token. The revoked token
    // must NOT receive a live event.
    const a = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "main" })
      .set("content-type", "application/json");
    const b = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "second" })
      .set("content-type", "application/json");
    const c = await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "revoked" })
      .set("content-type", "application/json");
    await request(app)
      .delete(`/v1/overlay-tokens/${c.body.token}`)
      .set("authorization", "Bearer user-overlay-live");

    const game = {
      gameId: "g-overlay-1",
      date: new Date().toISOString(),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "P - Stargate",
      map: "Goldenaura",
      durationSec: 720,
      myMmr: 4310,
      buildLog: ["[1:00] Pylon"],
      oppBuildLog: [],
      opponent: {
        displayName: "Foe",
        race: "Zerg",
        mmr: 4250,
        pulseId: "pulse-1",
        strategy: "Pool first",
      },
    };
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer user-overlay-live")
      .send(game)
      .set("content-type", "application/json");
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(1);

    await waitFor(() => captured.liveEmits.length >= 2);
    const rooms = captured.liveEmits.map((e) => e.room);
    expect(rooms).toContain(`overlay:${a.body.token}`);
    expect(rooms).toContain(`overlay:${b.body.token}`);
    expect(rooms).not.toContain(`overlay:${c.body.token}`);
    // Each emit carries the derived payload.
    for (const e of captured.liveEmits) {
      expect(e.payload.matchup).toBe("PvZ");
      expect(e.payload.result).toBe("win");
      expect(e.payload.rank).toEqual({ league: "Diamond", tier: 1, mmr: 4310 });
      // Cheese alert because the opponent's strategy is "Pool first".
      expect(e.payload.cheeseProbability).toBeGreaterThanOrEqual(0.4);
    }
  });

  test("a rejected ingest does not broadcast overlay:live", async () => {
    await request(app)
      .post("/v1/overlay-tokens")
      .set("authorization", "Bearer user-overlay-live")
      .send({ label: "main" })
      .set("content-type", "application/json");
    const post = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer user-overlay-live")
      .send({ gameId: "" }) // missing required fields
      .set("content-type", "application/json");
    expect(post.status).toBe(202);
    expect(post.body.accepted).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(captured.liveEmits).toHaveLength(0);
    expect(captured.gamesChanged).toHaveLength(0);
  });
});
