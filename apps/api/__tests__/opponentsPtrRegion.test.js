// @ts-nocheck
"use strict";

/**
 * OpponentsService — Public Test Realm (PTR) opponents.
 *
 * PTR toon handles start ``98-`` and now carry their own "PTR" region
 * label. That label must reach every region FILTER (the Opponents list
 * and the opponent profile) so PTR games are never hidden behind a
 * region pill, but it must never reach an SC2Pulse lookup: SC2Pulse
 * has no PTR ladder, so a PTR region is treated exactly like the
 * "no region" it used to be.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

const USER = "ptr-user";
const PTR_TOON = "98-S2-1-25175";
const NA_TOON = "1-S2-1-424242";

describe("OpponentsService PTR region", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_ptr_region" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  function makePulseStub(impl = async () => null) {
    const calls = [];
    return {
      calls,
      getCurrentMmr: jest.fn(async (id) => {
        calls.push({ kind: "single", id });
        return impl(id);
      }),
      getCurrentMmrForAny: jest.fn(async (ids, opts) => {
        calls.push({ kind: "any", ids, preferredRegion: opts?.preferredRegion });
        return impl(ids[0]);
      }),
      getCurrentMmrByToon: jest.fn(async (toon) => {
        calls.push({ kind: "toon", toon });
        return impl(toon);
      }),
      getRaceBreakdown: jest.fn(async (ids, opts) => {
        calls.push({ kind: "races", ids, preferredRegion: opts?.preferredRegion });
        return [];
      }),
    };
  }

  /**
   * One opponents row per toon. ``region`` is left off unless given so
   * the toonHandle-prefix fallback (rows that pre-date the stored
   * field) is exercised too.
   */
  async function seedOpponent(toon, extra = {}) {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: toon,
      toonHandle: toon,
      displayNameSample: `Opp ${toon}`,
      race: "T",
      gameCount: 1,
      wins: 1,
      losses: 0,
      firstSeen: new Date("2026-06-01T00:00:00Z"),
      lastSeen: new Date("2026-06-01T00:00:00Z"),
      ...extra,
    });
  }

  async function seedGame(toon, gameId, opponentExtra = {}) {
    await db.games.insertOne({
      userId: USER,
      gameId,
      date: new Date("2026-06-01T00:00:00Z"),
      result: "Victory",
      map: "Test Map",
      myRace: "Protoss",
      myToonHandle: toon.startsWith("98-") ? "98-S2-1-30230" : "1-S2-1-30230",
      durationSec: 600,
      gameVersion: toon.startsWith("98-") ? "5.0.16.97337" : "5.0.15.95000",
      opponent: {
        pulseId: toon,
        toonHandle: toon,
        displayName: `Opp ${toon}`,
        race: "Terran",
        ...opponentExtra,
      },
    });
  }

  describe("Opponents list region filter", () => {
    test("[\"PTR\"] matches a 98- opponent by stored region and by toon prefix; NA does not", async () => {
      await seedOpponent(PTR_TOON);
      await seedOpponent("98-S2-1-77777", { region: "PTR" });
      await seedOpponent(NA_TOON, { region: "NA" });
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));

      const ptr = await opponents.list(USER, { filters: { regions: ["PTR"] } });
      expect(ptr.items.map((o) => o.pulseId).sort()).toEqual(
        ["98-S2-1-25175", "98-S2-1-77777"],
      );

      const na = await opponents.list(USER, { filters: { regions: ["NA"] } });
      expect(na.items.map((o) => o.pulseId)).toEqual([NA_TOON]);

      const both = await opponents.list(USER, {
        filters: { regions: ["NA", "PTR"] },
      });
      expect(both.items).toHaveLength(3);
    });

    test("the filtered (games-aggregated) list keeps PTR opponents under [\"PTR\"] too", async () => {
      await seedOpponent(PTR_TOON);
      await seedOpponent(NA_TOON, { region: "NA" });
      await seedGame(PTR_TOON, "ptr-1");
      await seedGame(NA_TOON, "na-1", { region: "NA" });
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
      const since = new Date("2026-01-01T00:00:00Z");

      const ptr = await opponents.list(USER, { filters: { regions: ["PTR"], since } });
      expect(ptr.items.map((o) => o.pulseId)).toEqual([PTR_TOON]);

      const na = await opponents.list(USER, { filters: { regions: ["NA"], since } });
      expect(na.items.map((o) => o.pulseId)).toEqual([NA_TOON]);
    });

    test("NA's \"1\" prefix never matches a PTR \"98-\" handle without a stored region", async () => {
      await seedOpponent(PTR_TOON);
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
      for (const region of ["NA", "EU", "KR", "CN", "SEA"]) {
        const out = await opponents.list(USER, { filters: { regions: [region] } });
        expect(out.items).toEqual([]);
      }
    });
  });

  describe("Opponent profile region filter", () => {
    test("[\"PTR\"] keeps the 98- opponent's games and [\"NA\"] drops them", async () => {
      await seedOpponent(PTR_TOON);
      // One legacy game derives PTR from the toon handle, one carries the
      // stored label.
      await seedGame(PTR_TOON, "ptr-legacy");
      await seedGame(PTR_TOON, "ptr-stored", { region: "PTR" });
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));

      const ptr = await opponents.get(USER, PTR_TOON, {
        filters: { regions: ["PTR"] },
      });
      expect(ptr.games.map((g) => g.id).sort()).toEqual(["ptr-legacy", "ptr-stored"]);
      expect(ptr.totals).toMatchObject({ wins: 2, losses: 0, total: 2 });

      const na = await opponents.get(USER, PTR_TOON, {
        filters: { regions: ["NA"] },
      });
      expect(na.games).toEqual([]);
      expect(na.totals).toEqual({ wins: 0, losses: 0, total: 0, winRate: 0 });
    });
  });

  describe("ingest stores PTR but never hands it to SC2Pulse", () => {
    const ptrGame = {
      pulseId: PTR_TOON,
      toonHandle: PTR_TOON,
      displayName: "PtrOpponent",
      race: "Z",
      result: "Victory",
      playedAt: new Date("2026-06-10T12:00:00Z"),
    };

    test("recordGame stores region PTR on the opponent row and the game", async () => {
      await seedGame(PTR_TOON, "ptr-ingest");
      const pulseMmr = makePulseStub();
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });
      await opponents.recordGame(USER, { ...ptrGame, gameId: "ptr-ingest" });

      const row = await db.opponents.findOne({ userId: USER, pulseId: PTR_TOON });
      expect(row.region).toBe("PTR");
      const game = await db.games.findOne({ userId: USER, gameId: "ptr-ingest" });
      expect(game.opponent.region).toBe("PTR");
    });

    test("a resolved PTR opponent takes the region-blind SC2Pulse path", async () => {
      await seedGame(PTR_TOON, "ptr-resolved");
      const pulseMmr = makePulseStub(async () => ({ mmr: 3900, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });
      await opponents.recordGame(USER, {
        ...ptrGame,
        gameId: "ptr-resolved",
        pulseCharacterId: "555",
      });

      // Never getCurrentMmrForAny with preferredRegion "PTR": the PTR
      // label is no hint, exactly as the unlabelled handle used to be.
      expect(pulseMmr.calls).toEqual([{ kind: "single", id: "555" }]);
      // The ladder region SC2Pulse reports never replaces PTR, on the
      // row or on the game, so the PTR region filter still finds both.
      const row = await db.opponents.findOne({ userId: USER, pulseId: PTR_TOON });
      expect(row).toMatchObject({ region: "PTR", mmr: 3900 });
      const game = await db.games.findOne({ userId: USER, gameId: "ptr-resolved" });
      expect(game.opponent.region).toBe("PTR");
    });

    test("a ladder region still pins the multi-id SC2Pulse lookup", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 4100, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });
      await opponents.recordGame(USER, {
        ...ptrGame,
        pulseId: NA_TOON,
        toonHandle: NA_TOON,
        pulseCharacterId: "556",
      });

      expect(pulseMmr.calls).toEqual([
        { kind: "any", ids: ["556"], preferredRegion: "NA" },
      ]);
    });

    test("the opponent profile's ladder breakdown gets no PTR region hint", async () => {
      await seedOpponent(PTR_TOON, { region: "PTR", pulseCharacterId: "557" });
      const pulseMmr = makePulseStub();
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), { pulseMmr });

      const identity = await opponents.resolveLadderIdentity(USER, PTR_TOON);
      expect(identity.region).toBeNull();

      await opponents.getPulseRaceBreakdown(USER, PTR_TOON);
      expect(pulseMmr.calls).toEqual([
        { kind: "races", ids: ["557", PTR_TOON], preferredRegion: null },
      ]);
    });
  });
});
