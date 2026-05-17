// @ts-nocheck
"use strict";

/**
 * Integration coverage for ``OpponentsService.get`` —
 * ``last5GamesScouting`` envelope.
 *
 * Seeds a 5-game fixture against one opponent, asserts the per-game
 * scouting envelopes land on the opponent profile in the right
 * order, and pins that the heavy ``macroBreakdown`` blob is stripped
 * from the response (we already learned that lesson with the
 * ``games`` list — the same constraint applies here).
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

/**
 * Macro shape that classifies into "late" with a T3 unit
 * (BroodLord) in the late-phase window.
 */
function makeMacroLate({ duration = 600 } = {}) {
  const opp_bases = [
    { name: "Hatchery", born_time: 0, died_time: duration },
    { name: "Hatchery", born_time: 100, died_time: duration },
    { name: "Hatchery", born_time: 200, died_time: duration },
  ];
  const opp_production_buildings = [
    { name: "SpawningPool", born_time: 30, died_time: duration },
    { name: "RoachWarren", born_time: 90, died_time: duration },
    { name: "HydraliskDen", born_time: 160, died_time: duration },
    { name: "Spire", born_time: 220, died_time: duration },
    { name: "Hive", born_time: 280, died_time: duration },
  ];
  const opp_stats_events = [];
  for (let t = 0; t <= duration; t += 10) {
    opp_stats_events.push({
      time: t,
      food_workers: Math.min(20 + t / 8, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 12, 5000),
    });
  }
  const unit_timeline = [];
  for (let t = 0; t <= duration; t += 30) {
    const opp = t >= 420
      ? { BroodLord: 4, Corruptor: 6 }
      : { Zergling: 8, Roach: 4 };
    unit_timeline.push({ time: t, my: {}, opp });
  }
  return {
    opp_bases,
    opp_production_buildings,
    opp_stats_events,
    unit_timeline,
  };
}

function makeFiveGameFixture(userId, opp) {
  const baseOpp = {
    pulseId: opp.pulseId,
    toonHandle: opp.pulseId,
    displayName: opp.displayName,
    race: "Zerg",
  };
  const oppBuildLog = [
    "[0:12] SpawningPool",
    "[1:30] RoachWarren",
    "[2:40] HydraliskDen",
    "[3:40] Spire",
    "[4:40] Hive",
    "[5:00] GreaterSpire",
    "[7:00] BroodLord",
  ];
  const baseGame = (gameId, dateIso, result) => ({
    userId,
    gameId,
    date: new Date(dateIso),
    result,
    myRace: "Protoss",
    myBuild: "PvZ - 3 Stargate Phoenix",
    map: "Goldenaura LE",
    durationSec: 600,
    opponent: { ...baseOpp, strategy: "Zerg - Brood Lord Macro" },
    oppBuildLog,
    macroBreakdown: makeMacroLate(),
  });
  return [
    baseGame("g1", "2026-04-10T00:00:00Z", "Victory"),
    baseGame("g2", "2026-04-11T00:00:00Z", "Victory"),
    baseGame("g3", "2026-04-12T00:00:00Z", "Defeat"),
    baseGame("g4", "2026-04-13T00:00:00Z", "Victory"),
    baseGame("g5", "2026-04-14T00:00:00Z", "Defeat"),
  ];
}

describe("OpponentsService last5GamesScouting", () => {
  /** @type {MongoMemoryServer} */
  let mongo;
  /** @type {Awaited<ReturnType<typeof connect>>} */
  let db;
  /** @type {OpponentsService} */
  let opponents;
  const userId = "u_scouting";
  const pulseId = "1-S2-1-12345";
  const displayName = "WallOfHydra";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_scouting" });
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

  async function seedFixture() {
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      pulseCharacterId: "12345",
      displayNameSample: displayName,
      race: "Z",
      gameCount: 5,
      wins: 3,
      losses: 2,
      firstSeen: new Date("2026-04-10T00:00:00Z"),
      lastSeen: new Date("2026-04-14T00:00:00Z"),
    });
    await db.games.insertMany(makeFiveGameFixture(userId, { pulseId, displayName }));
  }

  test("envelope carries last5GamesScouting with 5 entries newest-first", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    expect(out).not.toBeNull();
    expect(Array.isArray(out.last5GamesScouting)).toBe(true);
    expect(out.last5GamesScouting.length).toBe(5);
    const ids = out.last5GamesScouting.map((g) => g.gameId);
    expect(ids).toEqual(["g5", "g4", "g3", "g2", "g1"]);
  });

  test("per-game envelopes carry real build-order events with timestamps", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const g = out.last5GamesScouting[0];
    expect(g.oppBuildOrder.length).toBeGreaterThan(0);
    const broodLord = g.oppBuildOrder.find((e) => e.name === "BroodLord");
    expect(broodLord).toBeDefined();
    expect(broodLord.time).toBe(420);
    expect(broodLord.category).toBe("unit");
    expect(broodLord.tier).toBe(3);
  });

  test("per-game envelopes do NOT leak macroBreakdown", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    for (const env of out.last5GamesScouting) {
      expect(env.macroBreakdown).toBeUndefined();
    }
  });

  test("endPhase + endReason reflect the per-game classifier output", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    for (const env of out.last5GamesScouting) {
      expect(env.endPhase).toBe("late");
      expect(env.endReason).toBe("macro_game");
    }
  });

  test("oppCompositionByPhase.late surfaces the real BroodLord count", async () => {
    await seedFixture();
    const out = await opponents.get(userId, pulseId);
    const env = out.last5GamesScouting[0];
    const lateUnits = env.oppCompositionByPhase.late.units;
    const broodLord = lateUnits.find((u) => u.token === "BroodLord");
    expect(broodLord).toBeDefined();
    expect(broodLord.count).toBe(4);
  });

  test("opponent profile with 0 games returns empty last5GamesScouting", async () => {
    await db.opponents.insertOne({
      userId,
      pulseId,
      pulseCharacterId: "99999",
      displayNameSample: "EmptyOpp",
      race: "Z",
      gameCount: 0,
      wins: 0,
      losses: 0,
      firstSeen: new Date("2026-04-10T00:00:00Z"),
      lastSeen: new Date("2026-04-10T00:00:00Z"),
    });
    const out = await opponents.get(userId, pulseId);
    expect(out).not.toBeNull();
    expect(out.last5GamesScouting).toEqual([]);
  });
});
