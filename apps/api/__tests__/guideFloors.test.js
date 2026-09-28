// @ts-nocheck
"use strict";

/**
 * config/guides.js publish floors: the defaults, the GUIDES_*_MIN_*
 * environment overrides, and a deployment that publishes a single
 * player's build once they have 50 games of it.
 */

const { guideFloors } = require("../src/config/guides");

const FLOOR_ENV = [
  "GUIDES_CELL_MIN_USERS",
  "GUIDES_CELL_MIN_GAMES",
  "GUIDES_PAGE_MIN_USERS",
  "GUIDES_PAGE_MIN_GAMES",
];
const ONE_PLAYER_FIFTY_GAMES = {
  GUIDES_CELL_MIN_USERS: "1",
  GUIDES_PAGE_MIN_USERS: "1",
  GUIDES_PAGE_MIN_GAMES: "50",
};

describe("guideFloors", () => {
  test("defaults: cells 5 players / 30 games, pages 5 players / 100 games", () => {
    expect(guideFloors({})).toEqual({
      cellMinUsers: 5, cellMinGames: 30, pageMinUsers: 5, pageMinGames: 100,
    });
  });

  test("a deployment can publish one player's build from 50 games", () => {
    expect(guideFloors(ONE_PLAYER_FIFTY_GAMES)).toEqual({
      cellMinUsers: 1, cellMinGames: 30, pageMinUsers: 1, pageMinGames: 50,
    });
  });

  test.each(["0", "-3", "2.5", "lots", "", "  ", "1e3", "0x10"])(
    "ignores %p and keeps the default",
    (raw) => {
      const env = Object.fromEntries(FLOOR_ENV.map((name) => [name, raw]));
      expect(guideFloors(env)).toEqual(guideFloors({}));
    },
  );

  test("trims whitespace around a whole number", () => {
    expect(guideFloors({ GUIDES_PAGE_MIN_GAMES: " 60 " }).pageMinGames).toBe(60);
  });

  test("a page floor is never below the matching cell floor", () => {
    expect(guideFloors({ GUIDES_PAGE_MIN_GAMES: "10", GUIDES_PAGE_MIN_USERS: "2" })).toMatchObject({
      pageMinGames: 30, pageMinUsers: 5,
    });
    expect(guideFloors({ GUIDES_CELL_MIN_USERS: "3", GUIDES_PAGE_MIN_USERS: "1" }).pageMinUsers).toBe(3);
  });
});

describe("GuideStatsService with one-player floors", () => {
  let mongo; let db; let seed; let GuideStatsService; const saved = {};

  beforeAll(async () => {
    for (const name of FLOOR_ENV) saved[name] = process.env[name];
    Object.assign(process.env, ONE_PLAYER_FIFTY_GAMES);
    // Fresh modules so every guide module reads the floors set above.
    jest.isolateModules(() => {
      seed = require("./helpers/guideStatsSeed");
      ({ GuideStatsService } = require("../src/services/guideStats"));
    });
    ({ mongo, db } = await seed.startDb("sc2tools_test_guide_floors"));
  });
  beforeEach(async () => {
    await seed.resetDb(db);
  });
  afterAll(async () => {
    for (const name of FLOOR_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const recompute = async () => {
    await new GuideStatsService(db, { logger: null, now: () => seed.NOW_MS }).recompute();
    return seed.statsByKey(db);
  };

  test("one player with 50+ games of a build publishes it; 40 games do not", async () => {
    await db.games.insertMany([
      ...seed.cellGames({ users: 1, perUser: 60, winsPerUser: 33, userPrefix: "solo" }),
      ...seed.cellGames({
        users: 1, perUser: 40, winsPerUser: 20, userPrefix: "short", overrides: { myBuild: seed.PHOENIX },
      }),
    ]);
    const docs = await recompute();

    const glaives = docs.get("build:after:PvZ:stargate-into-glaives");
    expect(glaives.published).toBe(true);
    // Still at most 50 games per player per build.
    expect(glaives.overall).toMatchObject({ games: 50, users: 1 });

    const phoenix = docs.get("build:after:PvZ:2-stargate-phoenix");
    expect(phoenix.published).toBe(false);
    expect(phoenix.overall).toMatchObject({ games: 40, users: 1 });
  });
});
