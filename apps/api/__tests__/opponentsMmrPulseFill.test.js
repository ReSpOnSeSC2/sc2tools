// @ts-nocheck
"use strict";

/**
 * OpponentsService — SC2Pulse MMR + region fill at game ingest.
 *
 * sc2reader almost never carries an opponent's MMR for ranked 1v1
 * ladder replays, so the analyzer's Opponents tab and per-opponent
 * profile would otherwise show "—" forever. recordGame /
 * refreshMetadata fix this by attempting one rate-limited SC2Pulse
 * fetch per ingest, persisting the result on the opponents row, and
 * deriving the region from the toon_handle's leading byte for free.
 *
 * What this suite pins:
 *   * region is derived from toonHandle (no Pulse needed)
 *   * Pulse fetch populates mmr + region when reachable
 *   * Pulse failures leave the prior values intact
 *   * The freshness window suppresses re-fetches for bulk re-uploads
 *   * pulseCharacterId is required — toon-only rows skip the network
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
        calls.push(id);
        return impl(id);
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

  test("Pulse fetch populates mmr + region on first ingest", async () => {
    const pulseMmr = makePulseStub(async () => ({ mmr: 4321, region: "EU" }));
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr,
    });
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls).toEqual(["452727"]);
    const row = await db.opponents.findOne({
      userId: "u1",
      pulseId: baseGame.pulseId,
    });
    expect(row.mmr).toBe(4321);
    expect(row.region).toBe("EU"); // Pulse region overrides toon-derived "NA"
    expect(row.mmrFetchedAt).toBeInstanceOf(Date);
  });

  test("Pulse failure (returns null) leaves prior mmr untouched", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1), {
      pulseMmr: makePulseStub(async () => ({ mmr: 4000, region: "NA" })),
    });
    // First game — successful Pulse fetch persists 4000.
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });

    // Second game — Pulse is down (returns null). Force a refetch by
    // backdating mmrFetchedAt past the freshness window.
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
      gameId: "g2",
    });
    expect(failingPulse.calls).toEqual(["452727"]);
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
    // First ingest — Pulse fetch fires and persists.
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });
    expect(pulseMmr.calls.length).toBe(1);
    // Second ingest immediately after — within the 1h freshness
    // window, so Pulse must NOT be called again.
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
    expect(row.region).toBe("NA"); // Still derived from toonHandle.
  });

  test("Pulse exception is swallowed; ingest still succeeds", async () => {
    const pulseMmr = {
      getCurrentMmr: jest.fn(async () => {
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
    // Seed a row that already exists.
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await opponents.recordGame("u1", {
      ...baseGame,
      pulseCharacterId: "452727",
    });

    // Re-upload triggers refreshMetadata. Pulse now reachable.
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
    expect(pulseMmr.calls).toEqual(["452727"]);
    expect(row.mmr).toBe(4500);
    expect(row.region).toBe("EU");
  });
});
