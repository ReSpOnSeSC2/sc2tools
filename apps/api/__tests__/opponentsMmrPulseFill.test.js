// @ts-nocheck
"use strict";

/**
 * OpponentsService — SC2Pulse MMR + region fill at game ingest.
 *
 * sc2reader almost never carries an opponent's MMR for ranked 1v1
 * ladder replays, so the analyzer's Opponents tab and per-opponent
 * profile would otherwise show "—" forever AND the bingo
 * win_vs_higher_mmr / win_close_mmr predicates would never tick.
 *
 * recordGame / refreshMetadata fix this by:
 *   * Deriving the opponent's region from the toon_handle leading
 *     byte (1=NA, 2=EU, 3=KR, 5=CN, 6=SEA) — cheap, no network.
 *   * Attempting one rate-limited SC2Pulse fetch per ingest
 *     (preferring the derived region for multi-region opponents),
 *     persisting mmr + region on the opponents row.
 *   * Stamping the resolved values onto game.opponent.mmr /
 *     opponent.region in the games collection so the bingo MMR
 *     predicates have data to read from.
 *
 * What this suite pins:
 *   * Region derivation works for every Blizzard region byte.
 *   * Pulse fetch populates mmr + region on first ingest.
 *   * Pulse failure / rate-limit leaves prior values intact.
 *   * Freshness window suppresses re-fetches on bulk re-upload.
 *   * Toon-only rows (no pulseCharacterId) skip the network.
 *   * Pulse exceptions are swallowed.
 *   * refreshMetadata follows the same contract as recordGame.
 *   * The bingo-fix stamp lands on game.opponent.mmr +
 *     opponent.region when the agent didn't supply them, and
 *     respects an explicit agent value when present.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService MMR + region from SC2Pulse", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_mmr_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.games.deleteMany({});
  });

  const baseGame = {
    pulseId: "1-S2-1-267727",
    toonHandle: "1-S2-1-267727",
    displayName: "ReSpOnSe",
    race: "P",
    result: "Victory",
    playedAt: new Date("2026-05-09T12:00:00Z"),
  };

  function makePulseStub(impl) {
    const calls = [];
    return {
      calls,
      getCurrentMmr: jest.fn(async (id) => {
        calls.push({ kind: "single", id });
        return impl(id, undefined);
      }),
      getCurrentMmrForAny: jest.fn(async (ids, opts) => {
        calls.push({ kind: "any", ids, preferredRegion: opts?.preferredRegion });
        return impl(ids[0], opts?.preferredRegion);
      }),
    };
  }

  test("derives region from toonHandle without any Pulse call", async () => {
    const pulseMmr = makePulseStub(async () => null);
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", { ...baseGame });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.region).toBe("NA");
    // No pulseCharacterId on the row → no Pulse call attempted.
    expect(pulseMmr.calls).toEqual([]);
  });

  test("region derivation maps every Blizzard region byte", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const cases = [
      ["1-S2-1-1", "NA"],
      ["2-S2-1-1", "EU"],
      ["3-S2-1-1", "KR"],
      ["5-S2-1-1", "CN"],
      ["6-S2-1-1", "SEA"],
    ];
    for (const [toon, region] of cases) {
      await db.opponents.deleteMany({});
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseId: toon,
        toonHandle: toon,
      });
      const row = await db.opponents.findOne({ userId: "u1", pulseId: toon });
      expect(row.region).toBe(region);
    }
  });

  test("Pulse fetch populates mmr + region on first ingest, region-aware", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "EU" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    // Region-aware path used because pulseMmr has getCurrentMmrForAny
    // and we pass the derived region as preferredRegion.
    expect(pulseMmr.calls.length).toBe(1);
    expect(pulseMmr.calls[0].kind).toBe("any");
    expect(pulseMmr.calls[0].preferredRegion).toBe("NA");
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4321);
    expect(row.region).toBe("EU"); // Pulse region overrides toon-derived NA
    expect(row.mmrFetchedAt).toBeInstanceOf(Date);
  });

  test("Pulse failure (returns null) leaves prior mmr untouched", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: makePulseStub(async () => ({ mmr: 4000, region: "NA" })),
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    // Force a refetch by backdating mmrFetchedAt past the freshness
    // window, then run a second ingest with a Pulse that returns null.
    await db.opponents.updateOne(
      { userId: "u1", pulseId: baseGame.pulseId },
      { $set: { mmrFetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    );
    const failingPulse = makePulseStub(async () => null);
    const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: failingPulse,
    });
    await opponents2.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(failingPulse.calls.length).toBe(1);
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4000); // Prior value preserved.
  });

  test("freshness window suppresses re-fetches on bulk re-upload", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls.length).toBe(1);
    // Second ingest within the freshness window — Pulse must not be
    // called again.
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls.length).toBe(1);
  });

  test("toon-only rows (no pulseCharacterId) skip Pulse entirely", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", { ...baseGame });
    expect(pulseMmr.calls).toEqual([]);
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBeUndefined();
    expect(row.region).toBe("NA");
  });

  test("Pulse exception is swallowed; ingest still succeeds", async () => {
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => {
        throw new Error("rate_limited");
      }),
      getCurrentMmrForAny: jest.fn(async () => {
        throw new Error("rate_limited");
      }),
    };
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await expect(
      opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
      }),
    ).resolves.toMatchObject({ upgraded: true });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBeUndefined();
    expect(row.region).toBe("NA");
  });

  test("refreshMetadata follows the same MMR + region rules", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });

    const pulseMmr = makePulseStub(async () => ({ mmr: 4500, region: "EU" }));
    const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents2.refreshMetadata("u1", {
      pulseId: baseGame.pulseId,
      toonHandle: baseGame.toonHandle,
      pulseCharacterId: "452727",
      displayName: baseGame.displayName,
      race: baseGame.race,
      playedAt: baseGame.playedAt,
    });
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(pulseMmr.calls.length).toBe(1);
    expect(row.mmr).toBe(4500);
    expect(row.region).toBe("EU");
  });

  describe("bingo-fix: stamp game.opponent.mmr / opponent.region", () => {
    beforeEach(async () => {
      // Insert a slim games row that recordGame can stamp on top of.
      await db.games.insertOne({
        userId: "u1",
        gameId: "g1",
        date: new Date("2026-05-09T12:00:00Z"),
        opponent: {
          pulseId: baseGame.pulseId,
          toonHandle: baseGame.toonHandle,
          displayName: baseGame.displayName,
          race: baseGame.race,
        },
      });
    });

    test("stamps when agent didn't supply mmr/region", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        gameId: "g1",
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBe(4321);
      expect(game.opponent.region).toBe("NA");
    });

    test("respects explicit agent-supplied opponent.mmr (no overwrite)", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 9999, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        gameId: "g1",
        mmr: 4321, // agent already had a value
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      // Pulse value not stamped because agent's was kept on opponents
      // row; same logic preserves the agent-supplied value on games.
      expect(game.opponent.mmr).toBeUndefined();
    });

    test("no-op when gameId is omitted (defensive)", async () => {
      const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "NA" }));
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
        // no gameId
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBeUndefined();
      expect(game.opponent.region).toBeUndefined();
    });

    test("refreshMetadata also stamps the games row", async () => {
      // Pre-fill opponents row from a prior ingest.
      const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
      await opponents.recordGame("u1", {
        ...baseGame,
        pulseCharacterId: "452727",
      });

      const pulseMmr = makePulseStub(async () => ({ mmr: 4500, region: "EU" }));
      const opponents2 = new OpponentsService(db, Buffer.alloc(32, 1), {
        pulseMmr,
      });
      await opponents2.refreshMetadata("u1", {
        pulseId: baseGame.pulseId,
        toonHandle: baseGame.toonHandle,
        pulseCharacterId: "452727",
        displayName: baseGame.displayName,
        race: baseGame.race,
        playedAt: baseGame.playedAt,
        gameId: "g1",
      });
      const game = await db.games.findOne({ userId: "u1", gameId: "g1" });
      expect(game.opponent.mmr).toBe(4500);
      expect(game.opponent.region).toBe("EU");
    });
  });
});
