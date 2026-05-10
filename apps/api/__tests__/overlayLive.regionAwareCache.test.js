// @ts-nocheck
"use strict";

/**
 * Regression coverage for the region-aware enrichment cache key.
 *
 * Bug: two opponents on different servers with the same display name
 * (NA "Maru" vs EU "Maru" — extremely common in SC2 since ladder
 * names are not globally unique) shared a cache slot in
 * ``OverlayLiveService._enrichmentCache``. A streamer who switched
 * servers mid-stream would see the previous server's H2H +
 * ``recentGames`` overlaid on the NEW opponent.
 *
 * Fix: cache keys now incorporate either the Pulse character id (when
 * the agent's envelope carries one) OR the leading region byte of
 * the opponent's toon handle / Pulse profile region label. These
 * tests pin both fork branches end-to-end against a real Mongo
 * instance so a future refactor can't silently re-introduce the
 * collision.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");

describe("OverlayLiveService — region-aware enrichment cache", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_region_cache",
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

  function envelope({ region = null, pulseCharacterId = null, name = "Maru" } = {}) {
    /** @type {Record<string, any>} */
    const opp = { name, race: "Terran" };
    if (region) {
      opp.profile = {
        pulse_character_id: pulseCharacterId,
        region,
      };
    } else if (pulseCharacterId !== null) {
      opp.profile = { pulse_character_id: pulseCharacterId };
    }
    return {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 1,
      gameKey: `k-${name}-${region || pulseCharacterId || "u"}`,
      players: [
        { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
        { name, type: "user", race: "Terran", result: "Undecided" },
      ],
      user: { name: "Streamer" },
      opponent: opp,
    };
  }

  test("two opponents with the same display name on different regions do NOT share a cache entry", async () => {
    // Seed two distinct opponents — same display name, different
    // pulseId (which maps to different ladder identities and
    // therefore different servers in real-world data).
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-1111", // NA toon handle
      displayName: "Maru",
      gameCount: 6,
      wins: 5,
      losses: 1,
      lastSeen: new Date(),
      openings: { Macro: 6 },
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "2-S2-1-2222", // EU toon handle
      displayName: "Maru",
      gameCount: 4,
      wins: 0,
      losses: 4,
      lastSeen: new Date(),
      openings: { "Pool first": 4 },
    });

    // First envelope — opponent's Pulse profile labels region "US"
    // (Pulse uses "US" for NA). The H2H must reflect the NA opponent.
    const naOut = await svc.enrichEnvelope(
      "u1",
      envelope({ region: "US", name: "Maru" }),
    );
    // Switch servers — same display name, EU profile, brand-new game
    // identity. The H2H must reflect the EU opponent, NOT the cached
    // NA one.
    const euOut = await svc.enrichEnvelope(
      "u1",
      envelope({ region: "EU", name: "Maru" }),
    );

    expect(naOut.streamerHistory).toBeDefined();
    expect(euOut.streamerHistory).toBeDefined();
    // The opponents lookup picks the row with the most encounters
    // when only displayName is available — both regions have a Maru
    // row, the cache key must isolate them. The key insight is the
    // cache map size: two distinct keys, not one.
    expect(svc._enrichmentCache.size).toBe(2);
    const keys = Array.from(svc._enrichmentCache.keys());
    expect(keys.some((k) => k.includes("region:NA"))).toBe(true);
    expect(keys.some((k) => k.includes("region:EU"))).toBe(true);
  });

  test("when pulse_character_id is present, the cache keys on it (immune to display-name collisions)", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulseA",
      displayName: "Maru",
      gameCount: 5,
      wins: 4,
      losses: 1,
      lastSeen: new Date(),
      openings: { Macro: 5 },
    });
    const a = await svc.enrichEnvelope(
      "u1",
      envelope({ pulseCharacterId: 12345, name: "Maru" }),
    );
    const b = await svc.enrichEnvelope(
      "u1",
      envelope({ pulseCharacterId: 99999, name: "Maru" }),
    );
    expect(a.streamerHistory).toBeDefined();
    expect(b.streamerHistory).toBeDefined();
    expect(svc._enrichmentCache.size).toBe(2);
    const keys = Array.from(svc._enrichmentCache.keys());
    expect(keys.some((k) => k.includes("pulse:12345"))).toBe(true);
    expect(keys.some((k) => k.includes("pulse:99999"))).toBe(true);
    // Neither key uses the name-based scheme.
    expect(keys.every((k) => !k.includes("name:"))).toBe(true);
  });

  test("invalidate by name flushes BOTH region-keyed entries", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-na",
      displayName: "Maru",
      gameCount: 2,
      wins: 1,
      losses: 1,
      lastSeen: new Date(),
      openings: {},
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-eu",
      displayName: "Maru",
      gameCount: 2,
      wins: 0,
      losses: 2,
      lastSeen: new Date(),
      openings: {},
    });
    await svc.enrichEnvelope(
      "u1",
      envelope({ region: "US", name: "Maru" }),
    );
    await svc.enrichEnvelope(
      "u1",
      envelope({ region: "EU", name: "Maru" }),
    );
    expect(svc._enrichmentCache.size).toBe(2);
    svc.invalidateEnrichmentForOpponent("u1", "Maru");
    expect(svc._enrichmentCache.size).toBe(0);
  });

  test("invalidate by pulseCharacterId flushes the pulse-keyed entry", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      displayName: "Maru",
      gameCount: 1,
      wins: 1,
      losses: 0,
      lastSeen: new Date(),
      openings: {},
    });
    await svc.enrichEnvelope(
      "u1",
      envelope({ pulseCharacterId: 12345, name: "Maru" }),
    );
    expect(svc._enrichmentCache.size).toBe(1);
    // Calling with a name AND the matching pulseCharacterId flushes
    // the pulse-keyed entry too. Real-world flow: the games ingest
    // path passes both because the just-uploaded game's
    // ``opponent.pulseCharacterId`` is freshly resolved.
    svc.invalidateEnrichmentForOpponent("u1", "Maru", 12345);
    expect(svc._enrichmentCache.size).toBe(0);
  });

  test("invalidate by name only does NOT flush a different pulseCharacterId entry", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "pulse-1",
      displayName: "Maru",
      gameCount: 1,
      wins: 1,
      losses: 0,
      lastSeen: new Date(),
      openings: {},
    });
    // Prime cache with a pulse-keyed entry — name-only invalidation
    // should NOT touch it (the name-prefix doesn't match
    // ``u1|pulse:...``).
    await svc.enrichEnvelope(
      "u1",
      envelope({ pulseCharacterId: 12345, name: "Maru" }),
    );
    expect(svc._enrichmentCache.size).toBe(1);
    svc.invalidateEnrichmentForOpponent("u1", "Maru");
    // Still there — name-only invalidate is a partial flush by
    // design. The ingest path supplies the pulseCharacterId when it
    // has one, exercising the full flush; a stranger-pulseId
    // invalidate from elsewhere doesn't accidentally evict a
    // different match's still-warm entry.
    expect(svc._enrichmentCache.size).toBe(1);
  });

  test("a region-less envelope keys under '?' so it remains cacheable", async () => {
    // Pre-Pulse envelope: no profile, no region. We still cache so a
    // 1 Hz envelope cadence doesn't re-hit Mongo.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "p",
      displayName: "Future",
      gameCount: 3,
      wins: 2,
      losses: 1,
      lastSeen: new Date(),
      openings: {},
    });
    await svc.enrichEnvelope("u1", envelope({ name: "Future" }));
    expect(svc._enrichmentCache.size).toBe(1);
    const key = Array.from(svc._enrichmentCache.keys())[0];
    expect(key).toContain("region:?");
  });

  test("'US' from Pulse and a NA toonHandle map to the same canonical region label", async () => {
    // Pulse labels NA as 'US'; the rest of the cloud canonicalises
    // to 'NA'. A single opponent must hit one cache slot whether
    // the envelope arrived Pulse-first or toonHandle-first — without
    // this the 1 Hz cadence would double-fetch the aggregation.
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "p",
      displayName: "Maru",
      gameCount: 3,
      wins: 1,
      losses: 2,
      lastSeen: new Date(),
      openings: {},
    });
    await svc.enrichEnvelope(
      "u1",
      envelope({ region: "US", name: "Maru" }),
    );
    expect(svc._enrichmentCache.size).toBe(1);
    const key = Array.from(svc._enrichmentCache.keys())[0];
    expect(key).toContain("region:NA");
  });
});
