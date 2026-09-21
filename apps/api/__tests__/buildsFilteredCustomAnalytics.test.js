// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { BuildsService } = require("../src/services/builds");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { parseFilters } = require("../src/util/parseQuery");

const USER = "filtered-library-owner";
const CUSTOM_NAME = "My gateway opener";
const STANDARD_NAME = "Standard opener";
const LAST_SLUG = "saved-136";
const DATE = new Date("2026-09-20T12:00:00Z");
const OPPONENT = { displayName: "Opponent", race: "Terran", strategy: "Standard strategy", region: "NA" };

function replay(gameId, overrides = {}) {
  return {
    userId: USER, gameId, date: DATE, myRace: "Protoss", myBuild: STANDARD_NAME,
    result: "Victory", map: "Site Delta", durationSec: 600, macroScore: 80,
    isLadderGame: true, matchFormat: "1v1", opponent: OPPONENT,
    buildLog: ["[0:17] Pylon", "[0:49] Gateway"],
    ...overrides,
  };
}

function savedDefinitions() {
  return Array.from({ length: 137 }, (_, index) => ({
    userId: USER, slug: `saved-${String(index).padStart(3, "0")}`,
    name: index === 136 ? CUSTOM_NAME : `Unplayed definition ${index}`,
    race: "Protoss", vsRace: "Terran", perspective: "you", updatedAt: DATE,
    rules: index === 136
      ? [{ type: "before", name: "BuildPylon", time_lt: 60 }, { type: "before", name: "BuildGateway", time_lt: 90 }]
      : [{ type: "before", name: "BuildStargate", time_lt: 60 }],
  }));
}

async function verifyAccountIsolation(db, customBuilds) {
  const firstUser = "same-build-first-account";
  const secondUser = "same-build-second-account";
  const definition = savedDefinitions()[136];
  await db.customBuilds.insertMany([firstUser, secondUser].map((userId) => ({ ...definition, userId })));
  await db.games.insertMany([
    replay("same-replay-id", { userId: firstUser }),
    replay("second-first-account-game", { userId: firstUser, result: "Defeat" }),
    replay("same-replay-id", {
      userId: secondUser, result: "Defeat", opponent: { ...OPPONENT, region: "EU" },
    }),
  ]);
  await customBuilds.reclassifyAll(firstUser);
  await customBuilds.reclassifyAll(secondUser);
  const builds = new BuildsService(db);
  expect(await builds.list(firstUser, {})).toEqual([
    expect.objectContaining({ name: CUSTOM_NAME, total: 2, wins: 1, losses: 1 }),
  ]);
  expect(await builds.list(secondUser, {})).toEqual([
    expect.objectContaining({ name: CUSTOM_NAME, total: 1, wins: 0, losses: 1 }),
  ]);
  expect(await builds.list(firstUser, { regions: ["EU"] })).toEqual([]);
  expect(await builds.list(secondUser, { regions: ["NA"] })).toEqual([]);
  expect(await builds.detail(firstUser, CUSTOM_NAME, { regions: ["EU"] })).toBeNull();
  expect(await builds.detail(secondUser, CUSTOM_NAME, { regions: ["NA"] })).toBeNull();
}

describe("filtered custom build analytics beyond the first library page", () => {
  let mongo;
  let client;
  let db;
  let customBuilds;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    const database = client.db("filtered_custom_build_analytics");
    db = { games: database.collection("games"), customBuilds: database.collection("custom_builds") };
    customBuilds = new CustomBuildsService(db, { perGame: new PerGameComputeService(db) });
  });

  afterAll(async () => {
    await customBuilds?.stopReclassifications();
    await client?.close();
    await mongo?.stop();
  });

  test("identical saved names and slugs keep each account's games and filters isolated", () => verifyAccountIsolation(db, customBuilds));

  test("a late custom winner shares the standard list and dossier under the full filter intersection", async () => {
    await db.customBuilds.insertMany(savedDefinitions());
    await db.games.insertMany([
      replay("custom-win"), replay("custom-loss", { result: "Defeat" }),
      replay("standard-win", { buildLog: ["[0:00] Probe"] }),
      replay("standard-loss", { buildLog: ["[0:00] Probe"], result: "Defeat" }),
      replay("custom-too-old", { date: new Date("2026-09-01T12:00:00Z") }),
      replay("custom-too-new", { date: new Date("2026-09-22T12:00:00Z") }),
      replay("custom-too-short", { durationSec: 479 }),
      replay("custom-too-long", { durationSec: 840 }),
      replay("custom-unranked", { isLadderGame: false }),
      replay("custom-other-region", { opponent: { ...OPPONENT, region: "EU" } }),
      replay("custom-other-map", { map: "Golden Wall" }),
      replay("custom-team", { matchFormat: "team" }),
    ]);
    await customBuilds.reclassifyAll(USER);
    expect(await db.customBuilds.countDocuments({ userId: USER })).toBe(137);
    expect(await db.games.findOne({ gameId: "custom-win" })).toMatchObject({
      myBuild: CUSTOM_NAME, _customBuildSlug: LAST_SLUG,
    });

    const filters = parseFilters({
      since: "2026-09-15", until: "2026-09-21", race: "P", opp_race: "T",
      regions: "NA", map: "site delta", map_pool: "ladder", game_size: "1v1",
      min_minutes: "8", max_minutes: "14",
    });
    const builds = new BuildsService(db);
    const rows = await builds.list(USER, filters);
    expect(rows.map((row) => row.name).sort()).toEqual([CUSTOM_NAME, STANDARD_NAME].sort());
    for (const row of rows) expect(row).toMatchObject({ total: 2, wins: 1, losses: 1, winRate: 0.5 });

    const custom = await builds.detail(USER, CUSTOM_NAME, filters);
    const standard = await builds.detail(USER, STANDARD_NAME, filters);
    for (const field of ["totals", "byMatchup", "byMap", "byStrategy", "macro"]) {
      expect(custom[field]).toEqual(standard[field]);
    }
    expect(custom.recent.map((game) => game.gameId).sort()).toEqual(["custom-loss", "custom-win"]);
    expect(standard.recent.map((game) => game.gameId).sort()).toEqual(["standard-loss", "standard-win"]);
    expect(await builds.detail(USER, "Unplayed definition 0", filters)).toBeNull();
    expect(await builds.list(USER, { ...filters, regions: ["KR"] })).toEqual([]);
    expect(await builds.detail(USER, CUSTOM_NAME, { ...filters, regions: ["KR"] })).toBeNull();
  });
});
