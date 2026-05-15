// @ts-nocheck
"use strict";

/**
 * OpponentsService — read-time MMR overlay from games.
 *
 * Self-healing safety net for the gap the ingest-time Pulse fill
 * leaves behind. If ``opponents.mmr`` is null/missing on a row but
 * one of the user's games against that opponent carries
 * ``game.opponent.mmr`` (because sc2reader extracted it, OR because
 * a successful Pulse fetch stamped it, OR because pulseCharacterId
 * was resolved post-ingest and the row never got re-stamped), the
 * read path now surfaces that value at zero outbound-Pulse cost.
 *
 * Pinned behaviours:
 *   * list (unfiltered) overlays mmr + region from the latest game
 *     that carries them, when the opponents row's stored mmr is
 *     missing.
 *   * Non-null stored mmr on the row wins — the overlay never
 *     overwrites authoritative data.
 *   * get (profile) applies the same overlay before returning.
 *   * Rows with NO mmr anywhere (neither opponents row nor any
 *     game) remain null — we don't fabricate values.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService read-time MMR overlay from games", () => {
  let mongo;
  let db;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_mmr_overlay" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
  });

  async function insertOpponent(overrides = {}) {
    const base = {
      userId: "u1",
      pulseId: "2-S2-1-10785011",
      toonHandle: "2-S2-1-10785011",
      pulseCharacterId: "341267627",
      displayNameSample: "Remonitions",
      race: "Zerg",
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: new Date("2026-05-07T16:00:00Z"),
      lastSeen: new Date("2026-05-07T16:50:20Z"),
    };
    await db.opponents.insertOne({ ...base, ...overrides });
  }

  async function insertGame(overrides = {}) {
    const base = {
      userId: "u1",
      gameId: "g1",
      date: new Date("2026-05-07T16:50:20Z"),
      result: "Defeat",
      myRace: "Protoss",
      map: "Hard Lead LE",
      durationSec: 620,
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        pulseCharacterId: "341267627",
        displayName: "Remonitions",
        race: "Zerg",
      },
    };
    await db.games.insertOne({ ...base, ...overrides });
  }

  test("list overlays mmr + region from the latest game when row is blank", async () => {
    await insertOpponent(); // no mmr on row
    await insertGame({
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        pulseCharacterId: "341267627",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 4687,
        region: "EU",
      },
    });
    const { items } = await opponents.list("u1");
    expect(items).toHaveLength(1);
    expect(items[0].mmr).toBe(4687);
    expect(items[0].region).toBe("EU");
  });

  test("list overlay picks the most-recent game with mmr, not just any", async () => {
    await insertOpponent();
    // Older game DOES carry mmr; newer game does NOT.
    await insertGame({
      gameId: "g_old",
      date: new Date("2026-05-01T10:00:00Z"),
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 4500,
        region: "EU",
      },
    });
    await insertGame({
      gameId: "g_new",
      date: new Date("2026-05-07T16:50:20Z"),
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        displayName: "Remonitions",
        race: "Zerg",
        // no mmr / region
      },
    });
    const { items } = await opponents.list("u1");
    // The overlay aggregation filters to games WITH mmr, so the
    // newer-without-mmr game is skipped and the older-with-mmr wins.
    expect(items[0].mmr).toBe(4500);
    expect(items[0].region).toBe("EU");
  });

  test("list overlay never overwrites a stored mmr on the row", async () => {
    await insertOpponent({ mmr: 4687, region: "EU" });
    await insertGame({
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 9999, // stale value from sc2reader — should NOT overwrite
        region: "NA",
      },
    });
    const { items } = await opponents.list("u1");
    expect(items[0].mmr).toBe(4687);
    expect(items[0].region).toBe("EU");
  });

  test("list returns null mmr when no game carries one either", async () => {
    await insertOpponent(); // no mmr
    await insertGame(); // no opponent.mmr
    const { items } = await opponents.list("u1");
    expect(items[0].mmr).toBeUndefined();
  });

  test("get (profile) overlays mmr + region the same way", async () => {
    await insertOpponent();
    await insertGame({
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        pulseCharacterId: "341267627",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 4687,
        region: "EU",
      },
    });
    const profile = await opponents.get("u1", "2-S2-1-10785011");
    expect(profile.mmr).toBe(4687);
    expect(profile.region).toBe("EU");
  });

  test("get never overwrites a stored row mmr", async () => {
    await insertOpponent({ mmr: 4687, region: "EU" });
    await insertGame({
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 9999,
        region: "NA",
      },
    });
    const profile = await opponents.get("u1", "2-S2-1-10785011");
    expect(profile.mmr).toBe(4687);
    expect(profile.region).toBe("EU");
  });

  test("overlay does NOT trigger any SC2Pulse call", async () => {
    // Constructed WITHOUT a pulseMmr dep — proves the read-time
    // path never reaches for one. If anything in list/get tried to
    // call it, the test would throw on undefined.
    const opponentsNoPulse = new OpponentsService(db, Buffer.alloc(32, 1));
    await insertOpponent();
    await insertGame({
      opponent: {
        pulseId: "2-S2-1-10785011",
        toonHandle: "2-S2-1-10785011",
        displayName: "Remonitions",
        race: "Zerg",
        mmr: 4687,
        region: "EU",
      },
    });
    const { items } = await opponentsNoPulse.list("u1");
    expect(items[0].mmr).toBe(4687);
    const profile = await opponentsNoPulse.get("u1", "2-S2-1-10785011");
    expect(profile.mmr).toBe(4687);
  });
});
