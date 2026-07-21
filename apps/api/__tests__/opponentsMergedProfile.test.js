// @ts-nocheck
"use strict";

/**
 * Linked-player merged profile (``get`` with ``mergeLinked: true``).
 *
 * The Opponents tab groups rows SC2Pulse links to the same human;
 * opening a grouped row must show ONE profile whose games, totals,
 * and timelines span every linked identity — as if all the names were
 * one account — plus a per-name ``mergedIdentities`` breakdown and
 * the player's most-known name up front.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("Merged player profile via SC2Pulse linkage", () => {
  let mongo;
  let db;

  const TOON_A = "1-S2-1-11111";
  const TOON_B = "1-S2-1-22222";
  const TOON_C = "1-S2-1-33333";
  const CID_A = "111";
  const CID_B = "222";
  const CID_C = "333";

  // CID_A and CID_B share a Battle.net account; CID_C is unrelated.
  const linksStub = {
    getLinks: async (ids) => {
      const links = new Map();
      for (const id of ids) {
        if (id === CID_A || id === CID_B) {
          links.set(id, { accountId: "900", proId: null, proNickname: null });
        }
      }
      return { links, partial: false };
    },
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "merged_profile_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  function game({ id, hoursAfterBase, result, toon, cid, name, map }) {
    return {
      userId: "u1",
      gameId: id,
      date: new Date(
        new Date("2026-01-01T00:00:00Z").getTime() +
          hoursAfterBase * 3600 * 1000,
      ),
      result,
      myRace: "Protoss",
      map: map || "Goldenaura",
      durationSec: 600,
      opponent: {
        pulseId: toon,
        toonHandle: toon,
        pulseCharacterId: cid,
        displayName: name,
        race: "Terran",
      },
    };
  }

  /**
   * Seed: 3 games as "MainName" on identity A (2W-1L), 1 game as a
   * barcode on identity B (0W-1L), 1 game vs the unrelated C.
   */
  async function seedLinkedPair({ revealedOnB = null } = {}) {
    await db.games.insertMany([
      game({ id: "a1", hoursAfterBase: 0, result: "Victory", toon: TOON_A, cid: CID_A, name: "MainName" }),
      game({ id: "a2", hoursAfterBase: 24, result: "Victory", toon: TOON_A, cid: CID_A, name: "MainName", map: "Hard Lead LE" }),
      game({ id: "a3", hoursAfterBase: 48, result: "Defeat", toon: TOON_A, cid: CID_A, name: "MainName" }),
      game({ id: "b1", hoursAfterBase: 72, result: "Defeat", toon: TOON_B, cid: CID_B, name: "IIlIIlIl" }),
      game({ id: "c1", hoursAfterBase: 96, result: "Victory", toon: TOON_C, cid: CID_C, name: "Bystander" }),
    ]);
    await db.opponents.insertMany([
      {
        userId: "u1", pulseId: TOON_A, toonHandle: TOON_A,
        pulseCharacterId: CID_A, displayNameSample: "MainName", race: "T",
        gameCount: 3, wins: 2, losses: 1,
        firstSeen: new Date("2026-01-01T00:00:00Z"),
        lastSeen: new Date("2026-01-03T00:00:00Z"),
      },
      {
        userId: "u1", pulseId: TOON_B, toonHandle: TOON_B,
        pulseCharacterId: CID_B, displayNameSample: "IIlIIlIl", race: "T",
        gameCount: 1, wins: 0, losses: 1,
        firstSeen: new Date("2026-01-04T00:00:00Z"),
        lastSeen: new Date("2026-01-04T00:00:00Z"),
        ...(revealedOnB ? { revealedName: revealedOnB } : {}),
      },
      {
        userId: "u1", pulseId: TOON_C, toonHandle: TOON_C,
        pulseCharacterId: CID_C, displayNameSample: "Bystander", race: "T",
        gameCount: 1, wins: 0, losses: 1,
        firstSeen: new Date("2026-01-05T00:00:00Z"),
        lastSeen: new Date("2026-01-05T00:00:00Z"),
      },
    ]);
  }

  function service(links = linksStub) {
    return new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseLinks: links,
    });
  }

  test("mergeLinked folds every linked identity into one profile", async () => {
    await seedLinkedPair();
    const profile = await service().get("u1", TOON_A, { mergeLinked: true });
    expect(profile).not.toBeNull();
    // 3 games as MainName + 1 barcode game; the bystander stays out.
    expect(profile.games.map((g) => g.id).sort()).toEqual(
      ["a1", "a2", "a3", "b1"],
    );
    expect(profile.totals).toMatchObject({ wins: 2, losses: 2, total: 4 });
    // Per-name breakdown, newest activity first.
    expect(profile.mergedIdentities.map((i) => i.pulseId)).toEqual(
      [TOON_B, TOON_A],
    );
    expect(profile.mergedIdentities[1]).toMatchObject({
      pulseId: TOON_A, wins: 2, losses: 1, games: 3, name: "MainName",
    });
    // Most-known name: the readable name with the most games — NOT
    // the barcode the most recent game was played under.
    expect(profile.name).toBe("MainName");
    // All toons merged into the disclosure list.
    expect(profile.mergedToonHandles).toEqual(
      expect.arrayContaining([TOON_A, TOON_B]),
    );
  });

  test("opening the profile from ANY linked identity yields the same merge", async () => {
    await seedLinkedPair();
    const fromBarcode = await service().get("u1", TOON_B, { mergeLinked: true });
    expect(fromBarcode.games.length).toBe(4);
    expect(fromBarcode.name).toBe("MainName");
  });

  test("a revealed name on any identity leads the merged heading", async () => {
    await seedLinkedPair({ revealedOnB: "Star" });
    const profile = await service().get("u1", TOON_A, { mergeLinked: true });
    expect(profile.name).toBe("Star");
    expect(profile.revealedName).toBe("Star");
  });

  test("without mergeLinked the profile stays single-identity", async () => {
    await seedLinkedPair();
    const profile = await service().get("u1", TOON_A);
    expect(profile.games.map((g) => g.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(profile.mergedIdentities).toBeUndefined();
  });

  test("an unlinked opponent merges nothing even with mergeLinked", async () => {
    await seedLinkedPair();
    const profile = await service().get("u1", TOON_C, { mergeLinked: true });
    expect(profile.games.map((g) => g.id)).toEqual(["c1"]);
    expect(profile.mergedIdentities).toBeUndefined();
  });

  test("degrades to single-identity when no links service is wired", async () => {
    await seedLinkedPair();
    const bare = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await bare.get("u1", TOON_A, { mergeLinked: true });
    expect(profile.games.length).toBe(3);
    expect(profile.mergedIdentities).toBeUndefined();
  });

  test("degrades to single-identity when the links lookup throws", async () => {
    await seedLinkedPair();
    const failing = {
      getLinks: async () => {
        throw new Error("pulse down");
      },
    };
    const profile = await service(failing).get("u1", TOON_A, {
      mergeLinked: true,
    });
    expect(profile.games.length).toBe(3);
    expect(profile.mergedIdentities).toBeUndefined();
  });
});
