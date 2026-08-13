// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { hmac } = require("../src/util/hash");

const TEST_PEPPER = Buffer.alloc(32, 1);

describe("resumed-replay opponent boundary repair", () => {
  let mongo;
  let db;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_resumed_replay_boundary_repair",
    });
    opponents = new OpponentsService(db, TEST_PEPPER);
  });

  afterEach(async () => {
    await Promise.all([
      db.games.deleteMany({}),
      db.opponents.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("retries boundary cleanup without decrementing counters twice", async () => {
    const userId = "u-boundary";
    const pulseId = "zulrah-pulse";
    const realDate = new Date("2026-08-08T14:14:12.000Z");
    const resumedDate = new Date("2026-08-10T03:55:41.000Z");
    const opponent = {
      pulseId,
      displayName: "Zulrah",
      race: "Zerg",
      opening: "3 Hatch Before Pool",
    };

    await db.games.insertMany([
      {
        userId,
        gameId: "real-loss",
        date: realDate,
        result: "Defeat",
        myRace: "Protoss",
        map: "Old Sun Temple LE",
        opponent,
      },
      {
        userId,
        gameId: "resumed-win",
        date: resumedDate,
        result: "Victory",
        myRace: "Protoss",
        map: "Old Sun Temple LE",
        opponent,
        isResumedFromReplay: true,
        resumedReplayCounterRepairPending: true,
        resumedReplayBoundaryRepairPending: true,
      },
    ]);
    await db.opponents.insertOne({
      userId,
      pulseId,
      displayNameSample: "Synthetic Zulrah",
      displayNameHash: "synthetic-name-hash",
      race: "Zerg",
      firstSeen: realDate,
      lastSeen: resumedDate,
      gameCount: 2,
      wins: 1,
      losses: 1,
      openings: { "3 Hatch Before Pool": 2 },
    });

    // Inject a database failure at the first boundary-source lookup. The
    // counter decrement has already committed at this point.
    const findOneSpy = jest
      .spyOn(db.games, "findOne")
      .mockRejectedValueOnce(new Error("injected boundary lookup failure"));
    try {
      await expect(
        opponents.repairResumedReplayCountersForUser(userId),
      ).rejects.toThrow("injected boundary lookup failure");
    } finally {
      findOneSpy.mockRestore();
    }

    expect(await db.opponents.findOne({ userId, pulseId })).toMatchObject({
      gameCount: 1,
      wins: 0,
      losses: 1,
      lastSeen: resumedDate,
      openings: { "3 Hatch Before Pool": 1 },
      _resumeReplayCounterRepairIds: ["resumed-win"],
    });
    expect(await db.games.findOne({ userId, gameId: "resumed-win" }))
      .toMatchObject({
        resumedReplayCounterRepairPending: false,
        resumedReplayBoundaryRepairPending: true,
      });

    // The retry sees only the independent boundary work item. It derives the
    // real boundary, then clears that bit without touching counters again.
    expect(await opponents.repairResumedReplayCountersForUser(userId)).toBe(1);
    expect(await db.opponents.findOne({ userId, pulseId })).toMatchObject({
      displayNameSample: "Zulrah",
      displayNameHash: hmac(TEST_PEPPER, "Zulrah"),
      gameCount: 1,
      wins: 0,
      losses: 1,
      firstSeen: realDate,
      lastSeen: realDate,
      openings: { "3 Hatch Before Pool": 1 },
      _resumeReplayCounterRepairIds: ["resumed-win"],
    });
    expect(await db.games.findOne({ userId, gameId: "resumed-win" }))
      .toMatchObject({
        resumedReplayCounterRepairPending: false,
        resumedReplayBoundaryRepairPending: false,
      });
    expect(await opponents.repairResumedReplayCountersForUser(userId)).toBe(0);

    // Internal retry tokens never escape the ordinary list payload.
    const listed = await opponents.list(userId);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).not.toHaveProperty(
      "_resumeReplayCounterRepairIds",
    );
  });

  test("old-agent re-upload cannot restore quarantined opponent metadata", async () => {
    const userId = "u-reupload";
    const pulseId = "zulrah-pulse";
    const realDate = new Date("2026-08-08T14:14:12.000Z");
    const resumedDate = new Date("2026-08-10T03:55:41.000Z");
    await db.games.insertOne({
      userId,
      gameId: "resumed-win",
      date: resumedDate,
      isResumedFromReplay: true,
      opponent: {
        pulseId,
        displayName: "Synthetic Zulrah",
        race: "Zerg",
      },
    });
    await db.opponents.insertOne({
      userId,
      pulseId,
      displayNameSample: "Zulrah",
      race: "Zerg",
      firstSeen: realDate,
      lastSeen: realDate,
      gameCount: 1,
      wins: 0,
      losses: 1,
      mmr: 4100,
    });

    await expect(opponents.refreshMetadata(userId, {
      gameId: "resumed-win",
      pulseId,
      displayName: "Synthetic Zulrah",
      race: "Zerg",
      mmr: 9999,
      leagueId: 6,
      playedAt: resumedDate,
    })).resolves.toMatchObject({ matched: 0, modified: 0 });

    expect(await db.opponents.findOne({ userId, pulseId })).toMatchObject({
      displayNameSample: "Zulrah",
      lastSeen: realDate,
      gameCount: 1,
      wins: 0,
      losses: 1,
      mmr: 4100,
    });
  });
});
