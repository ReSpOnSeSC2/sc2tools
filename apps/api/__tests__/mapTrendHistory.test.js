// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { LIMITS } = require("../src/config/constants");
const firstDate = new Date("2025-01-01T12:00:00Z");
const days = 370;
const maps = 12;
const lastDate = new Date(firstDate.getTime() + (days - 1) * 86400000);

describe("map trend history coverage", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "map_trend_history_test" });
    service = new AggregationsService(db);
    // More daily map rows than the old ascending cap: previously the final
    // five played days disappeared, silently understating the latest form.
    await db.games.insertMany(Array.from({ length: days * maps }, (_, index) => ({
      userId: "u1",
      gameId: `map-history-${index}`,
      map: `Map ${index % maps}`,
      opponent: { race: ["P", "T", "Z", "R", "U"][index % 5] },
      myRace: ["P", "T", "Z", "R", "U"][Math.floor((index % maps) / 5)],
      date: new Date(firstDate.getTime() + Math.floor(index / maps) * 86400000),
      result: Math.floor(index / maps) % 2 === 0 ? "Victory" : "Defeat",
    })));
    await db.games.insertOne({
      userId: "other-user", gameId: "unrelated-ancient-game", map: "Map 0",
      date: new Date("2000-01-01T12:00:00Z"), result: "Victory",
    });
  });

  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });

  test("daily requests widen before the map-row cap can discard recent games", async () => {
    expect(days * maps).toBeGreaterThan(LIMITS.TIMESERIES_MAX_BUCKETS * 12);
    const result = await service.mapTrend("u1", { interval: "day", tz: "UTC" }, {});
    expect(result.interval).toBe("week");
    expect(result.points.reduce((sum, point) => sum + point.total, 0)).toBe(days * maps);
    expect(result.points.reduce((sum, point) => sum + point.wins, 0)).toBe(days * maps / 2);
    expect(result.points.reduce((sum, point) => sum + point.losses, 0)).toBe(days * maps / 2);
    expect(result.points[0].bucket.getTime()).toBeLessThanOrEqual(firstDate.getTime());
    expect(result.points.at(-1).bucket.getTime()).toBeGreaterThan(lastDate.getTime() - 7 * 86400000);
  });

  test("date and map filters retain daily resolution and the newest results", async () => {
    const result = await service.mapTrend("u1", { interval: "day", tz: "UTC" }, {
      since: new Date(lastDate.getTime() - 2 * 86400000),
      map: "Map 0",
    });
    expect(result.interval).toBe("day");
    expect(result.points).toHaveLength(3);
    expect(result.points.map((point) => point.key)).toEqual(["Map 0", "Map 0", "Map 0"]);
    expect(result.points.map((point) => [point.wins, point.losses, point.total]))
      .toEqual([[0, 1, 1], [1, 0, 1], [0, 1, 1]]);
    expect(result.points.at(-1).bucket.toISOString().slice(0, 10)).toBe(lastDate.toISOString().slice(0, 10));
  });

  test.each([false, true])("matchup daily requests retain the complete range (own race=%s)", async (groupByOwnRace) => {
    const result = await service.matchupTimeseries("u1", { interval: "day", tz: "UTC", groupByOwnRace }, {});
    expect(result.interval).toBe("week");
    expect(result.points.reduce((sum, point) => sum + point.total, 0)).toBe(days * maps);
    expect(result.points.reduce((sum, point) => sum + point.wins, 0)).toBe(days * maps / 2);
    expect(result.points.at(-1).bucket.getTime()).toBeGreaterThan(lastDate.getTime() - 7 * 86400000);
    if (groupByOwnRace) expect(result.points.every((point) => point.matchup && point.myRace)).toBe(true);
    const recent = await service.matchupTimeseries("u1", { interval: "day", tz: "UTC", groupByOwnRace }, { since: lastDate });
    expect(recent.interval).toBe("day");
    expect(recent.points.reduce((sum, point) => sum + point.total, 0)).toBe(maps);
  });
});
