// @ts-nocheck
"use strict";

/**
 * OpponentsService — read-time "Last MMR" overlay from games.
 *
 * The "Last MMR" column means "the opponent's MMR in the race they
 * played in your most recent game against them". The read overlay is
 * race-aware: it RECOGNISES the race the opponent played in the most
 * recent game, then PICKS the most recent game OF THAT RACE that
 * carries an ``opponent.mmr`` (stamped race-correct at ingest by
 * ``_stampGameOpponentMmr`` via the SC2Pulse per-race breakdown). That
 * value is preferred over the opponents-row ``mmr``, which is
 * SC2Pulse's race-AGNOSTIC current rating (``_fetchTeams`` collapses
 * every race to the most-recently-played team) and would surface the
 * wrong race for a multi-race opponent. Pure database read — zero
 * outbound Pulse traffic.
 *
 * Pinned behaviours:
 *   * list (unfiltered) + get (profile) surface the most recent
 *     same-race-as-the-latest-game mmr (+ region), preferred over the
 *     row's stored value. A Protoss game never lends its rating to a
 *     row whose last game was Terran.
 *   * When NO game of the latest race carries an ``opponent.mmr``, the
 *     opponents-row stored mmr is used (the AngryBird case — ranked
 *     1v1 replays are mmr-less, so the row holds the only number).
 *   * Rows with NO mmr anywhere (neither row nor any game) remain
 *     null — we don't fabricate values.
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

  test(
    "list prefers the most-recent game's (race-correct) mmr over the " +
      "row's race-agnostic stored mmr",
    async () => {
      // Mirrors the "trigger" report: the opponents row holds SC2Pulse's
      // collapsed current rating (their Protoss 6360 — the race they
      // ladder most), but the most recent game the user actually played
      // was the opponent's Terran (5400, stamped race-correct onto the
      // game). The column promises "MMR from the most recent game", so
      // the game value must win.
      await insertOpponent({ mmr: 6360, region: "EU" }); // Protoss, race-agnostic
      await insertGame({
        gameId: "g_protoss",
        date: new Date("2026-05-06T10:00:00Z"),
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Protoss",
          mmr: 6360,
          region: "EU",
        },
      });
      await insertGame({
        gameId: "g_terran",
        date: new Date("2026-05-07T16:50:20Z"), // most recent
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Terran",
          mmr: 5400,
          region: "EU",
        },
      });
      const { items } = await opponents.list("u1");
      expect(items[0].mmr).toBe(5400);
      expect(items[0].region).toBe("EU");
    },
  );

  test(
    "list picks the most-recent SAME-RACE game's mmr, ignoring a more " +
      "recent different-race rating",
    async () => {
      // The crux of the fix: the most recent game is Terran but carries
      // no stamped mmr; a more-recent-than-the-Terran-with-mmr Protoss
      // game DOES carry 6360. We must still show the Terran 5400 (the
      // race actually played most recently), never the Protoss 6360.
      await insertOpponent(); // no stored mmr
      await insertGame({
        gameId: "g_terran_old",
        date: new Date("2026-05-06T10:00:00Z"),
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Terran",
          mmr: 5400,
          region: "EU",
        },
      });
      await insertGame({
        gameId: "g_protoss",
        date: new Date("2026-05-07T12:00:00Z"),
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Protoss",
          mmr: 6360,
          region: "EU",
        },
      });
      await insertGame({
        gameId: "g_terran_recent",
        date: new Date("2026-05-07T17:00:00Z"), // most recent overall, no mmr
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Terran",
        },
      });
      const { items } = await opponents.list("u1");
      expect(items[0].mmr).toBe(5400);
      expect(items[0].region).toBe("EU");
    },
  );

  test("list keeps the row's stored mmr when no game carries one", async () => {
    // Fallback tier: ranked-1v1 replays are mmr-less, so the only number
    // we have is the SC2Pulse value stamped on the opponents row.
    await insertOpponent({ mmr: 5961, region: "NA" });
    await insertGame(); // no opponent.mmr
    const { items } = await opponents.list("u1");
    expect(items[0].mmr).toBe(5961);
    expect(items[0].region).toBe("NA");
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

  test(
    "get (profile) prefers the most-recent game's race-correct mmr over " +
      "the row's stored mmr",
    async () => {
      await insertOpponent({ mmr: 6360, region: "EU" }); // Protoss, race-agnostic
      await insertGame({
        gameId: "g_protoss",
        date: new Date("2026-05-06T10:00:00Z"),
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Protoss",
          mmr: 6360,
          region: "EU",
        },
      });
      await insertGame({
        gameId: "g_terran",
        date: new Date("2026-05-07T16:50:20Z"), // most recent
        opponent: {
          pulseId: "2-S2-1-10785011",
          toonHandle: "2-S2-1-10785011",
          displayName: "Remonitions",
          race: "Terran",
          mmr: 5400,
          region: "EU",
        },
      });
      const profile = await opponents.get("u1", "2-S2-1-10785011");
      expect(profile.mmr).toBe(5400);
      expect(profile.region).toBe("EU");
    },
  );

  test("get keeps the row's stored mmr when no game carries one", async () => {
    await insertOpponent({ mmr: 5961, region: "NA" });
    await insertGame(); // no opponent.mmr
    const profile = await opponents.get("u1", "2-S2-1-10785011");
    expect(profile.mmr).toBe(5961);
    expect(profile.region).toBe("NA");
  });

  test(
    "filtered list path falls back to the opponents-row mmr when " +
      "no game in the window carries one (the AngryBird regression)",
    async () => {
      // The bug: a high-ladder opponent (AngryBird @ 5961 MMR) shows
      // up on the Opponents tab with the MMR column blank when the
      // user has a date filter on. sc2reader doesn't carry mmr for
      // ranked 1v1, so every game.opponent.mmr is null; the only
      // place we have the number is the opponents row (stamped from
      // SC2Pulse during recordGame). The filtered list path used to
      // ignore that fallback entirely.
      await insertOpponent({
        pulseId: "1-S2-1-9999999",
        toonHandle: "1-S2-1-9999999",
        pulseCharacterId: "555444333",
        displayNameSample: "AngryBird",
        mmr: 5961,
        region: "NA",
        firstSeen: new Date("2026-05-01T10:00:00Z"),
        lastSeen: new Date("2026-05-09T20:00:00Z"),
      });
      // Three games against AngryBird in the filter window, none
      // carrying opponent.mmr.
      await db.games.insertMany([
        {
          userId: "u1",
          gameId: "g1",
          date: new Date("2026-05-09T18:00:00Z"),
          result: "Defeat",
          myRace: "Protoss",
          map: "Hard Lead LE",
          durationSec: 720,
          opponent: {
            pulseId: "1-S2-1-9999999",
            toonHandle: "1-S2-1-9999999",
            displayName: "AngryBird",
            race: "Zerg",
          },
        },
        {
          userId: "u1",
          gameId: "g2",
          date: new Date("2026-05-09T19:00:00Z"),
          result: "Victory",
          myRace: "Protoss",
          map: "Hard Lead LE",
          durationSec: 720,
          opponent: {
            pulseId: "1-S2-1-9999999",
            toonHandle: "1-S2-1-9999999",
            displayName: "AngryBird",
            race: "Zerg",
          },
        },
        {
          userId: "u1",
          gameId: "g3",
          date: new Date("2026-05-09T20:00:00Z"),
          result: "Defeat",
          myRace: "Protoss",
          map: "Hard Lead LE",
          durationSec: 720,
          opponent: {
            pulseId: "1-S2-1-9999999",
            toonHandle: "1-S2-1-9999999",
            displayName: "AngryBird",
            race: "Zerg",
          },
        },
      ]);
      const { items } = await opponents.list("u1", {
        filters: {
          since: new Date("2026-05-09T00:00:00Z"),
          until: new Date("2026-05-10T00:00:00Z"),
        },
      });
      expect(items).toHaveLength(1);
      expect(items[0].displayNameSample).toBe("AngryBird");
      expect(items[0].mmr).toBe(5961);
      expect(items[0].region).toBe("NA");
    },
  );

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
