// @ts-nocheck
"use strict";

/**
 * Cross-user SC2Pulse sharing.
 *
 * The headline behaviour: once ONE user pulls an opponent's SC2Pulse
 * data (resolution + current MMR + per-race breakdown), the next user
 * who runs into the same real account reuses it from the shared
 * ``pulse_accounts`` cache instead of spending another SC2Pulse
 * round-trip — so their opponent profile fills instantly.
 *
 * The "SC2Pulse client" here is a call-counting fake (no network, no
 * fixtures): we assert it is hit for the FIRST user and NOT hit again
 * for the second.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { PulseDirectoryService } = require("../src/services/pulseDirectory");
const { buildPulseResolver } = require("../src/services/pulseResolver");

const TOON = "1-S2-1-267727";

function makeFakePulse() {
  const calls = { getCurrentMmr: 0, getCurrentMmrForAny: 0, getRaceBreakdown: 0 };
  const pulse = {
    async getCurrentMmr() {
      calls.getCurrentMmr += 1;
      return { mmr: 5200, region: "NA" };
    },
    async getCurrentMmrForAny() {
      calls.getCurrentMmrForAny += 1;
      return { mmr: 5200, region: "NA" };
    },
    async getRaceBreakdown() {
      calls.getRaceBreakdown += 1;
      return [
        { race: "Protoss", mmr: 5200, games: 120, league: "Diamond", region: "NA" },
        { race: "Zerg", mmr: 4800, games: 30, league: "Diamond", region: "NA" },
      ];
    },
  };
  return { pulse, calls };
}

describe("cross-user SC2Pulse sharing via the directory", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "pulse_sharing_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.pulseAccounts.deleteMany({});
  });

  const game = (overrides = {}) => ({
    pulseId: TOON,
    toonHandle: TOON,
    pulseCharacterId: "267727",
    displayName: "ReSpOnSe",
    race: "P",
    result: "Victory",
    gameId: "g1",
    playedAt: new Date("2026-05-20T12:00:00Z"),
    ...overrides,
  });

  test("second user's opponent MMR is served from the cache, not SC2Pulse", async () => {
    const { pulse, calls } = makeFakePulse();
    const directory = new PulseDirectoryService(db);
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: pulse,
      pulseDirectory: directory,
    });

    // User A is the first to face this opponent — SC2Pulse is pulled
    // once and the result is written to the shared cache.
    const a = await opponents.recordGame("userA", game({ gameId: "a1" }));
    expect(a.mmr).toBe(5200);
    expect(calls.getCurrentMmrForAny).toBe(1);
    const cached = await directory.getFreshMmr({ toonHandle: TOON });
    expect(cached.mmr).toBe(5200);

    // User B runs into the SAME account. No additional SC2Pulse call —
    // the MMR comes straight from the shared cache, yet B's own row is
    // still stamped with the value.
    const b = await opponents.recordGame("userB", game({ gameId: "b1" }));
    expect(b.mmr).toBe(5200);
    expect(calls.getCurrentMmrForAny).toBe(1);
    const rowB = await db.opponents.findOne({ userId: "userB", pulseId: TOON });
    expect(rowB.mmr).toBe(5200);
    expect(rowB.region).toBe("NA");
  });

  test("per-race breakdown pulled by one user serves the next instantly", async () => {
    const { pulse, calls } = makeFakePulse();
    const directory = new PulseDirectoryService(db);
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: pulse,
      pulseDirectory: directory,
    });
    await opponents.recordGame("userA", game({ gameId: "a1" }));
    await opponents.recordGame("userB", game({ gameId: "b1" }));

    // First profile open (user A) pulls the breakdown once.
    const first = await opponents.getPulseRaceBreakdown("userA", TOON);
    expect(first.resolved).toBe(true);
    expect(first.races).toHaveLength(2);
    expect(first.topRace).toBe("Protoss");
    expect(calls.getRaceBreakdown).toBe(1);

    // User B opens the same opponent's profile — served from the shared
    // cache, no extra SC2Pulse round-trip.
    const second = await opponents.getPulseRaceBreakdown("userB", TOON);
    expect(second.resolved).toBe(true);
    expect(second.races).toHaveLength(2);
    expect(calls.getRaceBreakdown).toBe(1);
  });

  test("admin Retry forces a fresh pull and refreshes the shared cache for everyone", async () => {
    const directory = new PulseDirectoryService(db);
    // A peer's slightly-stale value is already cached (within TTL).
    await directory.recordMmr({
      toonHandle: TOON,
      pulseCharacterId: "267727",
      mmr: 4000,
      region: "NA",
    });
    let breakdownCalls = 0;
    const pulse = {
      async getCurrentMmrForAny() {
        return { mmr: 5000, region: "NA" };
      },
      async getCurrentMmr() {
        return { mmr: 5000, region: "NA" };
      },
      async getRaceBreakdown() {
        breakdownCalls += 1;
        return [
          { race: "Protoss", mmr: 5000, games: 50, league: "Master", region: "NA" },
        ];
      },
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: pulse,
      pulseDirectory: directory,
    });
    // Seed an opponents row for the admin's target user.
    await opponents.recordGame("userA", game({ gameId: "a1" }));

    // Retry: must bypass the cached 4000 and pull the live 5000…
    const retry = await opponents.retryPulseResolution("userA", TOON);
    expect(retry).toBeTruthy();
    expect(retry.mmr).toBe(5000);

    // …and the fresh value must be written through so EVERY user now
    // sees 5000 from the shared cache.
    const shared = await directory.getFreshMmr({ toonHandle: TOON });
    expect(shared.mmr).toBe(5000);
    expect(breakdownCalls).toBeGreaterThan(0);
  });

  test("resolver reuses another user's resolution without hitting SC2Pulse", async () => {
    const directory = new PulseDirectoryService(db);
    // Pre-seed as if user A already resolved this toon.
    await directory.recordResolution({
      toonHandle: TOON,
      pulseCharacterId: "267727",
      displayName: "ReSpOnSe",
    });
    // Build a resolver whose fetch throws if it is ever called — proving
    // the resolution came entirely from the shared cache.
    const resolver = buildPulseResolver({
      fetchImpl: async () => {
        throw new Error("network should not be touched");
      },
      directory,
    });
    const id = await resolver.resolve({
      toonHandle: TOON,
      displayName: "ReSpOnSe",
      forceRefresh: true,
    });
    expect(id).toBe("267727");
  });
});
