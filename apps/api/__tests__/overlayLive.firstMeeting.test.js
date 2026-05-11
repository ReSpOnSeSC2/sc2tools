// @ts-nocheck
"use strict";

/**
 * Confirmed-first-meeting signal on the pre-game enrichment payload.
 *
 * Why this matters: the OBS voice readout needs to distinguish
 * "confirmed brand-new opponent" from "enrichment hasn't landed yet"
 * so it can say ``First meeting.`` in the first case and stay silent
 * on the H2H clause in the second. The signal we settled on is
 * ``streamerHistory.headToHead === { wins: 0, losses: 0 }`` — present
 * but zero — vs ``headToHead`` absent entirely.
 *
 * That requires the cloud's ``buildFromOpponentName`` to always emit
 * the field when enrichment completes, even when no opponents row
 * matched. The pre-existing behaviour was to leave it undefined,
 * which the renderer could not differentiate from a Mongo blip.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");

describe("overlayLive first-meeting signal", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_first_meeting",
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

  test("buildFromOpponentName returns headToHead 0-0 when no opponents row matches any tier", async () => {
    // Three-tier lookup (pulse_character_id → toon_handle →
    // displayName) all miss. The function used to leave ``headToHead``
    // undefined; it must now stamp the zero-zero signal so callers can
    // act on a confirmed first meeting.
    const p = await svc.buildFromOpponentName(
      "u1",
      "BrandNewOpponent",
      "Terran",
      999999999, // pulse_character_id — no row matches
      "Protoss",
      "1-S2-1-not-in-cloud", // toon_handle — no row matches
    );
    expect(p).toBeTruthy();
    expect(p.headToHead).toEqual({ wins: 0, losses: 0 });
    // Nothing else should pretend to be present — no rival, no
    // rematch, no favOpening, no recentGames.
    expect(p.rival).toBeUndefined();
    expect(p.rematch).toBeUndefined();
    expect(p.favOpening).toBeUndefined();
    expect(p.recentGames).toBeUndefined();
  });

  test("enrichEnvelope attaches the 0-0 headToHead under streamerHistory for a new opponent", async () => {
    // The broker fan-out path: ``enrichEnvelope`` wraps the result of
    // ``buildFromOpponentName`` into ``envelope.streamerHistory``.
    // When the opponent is brand-new, the wrapped block must carry
    // the same explicit zero-zero signal so the overlay client knows
    // the cloud has spoken.
    const envelope = {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 1,
      gameKey: "fresh-1",
      players: [
        { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
        {
          name: "BrandNewOpponent",
          type: "user",
          race: "Terran",
          result: "Undecided",
        },
      ],
      user: { name: "Streamer" },
      opponent: { name: "BrandNewOpponent", race: "Terran" },
    };
    const out = await svc.enrichEnvelope("u1", envelope);
    expect(out.streamerHistory).toBeTruthy();
    expect(out.streamerHistory.headToHead).toEqual({ wins: 0, losses: 0 });
    expect(out.streamerHistory.oppName).toBe("BrandNewOpponent");
    expect(out.streamerHistory.matchup).toBe("PvT");
  });

  test("repeat opponents still emit a non-zero headToHead (no regression)", async () => {
    // Sanity check: the new no-row branch must not have changed the
    // behaviour for opponents we DO have history with.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-known-toon",
      pulseCharacterId: "12345",
      displayNameSample: "KnownOpp",
      displayNameHash: "h",
      race: "Terran",
      wins: 7,
      losses: 3,
      gameCount: 10,
      lastSeen: new Date(),
      openings: {},
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "KnownOpp",
      "Terran",
      12345,
      "Protoss",
      "1-S2-1-known-toon",
    );
    expect(p.headToHead).toEqual({ wins: 7, losses: 3 });
  });
});
