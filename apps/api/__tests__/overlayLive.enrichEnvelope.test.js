// @ts-nocheck
"use strict";

/**
 * Coverage for ``OverlayLiveService.enrichEnvelope`` and its companion
 * cache helpers (``clearEnrichmentCache`` /
 * ``invalidateEnrichmentForOpponent``). Split out of the main
 * ``overlayLive.test.js`` to keep that file under the project's
 * 800-line ceiling.
 *
 * What this covers:
 *   - Merging ``streamerHistory`` onto the agent's pre-game envelope
 *     before the broker fans it out.
 *   - The (userId, oppName, oppRace, myRace) cache so the 1 Hz envelope
 *     cadence doesn't re-hit Mongo.
 *   - Per-user isolation, throw-tolerance, and the targeted invalidate
 *     hook the games-ingest path uses to flush stale entries after a
 *     fresh upload.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");

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

  test("attaches a 0-0 headToHead under streamerHistory when the opponent is unknown", async () => {
    // No opponents row inserted — ``buildFromOpponentName`` now stamps
    // ``headToHead: { wins: 0, losses: 0 }`` as the "confirmed first
    // meeting" signal so the renderer + voice readout can distinguish
    // this from "enrichment hasn't run yet" (in which case
    // ``streamerHistory`` would be absent entirely). The matchup
    // label is also surfaced because it's useful pre-game.
    const env = envelope();
    const out = await svc.enrichEnvelope("u1", env);
    expect(out.streamerHistory).toBeTruthy();
    expect(out.streamerHistory.matchup).toBe("PvT");
    expect(out.streamerHistory.headToHead).toEqual({ wins: 0, losses: 0 });
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
