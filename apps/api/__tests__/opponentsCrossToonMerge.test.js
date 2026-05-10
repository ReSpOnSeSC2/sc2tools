// @ts-nocheck
"use strict";

/**
 * Cross-toon opponent merge integration test.
 *
 * The rare-but-real Battle.net rebind case: a player rotates their
 * toon_handle (region-realm-bnid) but keeps the same SC2Pulse
 * character identity. Pre-rebind games carry the OLD pulseId; post-
 * rebind games carry the NEW pulseId; both rows store the SAME
 * pulseCharacterId. The opponent profile must surface games from
 * BOTH toons so H2H counters / win rates / build histories reflect
 * the same player's full record.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { CommunityService } = require("../src/services/community");

describe("Cross-toon merge via pulseCharacterId", () => {
  let mongo;
  let db;

  const OLD_TOON = "1-S2-1-437579";
  const NEW_TOON = "1-S2-1-99999";
  const PULSE_CHAR_ID = "340543107";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "cross_toon_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  /**
   * Seed two opponents docs (one per toon) and four games — two
   * pre-rebind, two post-rebind — that share the same canonical
   * pulseCharacterId.
   */
  async function seedTwoToons() {
    const baseDate = new Date("2026-01-01T00:00:00Z");
    const games = [
      // Pre-rebind games on OLD_TOON
      {
        userId: "u1",
        gameId: "g_old_1",
        date: new Date(baseDate.getTime() + 0),
        result: "Victory",
        myRace: "Protoss",
        map: "Goldenaura",
        durationSec: 600,
        opponent: {
          pulseId: OLD_TOON,
          toonHandle: OLD_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC",
          race: "Terran",
        },
      },
      {
        userId: "u1",
        gameId: "g_old_2",
        date: new Date(baseDate.getTime() + 24 * 3600 * 1000),
        result: "Defeat",
        myRace: "Protoss",
        map: "Hard Lead LE",
        durationSec: 720,
        opponent: {
          pulseId: OLD_TOON,
          toonHandle: OLD_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC",
          race: "Terran",
        },
      },
      // Post-rebind games on NEW_TOON
      {
        userId: "u1",
        gameId: "g_new_1",
        date: new Date(baseDate.getTime() + 48 * 3600 * 1000),
        result: "Victory",
        myRace: "Protoss",
        map: "Goldenaura",
        durationSec: 540,
        opponent: {
          pulseId: NEW_TOON,
          toonHandle: NEW_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC",
          race: "Terran",
        },
      },
      {
        userId: "u1",
        gameId: "g_new_2",
        date: new Date(baseDate.getTime() + 72 * 3600 * 1000),
        result: "Victory",
        myRace: "Protoss",
        map: "Inside and Out",
        durationSec: 480,
        opponent: {
          pulseId: NEW_TOON,
          toonHandle: NEW_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC",
          race: "Terran",
        },
      },
    ];
    await db.games.insertMany(games);
    await db.opponents.insertMany([
      {
        userId: "u1",
        pulseId: OLD_TOON,
        toonHandle: OLD_TOON,
        pulseCharacterId: PULSE_CHAR_ID,
        displayNameSample: "JmaC",
        race: "T",
        gameCount: 2,
        wins: 1,
        losses: 1,
        firstSeen: games[0].date,
        lastSeen: games[1].date,
      },
      {
        userId: "u1",
        pulseId: NEW_TOON,
        toonHandle: NEW_TOON,
        pulseCharacterId: PULSE_CHAR_ID,
        displayNameSample: "JmaC",
        race: "T",
        gameCount: 2,
        wins: 2,
        losses: 0,
        firstSeen: games[2].date,
        lastSeen: games[3].date,
      },
    ]);
  }

  test("OpponentsService.get returns games from BOTH toons", async () => {
    await seedTwoToons();
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.get("u1", OLD_TOON);
    expect(profile).not.toBeNull();
    // 2 old + 2 new = 4
    expect(profile.games.length).toBe(4);
    const ids = profile.games.map((g) => g.id).sort();
    expect(ids).toEqual(["g_new_1", "g_new_2", "g_old_1", "g_old_2"]);
    // Profiling the NEW toon yields the same merged set.
    const profile2 = await opponents.get("u1", NEW_TOON);
    expect(profile2.games.length).toBe(4);
  });

  test("OpponentsService.get exposes mergedToonHandles when > 1 toon merged", async () => {
    await seedTwoToons();
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.get("u1", OLD_TOON);
    expect(Array.isArray(profile.mergedToonHandles)).toBe(true);
    expect(profile.mergedToonHandles.length).toBe(2);
    expect(profile.mergedToonHandles).toEqual(
      expect.arrayContaining([OLD_TOON, NEW_TOON]),
    );
    // The profile's own toon is at the head so the SPA tooltip
    // lists "you clicked this toon, also includes ..." reliably.
    expect(profile.mergedToonHandles[0]).toBe(OLD_TOON);
  });

  test("OpponentsService.get returns single-element mergedToonHandles for unmerged profiles", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: OLD_TOON,
      toonHandle: OLD_TOON,
      displayNameSample: "Solo",
      race: "T",
      gameCount: 0,
      wins: 0,
      losses: 0,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.get("u1", OLD_TOON);
    // Single toon → one entry. The SPA shows the chip only when
    // length > 1, so this is the "no chip rendered" case.
    expect(profile.mergedToonHandles.length).toBe(1);
    expect(profile.mergedToonHandles[0]).toBe(OLD_TOON);
  });

  test("OpponentsService.get falls back to pulseId-only when no character id", async () => {
    // Stuck-on-TOON case: the opponents row has no pulseCharacterId
    // yet. We must still return the games for the toon we asked about.
    await db.games.insertOne({
      userId: "u1",
      gameId: "g_unresolved",
      date: new Date(),
      result: "Victory",
      myRace: "Protoss",
      map: "X",
      durationSec: 600,
      opponent: { pulseId: OLD_TOON, toonHandle: OLD_TOON, displayName: "JmaC", race: "T" },
    });
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: OLD_TOON,
      toonHandle: OLD_TOON,
      displayNameSample: "JmaC",
      race: "T",
      gameCount: 1,
      wins: 1,
      losses: 0,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.get("u1", OLD_TOON);
    expect(profile.games.length).toBe(1);
  });

  test("OverlayLive _recentGamesForOpponent merges by pulseCharacterId when present", async () => {
    await seedTwoToons();
    const overlayLive = new OverlayLiveService(db);
    // Call as if scouting against the NEW toon — opp carries the
    // canonical character id (which the live envelope ALWAYS has on
    // a fresh game post-fix). Pre-rebind games on OLD_TOON should
    // appear in the recent-games list.
    const recent = await overlayLive._recentGamesForOpponent(
      "u1",
      { pulseId: NEW_TOON, pulseCharacterId: PULSE_CHAR_ID },
      "Protoss",
      "Terran",
      undefined,
    );
    // 4 total games; nothing excluded since excludeGameId is undefined
    expect(recent.length).toBe(4);
  });

  test("CommunityService aggregateOpponent merges across rebind for k-anon profile", async () => {
    // Five users each face the same player on both old and new
    // toon: the k-anon threshold (5 distinct contributors) is met.
    const users = ["a", "b", "c", "d", "e"];
    const opps = [];
    for (const u of users) {
      opps.push({
        userId: u,
        gameId: `g_${u}_old`,
        date: new Date(),
        result: "Victory",
        myRace: "Protoss",
        map: "M",
        durationSec: 600,
        opponent: {
          pulseId: OLD_TOON, toonHandle: OLD_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC", race: "Terran",
        },
      });
      opps.push({
        userId: u,
        gameId: `g_${u}_new`,
        date: new Date(),
        result: "Defeat",
        myRace: "Protoss",
        map: "M2",
        durationSec: 800,
        opponent: {
          pulseId: NEW_TOON, toonHandle: NEW_TOON,
          pulseCharacterId: PULSE_CHAR_ID,
          displayName: "JmaC", race: "Terran",
        },
      });
    }
    await db.games.insertMany(opps);
    // Seed one opponents row carrying the pulseCharacterId for the
    // OLD_TOON so aggregateOpponent can discover the canonical id.
    await db.opponents.insertOne({
      userId: "a",
      pulseId: OLD_TOON,
      toonHandle: OLD_TOON,
      pulseCharacterId: PULSE_CHAR_ID,
      displayNameSample: "JmaC",
      race: "T",
      gameCount: 1, wins: 1, losses: 0,
      firstSeen: new Date(), lastSeen: new Date(),
    });
    const community = new CommunityService(db);
    const out = await community.aggregateOpponent(OLD_TOON);
    expect(out).not.toBeNull();
    // 5 wins (us victory = opponent loss) + 5 losses across 10
    // games — the merged set, not just the OLD_TOON half.
    expect(out.games).toBe(10);
    expect(out.contributors).toBe(5);
  });
});
