// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { OpponentsService } = require("../src/services/opponents");
const { UsersService } = require("../src/services/users");
const { hmac } = require("../src/util/hash");

const OPPONENT = {
  pulseId: "zulrah-pulse",
  displayName: "Zulrah",
  race: "Zerg",
  opening: "3 Hatch Before Pool",
};

function game(gameId, result, date) {
  return {
    gameId,
    date,
    result,
    myRace: "Zerg",
    myBuild: "Zerg - 3 Hatch Before Pool",
    map: "Old Sun Temple LE",
    durationSec: 460,
    opponent: OPPONENT,
  };
}

describe("resumed replay quarantine", () => {
  let mongo;
  let db;
  let games;
  let opponents;
  let users;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_resumed_replay_quarantine",
    });
    games = new GamesService(db);
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    users = new UsersService(db);
  });

  afterEach(async () => {
    await Promise.all([
      db.games.deleteMany({}),
      db.opponents.deleteMany({}),
      db.users.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("one real loss remains competitive while three fake wins are sticky and user-scoped", async () => {
    await games.upsert(
      "u1",
      {
        ...game("real-loss", "Defeat", "2026-08-08T14:14:12.000Z"),
        myMmr: 4200,
        myMmrSource: "replay",
        myToonHandle: "1-S2-1-267727",
      },
    );
    for (const [id, date] of [
      ["fake-win-1", "2026-08-10T03:55:41.000Z"],
      ["fake-win-2", "2026-08-10T03:56:09.000Z"],
      ["fake-win-3", "2026-08-10T03:57:19.000Z"],
    ]) {
      await games.upsert("u1", game(id, "Victory", date));
    }
    await games.upsert(
      "u2",
      game("fake-win-2", "Victory", "2026-08-10T03:56:09.000Z"),
    );
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: OPPONENT.pulseId,
      revealedName: "Known Zulrah",
      displayNameHash: "existing-name-hash",
      region: "EU",
      mmrFetchedAt: new Date("2026-08-10T04:00:00.000Z"),
      gameCount: 4,
      wins: 3,
      losses: 1,
      firstSeen: new Date("2026-08-08T14:14:12.000Z"),
      lastSeen: new Date("2026-08-10T03:57:19.000Z"),
      openings: { "3 Hatch Before Pool": 4 },
    });
    await db.users.insertOne({
      userId: "u1",
      lastKnownMmr: 4300,
      lastKnownMmrAt: "2026-08-10T03:57:19.000Z",
      lastKnownMmrRegion: "EU",
    });

    const marker = {
      ...game("fake-win-1", "Defeat", "2026-08-10T03:55:41.000Z"),
      map: "marker must not overwrite legacy metadata",
      isResumedFromReplay: true,
      resumedReplayGameIds: ["fake-win-2", "fake-win-3", "unknown-alias"],
    };
    const first = await games.quarantineResumedReplay("u1", marker);
    expect(first).toMatchObject({ created: false, newlyFlaggedExisting: 3 });
    const pendingFlagged = await db.games
      .find({ userId: "u1", isResumedFromReplay: true })
      .toArray();
    expect(pendingFlagged).toHaveLength(3);
    for (const row of pendingFlagged) {
      expect(row).toMatchObject({
        resumedReplayCounterRepairPending: true,
        resumedReplayMmrRepairPending: true,
        resumedReplayMmrRepairToken: expect.any(String),
        resumedReplayBoundaryRepairPending: true,
      });
    }
    expect(await opponents.repairResumedReplayCountersForUser("u1")).toBe(3);
    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(true);

    const flagged = await db.games
      .find({ userId: "u1", isResumedFromReplay: true })
      .sort({ gameId: 1 })
      .toArray();
    expect(flagged.map((row) => row.gameId)).toEqual([
      "fake-win-1",
      "fake-win-2",
      "fake-win-3",
    ]);
    expect(flagged[0]).toMatchObject({
      result: "Victory",
      map: "Old Sun Temple LE",
    });
    for (const row of flagged) {
      expect(row).toMatchObject({
        resumedReplayCounterRepairPending: false,
        resumedReplayMmrRepairPending: false,
        resumedReplayBoundaryRepairPending: false,
      });
      expect(row.resumedReplayMmrRepairToken).toBeUndefined();
    }
    expect(await db.games.findOne({ userId: "u1", gameId: "unknown-alias" }))
      .toBeNull();
    expect(await db.games.findOne({ userId: "u2", gameId: "fake-win-2" }))
      .not.toHaveProperty("isResumedFromReplay");

    expect(await games.stats("u1")).toMatchObject({ total: 1 });
    expect((await games.list("u1")).items.map((row) => row.gameId))
      .toEqual(["real-loss"]);
    const repairedOpponent = await db.opponents.findOne({
      userId: "u1",
      pulseId: OPPONENT.pulseId,
    });
    expect(repairedOpponent).toMatchObject({
      gameCount: 1,
      wins: 0,
      losses: 1,
      revealedName: "Known Zulrah",
      displayNameHash: hmac(Buffer.alloc(32, 1), "Zulrah"),
      region: "EU",
      openings: { "3 Hatch Before Pool": 1 },
    });
    expect(repairedOpponent.mmrFetchedAt.toISOString())
      .toBe("2026-08-10T04:00:00.000Z");
    expect(await db.users.findOne({ userId: "u1" })).toMatchObject({
      lastKnownMmr: 4200,
      lastKnownMmrAt: "2026-08-08T14:14:12.000Z",
      lastKnownMmrRegion: "NA",
    });

    // A normal replay/reclassify upload cannot un-quarantine the row.
    await games.upsert("u1", {
      ...game("fake-win-1", "Victory", "2026-08-10T03:55:41.000Z"),
      isResumedFromReplay: false,
    });
    expect(await db.games.findOne({ userId: "u1", gameId: "fake-win-1" }))
      .toHaveProperty("isResumedFromReplay", true);
    const repeated = await games.quarantineResumedReplay("u1", marker);
    expect(repeated).toMatchObject({
      created: false,
      newlyFlaggedExisting: 0,
    });
    expect(await opponents.repairResumedReplayCountersForUser("u1")).toBe(0);
    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(false);
    expect((await games.stats("u1")).total).toBe(1);
  });

  test("a new audit-only marker never schedules compensating repairs", async () => {
    const marker = {
      ...game("resume-audit-only", "Victory", "2026-08-10T04:00:00.000Z"),
      isResumedFromReplay: true,
      resumedReplayGameIds: ["missing-alias"],
    };

    expect(await games.quarantineResumedReplay("u1", marker)).toMatchObject({
      created: true,
      newlyFlaggedExisting: 0,
    });
    const stored = await db.games.findOne({
      userId: "u1",
      gameId: "resume-audit-only",
    });
    expect(stored).toMatchObject({
      isResumedFromReplay: true,
      resumedReplayCounterRepairPending: false,
      resumedReplayMmrRepairPending: false,
      resumedReplayBoundaryRepairPending: false,
    });
    expect(stored.resumedReplayMmrRepairToken).toBeUndefined();
    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(false);
    expect(await opponents.repairResumedReplayCountersForUser("u1")).toBe(0);
  });

  test("a concurrent old-agent insert is transitioned with durable repair work", async () => {
    const marker = {
      ...game("racing-old-agent", "Victory", "2026-08-10T04:01:00.000Z"),
      isResumedFromReplay: true,
    };
    const updateOne = db.games.updateOne.bind(db.games);
    const raced = jest
      .spyOn(db.games, "updateOne")
      .mockImplementationOnce(async (...args) => {
        // Model an old agent winning the unique-id insert immediately before
        // the quarantine marker's ensure step. The following transition must
        // still recognize this as a formerly competitive row and journal all
        // compensating work.
        await updateOne(
          { userId: "u1", gameId: marker.gameId },
          {
            $setOnInsert: {
              ...game(marker.gameId, "Victory", marker.date),
              userId: "u1",
              date: new Date(marker.date),
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        return updateOne(...args);
      });

    try {
      await expect(
        games.quarantineResumedReplay("u1", marker),
      ).resolves.toMatchObject({ created: false, newlyFlaggedExisting: 1 });
    } finally {
      raced.mockRestore();
    }

    expect(await db.games.findOne({
      userId: "u1",
      gameId: marker.gameId,
    })).toMatchObject({
      isResumedFromReplay: true,
      resumedReplayCounterRepairPending: true,
      resumedReplayMmrRepairPending: true,
      resumedReplayBoundaryRepairPending: true,
    });
  });

  test("MMR repair consumes no-op work, clears stale region, and blocks fake republishing", async () => {
    const realDate = "2026-08-08T14:14:12.000Z";
    const fakeDate = "2026-08-10T03:57:19.000Z";
    await games.upsert("u1", {
      ...game("real-mmr", "Defeat", realDate),
      myMmr: 4200,
      myMmrSource: "replay",
      // No toon handle: the repair must clear the stale region rather than
      // carrying EU forward onto a replacement with unknown provenance.
    });
    await games.upsert("u1", {
      ...game("fake-mmr", "Victory", fakeDate),
      myMmr: 4300,
      myMmrSource: "replay",
    });
    await db.users.insertOne({
      userId: "u1",
      lastKnownMmr: 4300,
      lastKnownMmrAt: fakeDate,
      lastKnownMmrRegion: "EU",
    });
    await games.quarantineResumedReplay("u1", {
      ...game("fake-mmr", "Victory", fakeDate),
      isResumedFromReplay: true,
    });

    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(true);
    const repaired = await db.users.findOne({ userId: "u1" });
    expect(repaired).toMatchObject({
      lastKnownMmr: 4200,
      lastKnownMmrAt: realDate,
    });
    expect(repaired.lastKnownMmrRegion).toBeUndefined();
    expect(await users.patchLastKnownMmr("u1", {
      mmr: 4300,
      capturedAt: fakeDate,
      gameId: "fake-mmr",
      region: "EU",
    })).toBe(false);
    expect(await users.patchLastKnownMmr("u1", {
      mmr: 4300,
      capturedAt: fakeDate,
      region: "EU",
    })).toBe(false);

    // Exact game-id validation permits a legitimate game that happens to
    // share the quarantined row's timestamp; the legacy date-only guard must
    // remain conservative because it cannot disambiguate the source.
    await games.upsert("u1", {
      ...game("same-time-real", "Victory", fakeDate),
      myMmr: 4250,
      myMmrSource: "replay",
    });
    expect(await users.patchLastKnownMmr("u1", {
      mmr: 4250,
      capturedAt: fakeDate,
      gameId: "same-time-real",
      region: "NA",
    })).toBe(true);
    expect(await db.users.findOne({ userId: "u1" })).toMatchObject({
      lastKnownMmr: 4250,
      lastKnownMmrAt: fakeDate,
      lastKnownMmrRegion: "NA",
    });
  });

  test("successful no-op consumes pending MMR work and failures leave it retryable", async () => {
    const fakeDate = "2026-08-10T03:57:19.000Z";
    await games.upsert("u1", game("fake-no-profile", "Victory", fakeDate));
    await games.quarantineResumedReplay("u1", {
      ...game("fake-no-profile", "Victory", fakeDate),
      isResumedFromReplay: true,
    });

    const findProfile = jest
      .spyOn(db.users, "findOne")
      .mockRejectedValueOnce(new Error("temporary profile read failure"));
    await expect(users.repairLastKnownMmrAfterResumedReplay("u1"))
      .rejects.toThrow("temporary profile read failure");
    findProfile.mockRestore();
    expect(await db.games.findOne({ userId: "u1", gameId: "fake-no-profile" }))
      .toMatchObject({ resumedReplayMmrRepairPending: true });

    // No profile exists, so retry is a successful no-op and must durably
    // consume the captured work instead of retrying forever.
    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(false);
    const consumed = await db.games.findOne({
      userId: "u1",
      gameId: "fake-no-profile",
    });
    expect(consumed).toMatchObject({
      resumedReplayMmrRepairPending: false,
      resumedReplayMmrRepairedAt: expect.any(Date),
    });
    expect(consumed.resumedReplayMmrRepairToken).toBeUndefined();
  });

  test("same-id recompute overwrites a corrected opponent strategy", async () => {
    const original = {
      ...game("rorschach-cal", "Victory", "2026-08-12T17:34:56.000Z"),
      myRace: "Protoss",
      myBuild: "PvZ - DT Opener",
      opponent: {
        ...OPPONENT,
        displayName: "Cal",
        strategy: "Zerg - 3 Hatch Before Pool",
      },
    };
    expect(await games.upsert("u1", original)).toBe(true);
    expect(await games.upsert("u1", {
      ...original,
      opponent: {
        ...original.opponent,
        strategy: "Zerg - 3 Base Macro (Hatch First)",
      },
    })).toBe(false);

    expect(await games.get("u1", "rorschach-cal")).toMatchObject({
      myBuild: "PvZ - DT Opener",
      opponent: {
        displayName: "Cal",
        strategy: "Zerg - 3 Base Macro (Hatch First)",
      },
    });
  });
});
