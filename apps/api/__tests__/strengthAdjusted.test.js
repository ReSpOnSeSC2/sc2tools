// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { AggregationsService } = require("../src/services/aggregations");
const { BuildsService } = require("../src/services/builds");
const { expectationExpression, finishStrength } = require("../src/services/strengthAdjusted");
const { fitCalibration, expectedWin } = require("../src/services/mmrExpectationMath");
let mongo, client, raw, db;
const game = (id, extra = {}) => ({ userId: "owner", gameId: String(id), date: new Date(1_800_000_000_000 + id * 1000), isLadderGame: true, playerCount: 2, matchFormat: "1v1", myRace: "Protoss", myBuild: "Gateway", map: "Abyss", myMmr: 4000, myMmrSource: "replay", result: id % 2 ? "Victory" : "Defeat", opponent: { race: "Zerg", mmr: 4000, mmrSource: "replay", strategy: "Pool" }, ...extra });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); raw = client.db("strength"); db = { games: raw.collection("games") }; });
beforeEach(async () => { await db.games.deleteMany({}); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });

describe("shared strength calculations in the existing aggregation pass", () => {
  test.each(["maps", "matchups", "mapMatchups", "buildVsStrategy", "builds", "strategies"])("%s retains raw counts and publishes paired replay-MMR coverage", async method => {
    await db.games.insertMany([game(1), game(2), game(3, { myMmrSource: undefined }), game(4, { opponent: { race: "Zerg", mmr: 4000, mmrSource: "pulse", strategy: "Pool" } }), game(5, { isLadderGame: false }), game(6, { playerCount: 4, matchFormat: "2v2" }), game(7, { result: "Tie" }), game(8, { userId: "another-owner" }), game(9, { isResumedFromReplay: true })]);
    const aggregations = new AggregationsService(db), builds = new BuildsService(db);
    const rows = method === "builds" ? await builds.list("owner", {}) : method === "strategies" ? await builds.oppStrategies("owner", {}) : await aggregations[method]("owner", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total: 7, wins: 3, losses: 3, ratedGames: 2, ratedWins: 1, expectedWins: 1, winsAboveExpected: 0, perfRating: 4000, excludedNoMmr: 2, excludedIneligible: 3, expectation: { method: "elo", eloScale: 400 } });
    expect(rows[0].winRateRange.low).toBeLessThan(3/7); expect(rows[0].winRateRange.high).toBeGreaterThan(3/7);
    expect(rows[0]._opponentTotal).toBeUndefined();
  });

  test("unknown history does not become a zero expectation, and finite rating does not exist for perfect records", async () => {
    await db.games.insertMany([game(1, { myMmrSource: undefined }), game(2, { myMmrSource: undefined })]);
    const svc = new BuildsService(db);
    expect((await svc.list("owner", {}))[0]).toMatchObject({ expectedWins: null, winsAboveExpected: null, perfRating: null, ratedGames: 0, excludedNoMmr: 2 });
    await db.games.deleteMany({}); await db.games.insertOne(game(1));
    expect((await svc.list("owner", {}))[0]).toMatchObject({ expectedWins: .5, winsAboveExpected: .5, perfRating: null, ratedGames: 1 });
  });
});

describe("same curve in Mongo sums and pure inverse lookup", () => {
  test("calibrated interpolated and tail probabilities match pure expectedWin", async () => {
    const curve = fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]);
    const differences = [-1200, -587.5, -300, -12.5, 0, 12.5, 200, 587.5, 1200];
    await db.games.insertMany(differences.map((difference, i) => game(i, { opponent: { mmr: 4000 + difference } })));
    const rows = await db.games.aggregate([{ $sort: { date: 1 } }, { $project: { p: expectationExpression(curve) } }]).toArray();
    rows.forEach((row, i) => expect(row.p).toBeCloseTo(expectedWin(differences[i], curve), 12));
  });

  test("a valid calibrated curve is used by services, with original evidence counts", async () => {
    const curve = fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]);
    await db.games.insertMany([game(1), game(2, { opponent: { race: "Zerg", mmr: 4200, mmrSource: "replay", strategy: "Pool" } })]);
    const model = { curve: jest.fn().mockResolvedValue(curve) };
    const row = (await new BuildsService(db, { mmrExpectation: model }).list("owner", {}))[0];
    expect(row.expectedWins).toBeCloseTo(.5 + expectedWin(200, curve), 12);
    expect(row.winsAboveExpected).toBeCloseTo(1 - row.expectedWins, 12); expect(row.perfRating).toBeCloseTo(4100, 12);
    expect(row.expectation).toMatchObject({ method: "calibrated", sampleGames: 400, supportedBins: 2 });
  });

  test("empty records expose null Wilson uncertainty", () => {
    expect(finishStrength({ wins: 0, total: 0 }, null)).toMatchObject({ winRateRange: null, ratedWinRateRange: null, perfRating: null, expectedWins: null });
  });
});

