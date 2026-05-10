// @ts-nocheck
"use strict";

/**
 * Unit test for the duplicate-game audit script. Seeds the games
 * collection with two synthesised duplicate clusters (same physical
 * replay, gameIds that drift on map name and on length_sec) and one
 * legitimate replay, then asserts the aggregations correctly identify
 * the duplicate clusters and quote the right inflation factor.
 *
 * Why test a one-off script
 * -------------------------
 * The query shapes in this script will be re-used by the planned
 * dedupe migration that follows; getting them right here saves a
 * second scrub against production data.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  clusterDuplicates,
  userInflation,
} = require("../scripts/audit-duplicate-games");

describe("audit-duplicate-games", () => {
  let mongo;
  let client;
  let games;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    games = client.db("sc2tools_test_audit").collection("games");
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await games.deleteMany({});
  });

  /**
   * Replay row factory. Produces the slim shape the script reads.
   *
   * @param {object} overrides
   */
  const row = (overrides) => ({
    userId: "u_streamer",
    gameId: "2026-04-01T18:00:00.000Z|CoffeeTime|Goldenaura LE|612",
    date: new Date("2026-04-01T18:00:00.000Z"),
    durationSec: 612,
    map: "Goldenaura LE",
    result: "Victory",
    opponent: {
      pulseId: "1-S2-1-2070609",
      displayName: "CoffeeTime",
      race: "Zerg",
    },
    ...overrides,
  });

  test("clusters games with the same logical key but different gameIds", async () => {
    // Cluster A: 3 rows, same physical replay, gameId varies on map
    // name (drift between "Goldenaura LE" and "Goldenaura").
    await games.insertMany([
      row({
        gameId: "2026-04-01T18:00:00.000Z|CoffeeTime|Goldenaura LE|612",
      }),
      row({
        gameId: "2026-04-01T18:00:00.000Z|CoffeeTime|Goldenaura|612",
      }),
      row({
        gameId: "2026-04-01T18:00:00.000Z|CoffeeTime|Goldenaura LE 2024|612",
      }),
      // Cluster B: 2 rows, gameId varies on length_sec (frame-rate drift).
      row({
        date: new Date("2026-04-02T19:00:00.000Z"),
        durationSec: 720,
        gameId: "2026-04-02T19:00:00.000Z|CoffeeTime|Goldenaura LE|720",
      }),
      row({
        date: new Date("2026-04-02T19:00:00.000Z"),
        durationSec: 720,
        gameId: "2026-04-02T19:00:00.000Z|CoffeeTime|Goldenaura LE|721",
      }),
      // Legitimate row: distinct date, no duplicates.
      row({
        date: new Date("2026-04-03T20:00:00.000Z"),
        gameId: "2026-04-03T20:00:00.000Z|CoffeeTime|Goldenaura LE|612",
        result: "Defeat",
      }),
    ]);

    const clusters = await clusterDuplicates(games, "u_streamer");
    // The legitimate row is its own cluster of size 1, filtered out
    // by the ``count > 1`` match. Two clusters remain.
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((c) => c.count).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 2]);
    // Each surviving cluster must carry distinct gameIds — proves the
    // gameId-drift detection works rather than the aggregation just
    // collapsing identical rows.
    for (const c of clusters) {
      expect(new Set(c.gameIds).size).toBe(c.count);
    }
  });

  test("userInflation surfaces only users with redundant rows", async () => {
    // Two users:
    //   u_dupes: 4 rows / 2 logical (inflation 2.0x)
    //   u_clean: 2 rows / 2 logical (inflation 1.0x — should NOT surface)
    await games.insertMany([
      row({ userId: "u_dupes" }),
      row({
        userId: "u_dupes",
        gameId: "2026-04-01T18:00:00.000Z|CoffeeTime|Goldenaura|612",
      }),
      row({
        userId: "u_dupes",
        date: new Date("2026-04-02T19:00:00.000Z"),
        gameId: "2026-04-02T19:00:00.000Z|CoffeeTime|Goldenaura LE|612",
      }),
      row({
        userId: "u_dupes",
        date: new Date("2026-04-02T19:00:00.000Z"),
        gameId: "2026-04-02T19:00:00.000Z|CoffeeTime|Goldenaura|612",
      }),
      row({ userId: "u_clean" }),
      row({
        userId: "u_clean",
        date: new Date("2026-04-04T18:00:00.000Z"),
        gameId: "2026-04-04T18:00:00.000Z|CoffeeTime|Goldenaura LE|612",
      }),
    ]);

    const inflation = await userInflation(games);
    expect(inflation).toHaveLength(1);
    const r = inflation[0];
    expect(r.userId).toBe("u_dupes");
    expect(r.rows).toBe(4);
    expect(r.logical).toBe(2);
    expect(r.dupClusters).toBe(2);
    expect(r.inflation).toBeCloseTo(2.0, 5);
  });
});
