// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { AggregationsService } = require("../src/services/aggregations");

describe("mechanics measurements in the existing timeseries", () => {
  let mongo, client, games, service;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    games = client.db("mechanics_timeseries").collection("games");
    service = new AggregationsService({ games });
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => { await games.deleteMany({}); });
  const row = (id, day, fields = {}) => ({ userId: "owner", gameId: id, date: new Date(`2026-10-${day}T12:00:00Z`), result: "Victory", ...fields });

  test("each metric averages and counts only its measured games, preserving a real zero", async () => {
    await games.insertMany([
      row("a", "01", { macroScore: 0, apm: 100, spq: 50 }),
      row("b", "01", { macroScore: 80, apm: 200, spq: null }),
      row("c", "01", { macroScore: null, apm: 0, spq: 70 }),
      row("legacy", "01", { apm: "300", spq: "90" }),
      row("other", "01", { userId: "other", macroScore: 100, apm: 900, spq: 100 }),
      row("missing", "02"),
    ]);
    const output = await service.timeseries("owner", { interval: "day", tz: "UTC" }, {});
    expect(output.points).toHaveLength(2);
    expect(output.points[0]).toMatchObject({ total: 4, avgMacroScore: 40, macroN: 2, avgApm: 100, apmN: 3, avgSpq: 60, spqN: 2 });
    expect(output.points[1]).toMatchObject({ total: 1, avgMacroScore: null, macroN: 0, avgApm: null, apmN: 0, avgSpq: null, spqN: 0 });
  });

  test("calendar and race filters retain their existing cohort and all averages round to one decimal", async () => {
    await games.insertMany([
      row("a", "01", { myRace: "Protoss", macroScore: 70.13, apm: 101.14, spq: 40.25 }),
      row("b", "01", { myRace: "Protoss", macroScore: 71.22, apm: 102.22, spq: 42.27 }),
      row("outside-race", "01", { myRace: "Zerg", macroScore: 100, apm: 1000 }),
      row("outside-date", "04", { myRace: "Protoss", macroScore: 0, apm: 0 }),
    ]);
    const output = await service.timeseries("owner", { interval: "day", tz: "UTC" }, { race: "P", until: new Date("2026-10-03") });
    expect(output.points).toHaveLength(1);
    expect(output.points[0]).toMatchObject({ total: 2, avgMacroScore: 70.7, macroN: 2, avgApm: 101.7, apmN: 2, avgSpq: 41.3, spqN: 2 });
  });
});
