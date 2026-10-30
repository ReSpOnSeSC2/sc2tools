// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");

describe.each([false, true])("opponent list recorded races, list details=%s", (includeListDetails) => {
  let mongo;
  let db;
  let opponents;
  const pulseId = "1-S2-1-108307";
  const oldDate = new Date("2026-10-01T12:00:00Z");
  const latestDate = new Date("2026-10-29T12:00:00Z");

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opp_race_history" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await db.opponents.insertOne({
      userId: "u1", pulseId, toonHandle: pulseId,
      displayNameSample: "Ali", revealedName: "Nina", race: "Zerg",
      gameCount: 2, wins: 1, losses: 1,
      firstSeen: oldDate, lastSeen: latestDate,
    });
  });

  function game(gameId, date, race, extra = {}) {
    return {
      userId: "u1", gameId, date, myRace: "Protoss", result: "Victory",
      myToonHandle: "1-S2-1-100", map: "Ladder LE",
      opponent: { pulseId, toonHandle: pulseId, displayName: "Ali", race },
      ...extra,
    };
  }

  const list = (opts = {}) => opponents.list("u1", { ...opts, includeListDetails });

  test("unfiltered list repairs a stale race and shows both races for one account", async () => {
    // Backfills can insert old games after the newest one.
    await db.games.insertMany([
      game("latest", latestDate, "Protoss"),
      game("old", oldDate, "Zerg"),
    ]);
    const storedBefore = await db.opponents.findOne({ userId: "u1", pulseId });

    const { items } = await list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ race: "P", races: ["P", "Z"], gameCount: 2 });
    // Read repair must not change counters, stored dates, or persisted metadata.
    expect(await db.opponents.findOne({ userId: "u1", pulseId })).toEqual(storedBefore);
  });

  test.each([false, true])("filtered latest race follows game dates, reversed insertion=%s", async (reverse) => {
    const games = [game("old", oldDate, "Zerg"), game("latest", latestDate, "Protoss")];
    await db.games.insertMany(reverse ? games.reverse() : games);

    const { items } = await list({ filters: { since: oldDate } });

    expect(items[0]).toMatchObject({ race: "P", races: ["P", "Z"], gameCount: 2 });
    expect(items[0].lastPlayed).toEqual(latestDate);
  });

  test.each([
    { until: new Date("2026-10-10") },
    { oppRace: "Z" },
    { map: "older" },
    { accounts: ["1-S2-1-100"] },
  ])("filtered race history contains only qualifying games: %j", async (filters) => {
    await db.games.insertMany([
      game("old", oldDate, "Zerg", { map: "Older LE" }),
      game("latest", latestDate, "Protoss", { myToonHandle: "1-S2-1-200" }),
    ]);

    const { items } = await list({ filters });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ race: "Z", races: ["Z"], gameCount: 1 });
  });

  test.each([{}, { since: oldDate }])("race history respects ownership and game visibility: %j", async (filters) => {
    const hiddenDate = new Date("2026-10-30T12:00:00Z");
    await db.games.insertMany([
      game("old", oldDate, "Zerg"),
      game("latest", latestDate, "Protoss"),
      game("other-owner", hiddenDate, "Terran", { userId: "u2" }),
      game("hidden", hiddenDate, "Terran", { excluded: true }),
      game("deleted", hiddenDate, "Terran", { _deleted: true }),
      game("pending-deletion", hiddenDate, "Terran", { _deletionPending: true }),
      game("resumed", hiddenDate, "Terran", { isResumedFromReplay: true }),
    ]);

    const { items } = await list({ filters });

    expect(items[0]).toMatchObject({ race: "P", races: ["P", "Z"] });
  });

  test.each([{}, { since: oldDate }])("normalizes race spellings and safely ignores malformed history: %j", async (filters) => {
    await db.games.insertMany([
      ...["Z", "zerg", " zerg ", "p", "PROTOSS", "random", "R", null, 17, {}, "Unknown"]
        .map((race, index) => game(`history-${index}`, oldDate, race)),
      game("latest", latestDate, "Protoss"),
    ]);

    const { items } = await list({ filters });

    expect(items[0]).toMatchObject({ race: "P", races: ["P", "Z", "R"] });
  });

  test("unfiltered race repair preserves the stored pagination cursor", async () => {
    await db.games.insertOne(game("latest", new Date("2026-10-30"), "Protoss"));
    await db.opponents.insertOne({
      userId: "u1", pulseId: "1-S2-1-2", race: "Terran",
      lastSeen: oldDate, gameCount: 1, wins: 1, losses: 0,
    });

    const out = await list({ limit: 1 });

    expect(out.nextBefore).toEqual(latestDate);
    expect(out.items[0].lastPlayed).toEqual(new Date("2026-10-30"));
    expect(out.items[0]).toMatchObject({ race: "P", races: ["P"] });
  });

  test("legacy opponents without game history retain their known race", async () => {
    const { items } = await list();
    expect(items[0].race).toBe("Zerg");
  });
});
