// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe("OpponentsService profile detail memory bounds", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_profile_bounds" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  test("keeps 101 slim rows while serially reducing at most 100 details", async () => {
    const userId = "u_profile_bound";
    const pulseId = "1-S2-1-900000";
    const giant = "x".repeat(128 * 1024);
    await db.opponents.insertOne({
      userId,
      pulseId,
      toonHandle: pulseId,
      displayNameSample: "Bounded",
      race: "Z",
      wins: 51,
      losses: 50,
      gameCount: 101,
      legacyUnknown: giant,
    });
    await db.games.insertMany(Array.from({ length: 101 }, (_, i) => ({
      userId,
      gameId: `bounded-${i}`,
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      result: i % 2 === 0 ? "Victory" : "Defeat",
      map: "Bounded LE",
      myRace: "Protoss",
      myBuild: "Gateway Expand",
      durationSec: 600,
      opponent: {
        pulseId,
        toonHandle: pulseId,
        displayName: "Bounded",
        race: "Zerg",
        strategy: "Macro",
        legacyUnknown: giant,
      },
    })));

    let active = 0;
    let maxActive = 0;
    const gameDetails = {
      findMany: jest.fn(() => {
        throw new Error("profile must not bulk hydrate details");
      }),
      findOne: jest.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          buildLog: [`[0:20] Pylon ${giant}`],
          oppBuildLog: ["[0:17] SpawningPool"],
          macroBreakdown: {
            bases: [],
            production_buildings: [],
            stats_events: [],
            unit_timeline: [],
            legacyUnknown: giant,
          },
          legacyUnknown: giant,
        };
      }),
    };
    const gamesFind = jest.spyOn(db.games, "find");
    const opponentsFindOne = jest.spyOn(db.opponents, "findOne");
    const service = new OpponentsService(db, Buffer.alloc(32, 1), {
      gameDetails,
    });

    const out = await service.getAnalysis(userId, pulseId, { includeProfile: true });

    expect(out.games).toHaveLength(101);
    expect(out.totals).toMatchObject({ wins: 51, losses: 50, total: 101 });
    expect(out.analysisSampleSize).toBe(100);
    expect(out.analysisSampleLimit).toBe(100);
    expect(out.analysisSampleTruncated).toBe(true);
    expect(out.phases.flags).toContain("profile_sample_truncated");
    expect(gameDetails.findOne).toHaveBeenCalledTimes(100);
    expect(gameDetails.findMany).not.toHaveBeenCalled();
    expect(maxActive).toBe(1);
    for (const call of gameDetails.findOne.mock.calls) {
      expect(call[2]).toEqual({
        fields: ["buildLog", "oppBuildLog", "macroBreakdown"],
      });
    }

    const profileFind = gamesFind.mock.calls.find(([, options]) =>
      options?.projection?.["opponent.displayName"] === 1
    );
    expect(profileFind).toBeDefined();
    expect(profileFind[1].projection).not.toHaveProperty("opponent");
    expect(profileFind[1].projection).not.toHaveProperty("buildLog");
    expect(profileFind[1].projection).not.toHaveProperty("macroBreakdown");
    expect(opponentsFindOne.mock.calls[0][1].projection).not.toHaveProperty(
      "legacyUnknown",
    );
    expect(JSON.stringify(out)).not.toContain("legacyUnknown");
    expect(JSON.stringify(out)).not.toContain(giant.slice(0, 1024));
  });

  test("the public gate admits 2 before metadata loading, queues 8, and rejects excess work without reads", async () => {
    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    await db.opponents.insertOne({ userId: USER_ID_FOR_GATE, pulseId: "gate-rival", displayNameSample: "Gate rival" });
    await db.games.insertOne({
      userId: USER_ID_FOR_GATE, gameId: "g-gated", date: new Date("2026-07-01"),
      myRace: "Protoss", durationSec: 300, opponent: { pulseId: "gate-rival", race: "Zerg", strategy: "Macro" },
    });
    let active = 0;
    let maxActive = 0;
    const gameDetails = {
      findOne: jest.fn(async () => {
        active += 1; maxActive = Math.max(maxActive, active);
        await blocked;
        active -= 1;
        return emptyDetails();
      }),
    };
    const service = new OpponentsService(db, Buffer.alloc(32, 1), { gameDetails });
    const opponentRead = jest.spyOn(db.opponents, "findOne");
    const metadataRead = jest.spyOn(db.games, "find");
    const tasks = Array.from({ length: 11 }, () => service.getAnalysis(USER_ID_FOR_GATE, "gate-rival"));
    const rejected = expect(tasks[10]).rejects.toMatchObject({ status: 503, code: "opponent_profile_busy", retryAfterMs: 1_000 });
    try {
      await until(() => gameDetails.findOne.mock.calls.length === 2);
      expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 2, queued: 8, maxActive: 2, maxWaiters: 8 });
      expect(maxActive).toBe(2);
      expect(opponentRead).toHaveBeenCalledTimes(2);
      expect(metadataRead).toHaveBeenCalledTimes(2);
      await rejected;
      // Cheap briefs continue serving while every analysis slot is occupied.
      const brief = await service.get(USER_ID_FOR_GATE, "gate-rival");
      expect(brief.games).toHaveLength(1);
      expect(brief).not.toHaveProperty("phases");
      expect(gameDetails.findOne).toHaveBeenCalledTimes(2);
      expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 2, queued: 8 });
    } finally {
      unblock();
      await Promise.allSettled(tasks);
    }
    expect(gameDetails.findOne).toHaveBeenCalledTimes(10);
    expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test("holds admission after hydration until the complete analysis promise settles, and releases errors", async () => {
    let finishAnalysis;
    const analysisDone = new Promise((resolve) => { finishAnalysis = resolve; });
    const gameDetails = { findOne: jest.fn(async () => emptyDetails()) };
    const service = new OpponentsService({ games: { findOne: jest.fn() } }, Buffer.alloc(32, 1), { gameDetails });
    let hydrated = 0;
    const loader = jest.spyOn(service, "_getProfile").mockImplementation(async () => {
      await service._hydrateProfileAnalyticalSample(USER_ID_FOR_GATE, [{
        game: { gameId: "g-gated", myRace: "Protoss", durationSec: 300, opponent: { race: "Zerg" } },
        inDateScope: true, recentScouting: false,
      }]);
      hydrated += 1;
      await analysisDone;
      return { analysisSampleSize: 1 };
    });
    const tasks = Array.from({ length: 3 }, () => service.getAnalysis(USER_ID_FOR_GATE, "gate-rival"));
    try {
      await until(() => hydrated === 2);
      expect(gameDetails.findOne).toHaveBeenCalledTimes(2);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 2, queued: 1 });
    } finally {
      finishAnalysis();
      await Promise.allSettled(tasks);
    }
    expect(loader).toHaveBeenCalledTimes(3);
    expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
    loader.mockRejectedValueOnce(new Error("cohort load failed"));
    await expect(service.getAnalysis(USER_ID_FOR_GATE, "gate-rival")).rejects.toThrow("cohort load failed");
    expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});

const USER_ID_FOR_GATE = "u_profile_gate";

function emptyDetails() {
  return { buildLog: [], oppBuildLog: [], macroBreakdown: { bases: [], production_buildings: [], stats_events: [], unit_timeline: [] } };
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("analysis did not reach the expected bounded stage");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