describe("bounded last-50 matchup performance", () => {
  test("hidden contributions cannot enter rated metrics/series and do not hide another uploader's copy", async () => {
    await db.games.insertMany([game(1, { excluded: true }), game(2), game(1, { userId: "other-owner" })]);
    const builds = new BuildsService(db), aggregations = new AggregationsService(db);
    expect((await builds.list("owner", {}))[0]).toMatchObject({ ratedGames: 1, ratedWins: 0 });
    expect((await builds.list("other-owner", {}))[0]).toMatchObject({ ratedGames: 1, ratedWins: 1 });
    const response = await aggregations.matchupTimeseries("owner", {}, {});
    expect(response.ratingSeries[0]).toMatchObject({ sampleGames: 1, ratedGames: 1 });
    expect(response.ratingSeries[0].points[0].date).toEqual(game(2).date);
  });

  test("initials and case variants retain paired MMR eligibility in rows and rating series", async () => {
    await db.games.insertMany([game(1, { myRace: "p", opponent: { race: "z", mmr: 4000, mmrSource: "replay", strategy: "Pool" } }), game(2, { myRace: "PROTOSS", opponent: { race: "ZERG", mmr: 4000, mmrSource: "replay", strategy: "Pool" } })]);
    expect((await new BuildsService(db).list("owner", {}))[0]).toMatchObject({ ratedGames: 2, excludedIneligible: 0, expectedWins: 1 });
    const response = await new AggregationsService(db).matchupTimeseries("owner", { groupByOwnRace: true }, {});
    expect(response.ratingSeries).toHaveLength(1); expect(response.ratingSeries[0]).toMatchObject({ matchup: "PvZ", ratedGames: 2, sampleGames: 2, perfRating: 4000 });
  });

  test("same scoped timeseries scan returns each pair's latest50 and explicit missing-MMR coverage", async () => {
    await db.games.insertMany(Array.from({ length: 65 }, (_, i) => game(i, i === 64 ? { myMmrSource: undefined } : {})));
    await db.games.insertMany([game(66, { isLadderGame: false }), game(67, { userId: "another-owner" }), game(68, { myRace: "Terran" })]);
    const spy = jest.spyOn(db.games, "aggregate");
    const response = await new AggregationsService(db).matchupTimeseries("owner", { groupByOwnRace: true }, {});
    expect(response.ratingSeries).toHaveLength(2);
    const p = response.ratingSeries.find(row => row.matchup === "PvZ");
    expect(p).toMatchObject({ totalGames: 65, sampleGames: 50, ratedGames: 49, excludedNoMmr: 1, windowGames: 10 });
    expect(p.points).toHaveLength(50); expect(p.points[0].date).toEqual(game(15).date); expect(p.points.at(-1).date).toEqual(game(64).date);
    expect(p.points[0].perfRating).toBeNull(); expect(p.points[9]).toMatchObject({ games: 10, ratedGames: 10, perfRating: 4000 });
    expect(p.points.at(-1)).toMatchObject({ games: 10, ratedGames: 9, excludedNoMmr: 1 });
    expect(JSON.stringify(response.ratingSeries)).not.toMatch(/another-owner|gameId|userId/);
    const pipelines = spy.mock.calls.map(([pipeline]) => pipeline);
    expect(pipelines.filter(pipeline => pipeline.some(stage => stage.$facet?.ratingSeries))).toHaveLength(1);
    expect(JSON.stringify(pipelines)).toContain('"$topN":{"n":50');
    spy.mockRestore();
  });
});
