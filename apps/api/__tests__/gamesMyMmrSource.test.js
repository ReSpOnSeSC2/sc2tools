// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");

function game(overrides = {}) {
  return {
    gameId: "g1",
    date: "2026-04-01T12:00:00.000Z",
    result: "Victory",
    myRace: "Protoss",
    map: "Site Delta",
    ...overrides,
  };
}

let mongo;
let db;
let service;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({
    uri: mongo.getUri(),
    dbName: "sc2tools_test_game_mmr_source",
  });
  service = new GamesService(db);
});

afterEach(async () => {
  await db.games.deleteMany({});
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

describe("GamesService game-time MMR cleanup", () => {
  test("atomically clears an unverified legacy Pulse value", async () => {
    await db.games.insertOne({
      ...game({ myMmr: 5400 }),
      userId: "u1",
      date: new Date("2026-04-01T12:00:00.000Z"),
    });

    await service.upsert("u1", game({ myMmrSource: "unavailable" }));

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBeUndefined();
    expect(stored.myMmrSource).toBe("unavailable");
  });

  test("does not erase a known replay value after a transient miss", async () => {
    await service.upsert(
      "u1",
      game({ myMmr: 5378, myMmrSource: "replay" }),
    );
    await service.upsert(
      "u1",
      game({ result: "Defeat", myMmrSource: "unavailable" }),
    );

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBe(5378);
    expect(stored.myMmrSource).toBe("replay");
    expect(stored.result).toBe("Defeat");
  });
});

describe("GamesService game-time MMR compatibility", () => {
  test("quarantines numeric uploads from older agents without provenance", async () => {
    await service.upsert("u1", game({ myMmr: 5217 }));

    let stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBeUndefined();
    expect(stored.myMmrSource).toBe("unavailable");

    await service.upsert("u1", game({ myMmrSource: "unavailable" }));
    stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBeUndefined();
    expect(stored.myMmrSource).toBe("unavailable");
  });

  test("a legacy numeric upload cannot overwrite a proven replay value", async () => {
    await service.upsert(
      "u1",
      game({ myMmr: 5378, myMmrSource: "replay" }),
    );
    await service.upsert("u1", game({ myMmr: 6000 }));

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBe(5378);
    expect(stored.myMmrSource).toBe("replay");
  });

  test("repeating an unavailable upload stays idempotent", async () => {
    await service.upsert("u1", game({ myMmrSource: "unavailable" }));
    await service.upsert("u1", game({ myMmrSource: "unavailable" }));

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.myMmr).toBeUndefined();
    expect(stored.myMmrSource).toBe("unavailable");
    expect(stored.createdAt).toBeInstanceOf(Date);
  });
});
