// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { MmrExpectationService, COLLECTION_NAME, DOCUMENT_ID, MAX_TIME_MS } = require("../src/services/mmrExpectation");
const { expectedWin } = require("../src/services/mmrExpectationMath");
let mongo, client, db, service;
const game = (extra = {}) => ({ userId: "private-owner", gameId: "private-replay", isLadderGame: true, matchFormat: "1v1", playerCount: 2, myRace: "Protoss", opponent: { race: "Zerg", mmr: 4200, mmrSource: "replay" }, myMmr: 4000, myMmrSource: "replay", result: "Victory", ...extra });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db("expectation");
});
beforeEach(async () => { await db.dropDatabase(); service = new MmrExpectationService({ games: db.collection("games"), db }); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });

describe("bounded replay-only corpus calibration", () => {
  test("uses actual stored outcomes, strict provenance and integer rating bounds", async () => {
    const good = [game(), game({ result: "Defeat" }), game({ result: "WIN", matchFormat: null }), game({ result: "loss", playerCount: undefined })];
    const bad = [game({ myMmrSource: "unavailable" }), game({ myMmrSource: undefined }), game({ myMmr: 4 }), game({ myMmr: 4000.1 }), game({ opponent: { race: "Zerg", mmr: 4200, mmrSource: "pulse" } }), game({ opponent: { race: "Zerg", mmr: 0, mmrSource: "replay" } }), game({ opponent: { race: "Computer", mmr: 4200, mmrSource: "replay" } }), game({ playerCount: 4 }), game({ matchFormat: "2v2" }), game({ isLadderGame: false }), game({ isResumedFromReplay: true }), game({ result: "Tie" })];
    await db.collection("games").insertMany([...good, ...bad]);
    const spy = jest.spyOn(service.games, "aggregate");
    const run = await service.recompute();
    expect(run).toMatchObject({ sampleGames: 0, supportedBins: 0, method: "elo" });
    const rows = await service.games.aggregate(spy.mock.calls[0][0]).toArray();
    expect(rows).toEqual([{ bin: 32, n: 4, wins: 2 }]);
    expect(spy.mock.calls[0][1]).toEqual({ maxTimeMS: MAX_TIME_MS });
  });

  test("200-game floor, strict tails, deterministic repeat and aggregate-only storage", async () => {
    const corpus = Array.from({ length: 200 }, (_, i) => game({ result: i < 80 ? "Victory" : "Defeat" }));
    corpus.push(...Array.from({ length: 400 }, () => game({ opponent: { race: "Terran", mmr: 4601, mmrSource: "replay" } })));
    await db.collection("games").insertMany(corpus);
    const run = await service.recompute();
    expect(run).toMatchObject({ sampleGames: 200, supportedBins: 1, method: "calibrated" });
    const first = await service.readRun(); await service.recompute(); const second = await service.readRun();
    expect(second.anchors).toEqual(first.anchors);
    expect(await db.collection(COLLECTION_NAME).countDocuments()).toBe(1);
    expect(first._id).toBe(DOCUMENT_ID);
    expect(JSON.stringify(first)).not.toMatch(/private-owner|private-replay|userId|gameId|opponent|4200|4000/);
    expect(expectedWin(200, await service.curve())).toBeLessThan(.5);
  });
});

describe("calibration publication and read fallback", () => {
  test("lost lease never replaces a complete previous aggregate", async () => {
    await service.recompute(); const before = await service.readRun();
    await expect(service.recompute({ beforePublish: async () => { throw new Error("lost lease"); } })).rejects.toThrow("lost lease");
    expect(await service.readRun()).toEqual(before);
  });

  test("empty corpus replaces vanished calibration and uses fallback", async () => {
    await db.collection("games").insertMany(Array.from({ length: 200 }, () => game()));
    await service.recompute(); expect(await service.curve()).not.toBeNull();
    await db.collection("games").deleteMany({}); await service.recompute();
    expect(await service.curve()).toBeNull(); expect((await service.readRun()).sampleGames).toBe(0);
  });

  test("cache coalesces lookups, expires, and never recomputes on read failure", async () => {
    let now = 1000; service.now = () => now;
    const find = jest.spyOn(service.coll, "findOne").mockRejectedValue(new Error("unavailable"));
    const aggregate = jest.spyOn(service.games, "aggregate");
    expect(await Promise.all([service.curve(), service.curve()])).toEqual([null, null]);
    expect(await service.curve()).toBeNull(); expect(find).toHaveBeenCalledTimes(1);
    now += 60_001; await service.curve(); expect(find).toHaveBeenCalledTimes(2); expect(aggregate).not.toHaveBeenCalled();
  });
});
