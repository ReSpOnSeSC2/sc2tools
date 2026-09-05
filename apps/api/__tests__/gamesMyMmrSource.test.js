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

describe("GamesService opponent identity signature storage", () => {
  test("re-sync replaces legacy evidence on the same row and preserves server identity", async () => {
    const legacy = { version: 1, windowSec: 600,
      build: { milestones: [{ atSec: 70, name: "Gateway" }] } };
    const rich = { version: 2, windowSec: 600,
      actions: { activeSeconds: 240, events: 42, commands: 20,
        selectionChanges: 10, cameraMoves: 12, queuedCommands: 3,
        repeatCommands: 2, actionIntervals: [5, 5, 5, 6, 10, 10] } };
    expect(await service.upsert("u1", game({ opponent: {
      pulseId: "barcode-target", playSignature: legacy,
      pulseCharacterId: "1234", mmrLookupAttempted: true,
    } }))).toBe(true);
    expect(await service.upsert("u1", game({ opponent: {
      pulseId: "barcode-target", playSignature: rich,
    } }))).toBe(false);
    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.opponent.playSignature).toEqual(rich);
    expect(stored.opponent.pulseCharacterId).toBe("1234");
    expect(stored.opponent.mmrLookupAttempted).toBe(true);
    const { items: [publicRow] } = await service.list("u1", { limit: 10 });
    expect(publicRow.opponent).not.toHaveProperty("playSignature");
    expect(await db.games.countDocuments({ userId: "u1" })).toBe(1);
  });

  test("keeps a bounded private signature on the slim row", async () => {
    await service.upsert(
      "u1",
      game({
        opponent: {
          pulseId: "barcode-target",
          race: "Protoss",
          playSignature: {
            version: 1,
            windowSec: 600,
            controlGroups: {
              events: 31,
              activeSeconds: 600,
              slots: [
                { slot: 2, set: 4, add: 1, recall: 25, doubleTap: 3 },
              ],
              transitions: [{ from: 2, to: 4, count: 6 }],
            },
            build: {
              milestones: [{ atSec: 70, name: "Gateway" }],
            },
          },
        },
      }),
    );

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.opponent.playSignature).toEqual({
      version: 1,
      windowSec: 600,
      controlGroups: {
        events: 31,
        activeSeconds: 600,
        slots: [
          { slot: 2, set: 4, add: 1, recall: 25, doubleTap: 3 },
        ],
        transitions: [{ from: 2, to: 4, count: 6 }],
      },
      build: { milestones: [{ atSec: 70, name: "Gateway" }] },
    });

    const { items: [publicRow] } = await service.list("u1", { limit: 10 });
    expect(publicRow.opponent).not.toHaveProperty("playSignature");
  });

  test("drops malformed signature branches on direct service writes", async () => {
    await service.upsert(
      "u1",
      game({
        opponent: {
          pulseId: "barcode-target",
          race: "Protoss",
          playSignature: {
            version: 99,
            windowSec: 600,
            build: { milestones: [{ atSec: 70, name: "Gateway" }] },
          },
        },
      }),
    );

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.opponent).not.toHaveProperty("playSignature");
  });
});

describe("GamesService server-owned replay archive marker", () => {
  test("agent game upserts cannot forge or erase replayFile", async () => {
    const verified = {
      version: 1,
      sizeBytes: 12345,
      sha256: "b".repeat(64),
      storedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const uploadIntent = {
      version: 1,
      uploadIdHash: "intent-hash",
      state: "prepared",
      expiresAt: new Date("2026-08-01T00:10:00.000Z"),
    };
    await db.games.insertOne({
      ...game(),
      userId: "u1",
      date: new Date("2026-04-01T12:00:00.000Z"),
      replayFile: verified,
      replayUpload: uploadIntent,
    });

    await service.upsert(
      "u1",
      game({
        result: "Defeat",
        replayFile: {
          storedAt: new Date("2099-01-01T00:00:00.000Z"),
          sha256: "forged",
        },
        "replayFile.storedAt": new Date("2099-02-01T00:00:00.000Z"),
        replayUpload: { state: "completing" },
        "replayUpload.state": "completing",
      }),
    );

    const stored = await db.games.findOne({ userId: "u1", gameId: "g1" });
    expect(stored.result).toBe("Defeat");
    expect(stored.replayFile).toEqual(verified);
    expect(stored.replayUpload).toEqual(uploadIntent);
  });
});
