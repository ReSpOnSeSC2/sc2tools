// @ts-nocheck
"use strict";

/**
 * Coverage for ``OverlayLiveService.buildFromOpponentName`` — the
 * pre-game enrichment path. Split out of the main ``overlayLive.test.js``
 * to keep that file under the project's 800-line ceiling.
 *
 * What this covers:
 *   - Hydrating cross-cutting fields (H2H, RIVAL/FAMILIAR, fav opening,
 *     scouting, recent games) from the opponents collection.
 *   - The three-tier opponent-row lookup
 *     (pulse_character_id → toon_handle → displayName + race).
 *   - First-meeting signal (``headToHead: { wins: 0, losses: 0 }``)
 *     when no row matches.
 *   - oppMmr fallback from the opponents row's last-stamped MMR.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");

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

  test("returns minimal payload with zero-zero H2H for an unknown opponent (no opponents row, no history)", async () => {
    // Even when no opponents row matched any of the three identity
    // tiers we MUST stamp ``headToHead: { wins: 0, losses: 0 }`` so the
    // renderer (and the voice readout) can distinguish "confirmed
    // first meeting" from "enrichment hasn't landed yet" (which leaves
    // ``headToHead`` undefined). The voice readout uses this signal
    // to say "First meeting." rather than going silent on the H2H
    // clause.
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
    expect(p.headToHead).toEqual({ wins: 0, losses: 0 });
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

  test("surfaces last-observed MMR from the opponents row as oppMmr", async () => {
    // Bug companion to the THEBLOB H2H fix: SC2Pulse's live profile
    // lookup returns no MMR for some accounts (no current season
    // games, account migrated, etc.), so the pre-game card fell to
    // "MMR unavailable" even when the cloud had a fresh MMR stamped
    // on the opponents row from prior encounters. The pre-game path
    // must now surface that stored MMR under ``oppMmr`` (same field
    // the post-game card uses) so the renderer can prefer it over
    // the missing Pulse value.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-12236275",
      pulseCharacterId: "340473252",
      displayNameSample: "THEBLOB",
      displayNameHash: "hash",
      race: "Protoss",
      mmr: 4327,
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
    );
    expect(p.oppMmr).toBe(4327);
  });

  test("omits oppMmr when the opponents row has no stored MMR", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-12236275",
      pulseCharacterId: "340473252",
      displayNameSample: "THEBLOB",
      displayNameHash: "hash",
      race: "Protoss",
      wins: 1,
      losses: 0,
      gameCount: 1,
      lastSeen: new Date(),
      openings: {},
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "THEBLOB",
      "Protoss",
      340473252,
      "Protoss",
    );
    expect(p.oppMmr).toBeUndefined();
  });

  test("returns null when called without a name", async () => {
    expect(await svc.buildFromOpponentName("u1", "")).toBeNull();
    expect(await svc.buildFromOpponentName("", "Foo")).toBeNull();
  });
});
