// @ts-nocheck
"use strict";

/**
 * OpponentsService — "current name" invariant.
 *
 * Pins the May-2026 fix that made the Opponents tab heading and the
 * Opponents list row agree on which name to show. Before this fix,
 * the list (filtered path) and the profile heading could disagree
 * for the same pulseId because:
 *   * the list aggregation used ``$last`` on an unsorted ``$group``
 *     input (non-deterministic, and scoped to the filter window),
 *   * the profile read ``displayNameSample`` from the opponents row,
 *     which was overwritten by EVERY ingest (latest UPLOAD wins, not
 *     latest GAME by date — so re-uploading an old replay could flip
 *     the heading back to a stale historical name).
 *
 * Invariant pinned here: ``displayNameSample`` and ``lastSeen`` on
 * the opponents row reflect the displayName / date of the
 * max-``date`` game ingested for that (userId, pulseId). Both
 * ``recordGame`` and ``refreshMetadata`` honour the guard; both
 * read paths (filtered list, profile ``get``) surface the same
 * value.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService current-name invariant", () => {
  let mongo;
  let db;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_current_name" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
  });

  const baseGame = {
    pulseId: "1-S2-1-8636008",
    toonHandle: "1-S2-1-8636008",
    race: "P",
    result: "Victory",
  };

  describe("recordGame write guard", () => {
    test("first ingest stamps displayNameSample + lastSeen from the game", async () => {
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "foruGeoff",
        playedAt: new Date("2024-11-01T00:00:00Z"),
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("foruGeoff");
      expect(row.lastSeen).toEqual(new Date("2024-11-01T00:00:00Z"));
    });

    test("newer-date ingest overwrites displayNameSample + lastSeen", async () => {
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "foruGeoff",
        playedAt: new Date("2024-11-01T00:00:00Z"),
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "RekcOr",
        playedAt: new Date("2026-04-18T00:00:00Z"),
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("RekcOr");
      expect(row.lastSeen).toEqual(new Date("2026-04-18T00:00:00Z"));
    });

    test("older-date ingest must NOT overwrite displayNameSample or lastSeen", async () => {
      // Newest game ingested FIRST — establishes "RekcOr" as the
      // current name.
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "RekcOr",
        playedAt: new Date("2026-04-18T00:00:00Z"),
      });
      // Old replay backfilled LATER — must NOT flip the name back to
      // the stale historical one.
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "foruGeoff",
        playedAt: new Date("2024-11-01T00:00:00Z"),
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("RekcOr");
      expect(row.lastSeen).toEqual(new Date("2026-04-18T00:00:00Z"));
      // Counters still bump on the older ingest — the guard ONLY
      // gates the time-sensitive name/timestamp fields.
      expect(row.gameCount).toBe(2);
      expect(row.wins).toBe(2);
    });

    test("equal-date ingest takes the latest write (>= comparator)", async () => {
      // Two games with the same playedAt timestamp — exact ties go to
      // the newer write. This matches the simulator-friendly
      // semantics: an immediate re-upload of the same game (or a
      // duplicate of a same-timestamp game) refreshes the displayName
      // without flapping.
      const t = new Date("2026-04-18T00:00:00Z");
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "A",
        playedAt: t,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "B",
        playedAt: t,
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("B");
    });
  });

  describe("refreshMetadata write guard", () => {
    test("older-date refresh must NOT overwrite the current name", async () => {
      // Seed the row from a recent game.
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "RekcOr",
        playedAt: new Date("2026-04-18T00:00:00Z"),
      });
      // A re-upload of an OLDER replay hits refreshMetadata.
      await opponents.refreshMetadata("u1", {
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        displayName: "foruGeoff",
        race: "P",
        playedAt: new Date("2024-11-01T00:00:00Z"),
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("RekcOr");
      expect(row.lastSeen).toEqual(new Date("2026-04-18T00:00:00Z"));
    });

    test("newer-date refresh overwrites the current name", async () => {
      await opponents.recordGame("u1", {
        ...baseGame,
        displayName: "foruGeoff",
        playedAt: new Date("2024-11-01T00:00:00Z"),
      });
      await opponents.refreshMetadata("u1", {
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        displayName: "RekcOr",
        race: "P",
        playedAt: new Date("2026-04-18T00:00:00Z"),
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: baseGame.pulseId });
      expect(row.displayNameSample).toBe("RekcOr");
      expect(row.lastSeen).toEqual(new Date("2026-04-18T00:00:00Z"));
    });
  });

  describe("list() self-heals displayNameSample from games", () => {
    /**
     * Seed the bug state: opponents row has the OLD name ("foruGeoff")
     * but games show the player has since renamed to "RekcOr". Used by
     * both filtered and unfiltered list tests below.
     */
    async function seedBugState(userId) {
      await db.opponents.insertOne({
        userId,
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        pulseCharacterId: "8636008",
        // The stale-row scenario: row holds the OLD name. Production
        // rows that pre-date the write guard are stuck here until the
        // backfill migration runs — the self-healing read path must
        // produce the right answer regardless.
        displayNameSample: "foruGeoff",
        race: "P",
        gameCount: 2,
        wins: 1,
        losses: 1,
        firstSeen: new Date("2024-11-01"),
        lastSeen: new Date("2024-11-01"),
      });
      await db.games.insertMany([
        {
          userId,
          gameId: "g_old",
          date: new Date("2024-11-01"),
          result: "Victory",
          myRace: "Protoss",
          map: "M1",
          durationSec: 600,
          opponent: {
            pulseId: baseGame.pulseId,
            toonHandle: baseGame.toonHandle,
            displayName: "foruGeoff",
            race: "Protoss",
          },
        },
        {
          userId,
          gameId: "g_new",
          date: new Date("2026-04-18"),
          result: "Defeat",
          myRace: "Protoss",
          map: "M2",
          durationSec: 700,
          opponent: {
            pulseId: baseGame.pulseId,
            toonHandle: baseGame.toonHandle,
            displayName: "RekcOr",
            race: "Protoss",
          },
        },
      ]);
    }

    test("unfiltered list shows the latest-by-date name from games, not the stale row value", async () => {
      const userId = "u_unfiltered";
      await seedBugState(userId);
      const out = await opponents.list(userId);
      expect(out.items.length).toBe(1);
      expect(out.items[0].displayNameSample).toBe("RekcOr");
    });

    test("filtered list shows the latest-by-date name from games, even when the filter window excludes the latest game", async () => {
      const userId = "u_filtered_outside_window";
      await seedBugState(userId);
      // Filter window covers ONLY the old game (2024). The displayed
      // name still reflects the absolute latest game by date (rule i:
      // identity is not a windowed stat).
      const out = await opponents.list(userId, {
        filters: {
          since: new Date("2024-01-01"),
          until: new Date("2025-01-01"),
        },
      });
      expect(out.items.length).toBe(1);
      expect(out.items[0].displayNameSample).toBe("RekcOr");
    });

    test("filtered list works in the original bug scenario (filter window spans both games)", async () => {
      const userId = "u_filtered_spans";
      await seedBugState(userId);
      const out = await opponents.list(userId, {
        filters: {
          since: new Date("2020-01-01"),
          until: new Date("2030-01-01"),
        },
      });
      expect(out.items.length).toBe(1);
      expect(out.items[0].displayNameSample).toBe("RekcOr");
    });

    test("falls back to the row's displayNameSample when the opponent has no games with a non-empty displayName", async () => {
      const userId = "u_fallback";
      await db.opponents.insertOne({
        userId,
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        displayNameSample: "OnlyRowSample",
        race: "P",
        gameCount: 0,
        wins: 0,
        losses: 0,
        firstSeen: new Date(),
        lastSeen: new Date(),
      });
      const out = await opponents.list(userId);
      expect(out.items[0].displayNameSample).toBe("OnlyRowSample");
    });
  });

  describe("get() returns the latest-by-date game's displayName as name", () => {
    test("profile name reflects the absolute most-recent game, regardless of date filter", async () => {
      const userId = "u_get";
      // Row's stored displayNameSample is STALE (the bug scenario).
      await db.opponents.insertOne({
        userId,
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        pulseCharacterId: "8636008",
        displayNameSample: "foruGeoff",
        race: "P",
        gameCount: 2,
        wins: 1,
        losses: 1,
        firstSeen: new Date("2024-11-01"),
        lastSeen: new Date("2024-11-01"),
      });
      await db.games.insertMany([
        {
          userId,
          gameId: "g_old",
          date: new Date("2024-11-01"),
          result: "Victory",
          myRace: "Protoss",
          map: "M1",
          durationSec: 600,
          opponent: {
            pulseId: baseGame.pulseId,
            toonHandle: baseGame.toonHandle,
            displayName: "foruGeoff",
            race: "Protoss",
          },
        },
        {
          userId,
          gameId: "g_new",
          date: new Date("2026-04-18"),
          result: "Defeat",
          myRace: "Protoss",
          map: "M2",
          durationSec: 700,
          opponent: {
            pulseId: baseGame.pulseId,
            toonHandle: baseGame.toonHandle,
            displayName: "RekcOr",
            race: "Protoss",
          },
        },
      ]);
      // Without a date filter — name comes from the absolute latest
      // game.
      const unfiltered = await opponents.get(userId, baseGame.pulseId);
      expect(unfiltered.name).toBe("RekcOr");
      // The overlay also heals the displayNameSample field so other
      // consumers reading the payload see the same value.
      expect(unfiltered.displayNameSample).toBe("RekcOr");
      // WITH a date filter that scopes totals to the OLD game's
      // window — name STILL reflects the absolute latest, because
      // identity isn't a windowed stat (rule (i)).
      const filtered = await opponents.get(userId, baseGame.pulseId, {
        since: new Date("2024-01-01"),
        until: new Date("2025-01-01"),
      });
      expect(filtered.name).toBe("RekcOr");
    });

    test("get() falls back to displayNameSample when no games exist", async () => {
      const userId = "u_no_games";
      await db.opponents.insertOne({
        userId,
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        displayNameSample: "OnlySample",
        race: "P",
        gameCount: 0,
        wins: 0,
        losses: 0,
        firstSeen: new Date(),
        lastSeen: new Date(),
      });
      const out = await opponents.get(userId, baseGame.pulseId);
      expect(out.name).toBe("OnlySample");
    });
  });
});
