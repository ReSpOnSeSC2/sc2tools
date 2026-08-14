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

    const out = await service.get(userId, pulseId);

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

  test("global analysis gate admits 2, queues 8, then fails retryably", async () => {
    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    let active = 0;
    let maxActive = 0;
    const gameDetails = {
      findOne: jest.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await blocked;
        active -= 1;
        return {
          buildLog: [],
          oppBuildLog: [],
          macroBreakdown: {
            bases: [],
            production_buildings: [],
            stats_events: [],
            unit_timeline: [],
          },
        };
      }),
    };
    const service = new OpponentsService(
      { games: { findOne: jest.fn() } },
      Buffer.alloc(32, 1),
      { gameDetails },
    );
    const choice = {
      game: {
        gameId: "g-gated",
        myRace: "Protoss",
        durationSec: 300,
        opponent: { race: "Zerg", strategy: "Macro" },
      },
      inDateScope: true,
      recentScouting: false,
    };
    const tasks = Array.from({ length: 11 }, () =>
      service._hydrateProfileAnalyticalSample(USER_ID_FOR_GATE, [choice])
    );
    const rejected = expect(tasks[10]).rejects.toMatchObject({
      status: 503,
      code: "opponent_profile_busy",
      retryAfterMs: 1_000,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({
      active: 2,
      queued: 8,
      maxActive: 2,
      maxWaiters: 8,
    });
    expect(maxActive).toBe(2);
    await rejected;

    unblock();
    await Promise.all(tasks.slice(0, 10));
    expect(gameDetails.findOne).toHaveBeenCalledTimes(10);
    expect(service.profileAnalysisCapacitySnapshot()).toMatchObject({
      active: 0,
      queued: 0,
    });
  });
});

const USER_ID_FOR_GATE = "u_profile_gate";
