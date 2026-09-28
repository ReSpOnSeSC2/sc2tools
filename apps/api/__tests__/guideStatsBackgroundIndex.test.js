// @ts-nocheck
"use strict";

/**
 * The guide_stats games index is built in the BACKGROUND
 * (db/guideIndexes.js): ensureIndexes never waits for it, its outcome is
 * logged (info on success, warn on failure) and recorded on
 * ``ctx.backgroundIndexes``, a failed build neither rejects nor fails boot,
 * and GuideStatsService.recompute waits a bounded time for a build still
 * in progress before it reads or writes anything. Test fixtures only.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect, ensureIndexes } = require("../src/db/connect");
const { BACKGROUND_GAMES_INDEXES, startBackgroundIndexBuilds } = require("../src/db/guideIndexes");
const { GuideStatsService, GAMES_INDEX_BUILDING } = require("../src/services/guideStats");
const { GUIDE_GAMES_INDEX_NAME } = require("../src/services/guideStatsPipelines");
const { NOW_MS, resetDb, cellGames } = require("./helpers/guideStatsSeed");

const GUIDE_INDEX_KEY = { myBuild: 1, "opponent.race": 1 };
const GUIDE_INDEX_FILTER = { myBuild: { $type: "string" } };
/** A wait the tests never reach when the build settles, and a short one they do. */
const LONG_WAIT_MS = 10000;
const SHORT_WAIT_MS = 20;
const RELEASE_AFTER_MS = 10;

function fakeLogger() {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Calls of a logger method with message ``msg``. */
const logged = (fn, msg) => fn.mock.calls.filter(([, m]) => m === msg);

describe("startBackgroundIndexBuilds", () => {
  test("builds exactly the guide games index the pipelines hint on", () => {
    expect(BACKGROUND_GAMES_INDEXES.map((spec) => spec.options.name)).toEqual([GUIDE_GAMES_INDEX_NAME]);
  });

  test("starts the build without waiting, with no client deadline, and logs success at info", async () => {
    const gate = deferred();
    const createIndex = jest.fn(() => gate.promise);
    const logger = fakeLogger();
    const builds = startBackgroundIndexBuilds({ games: { createIndex } }, logger);

    expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("building");
    expect(builds.status("userId_1_date_-1")).toBeNull();
    expect(createIndex).toHaveBeenCalledWith(GUIDE_INDEX_KEY, {
      name: GUIDE_GAMES_INDEX_NAME, partialFilterExpression: GUIDE_INDEX_FILTER, timeoutMS: 0,
    });
    expect(logger.info).not.toHaveBeenCalled();

    gate.resolve(GUIDE_GAMES_INDEX_NAME);
    await builds.settled;
    expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("ready");
    expect(logger.info).toHaveBeenCalledWith(
      { index: GUIDE_GAMES_INDEX_NAME, durationMs: expect.any(Number) },
      "background_index_ready",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a failed build is logged at warn, recorded, and never rejects", async () => {
    const logger = fakeLogger();
    const createIndex = jest.fn(async () => {
      throw new Error("Index build failed: IndexOptionsConflict");
    });
    const builds = startBackgroundIndexBuilds({ games: { createIndex } }, logger);

    await expect(builds.settled).resolves.toBeUndefined();
    expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      { index: GUIDE_GAMES_INDEX_NAME, durationMs: expect.any(Number), err: "Index build failed: IndexOptionsConflict" },
      "background_index_failed",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("runs without a logger", async () => {
    const builds = startBackgroundIndexBuilds({ games: { createIndex: jest.fn(async () => { throw "boom"; }) } }, null);
    await builds.settled;
    expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("failed");
  });
});

/** One mongod for every suite below; each test opens its own database. */
let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
});
afterAll(async () => {
  if (mongo) await mongo.stop();
});

const open = (dbName, opts = {}, observability = {}) =>
  connect({ uri: mongo.getUri(), dbName, ...opts }, observability);
const guideIndex = async (db) => (await db.games.indexes()).find((ix) => ix.name === GUIDE_GAMES_INDEX_NAME);

describe("background guide index: boot never waits for it", () => {
  test("ensureIndexes resolves while the guide build is still running", async () => {
    const db = await open("bg_index_nonblocking", { awaitBackgroundIndexes: true });
    try {
      await db.games.dropIndex(GUIDE_GAMES_INDEX_NAME);
      const gate = deferred();
      const realCreate = db.games.createIndex.bind(db.games);
      const spy = jest.spyOn(db.games, "createIndex").mockImplementation(async (key, options) => {
        if (options && options.name === GUIDE_GAMES_INDEX_NAME) await gate.promise;
        return realCreate(key, options);
      });

      const builds = await ensureIndexes(db);
      expect(db.backgroundIndexes).toBe(builds);
      expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("building");
      expect(await guideIndex(db)).toBeUndefined();
      // Every awaited index is already in place.
      expect((await db.games.indexes()).map((ix) => ix.name)).toContain("userId_1_map_1_date_-1");

      gate.resolve();
      await builds.settled;
      spy.mockRestore();
      expect(builds.status(GUIDE_GAMES_INDEX_NAME)).toBe("ready");
      expect(await guideIndex(db)).toMatchObject({ key: GUIDE_INDEX_KEY, partialFilterExpression: GUIDE_INDEX_FILTER });
    } finally {
      await db.close();
    }
  });

  test("awaitBackgroundIndexes: connect resolves with the index built", async () => {
    const db = await open("bg_index_awaited", { awaitBackgroundIndexes: true });
    try {
      expect(db.backgroundIndexes.status(GUIDE_GAMES_INDEX_NAME)).toBe("ready");
      expect(await guideIndex(db)).toMatchObject({ key: GUIDE_INDEX_KEY, partialFilterExpression: GUIDE_INDEX_FILTER });
    } finally {
      await db.close();
    }
  });

});

describe("background guide index: outcome logging", () => {
  test("default connect reports the finished build at info", async () => {
    const logger = fakeLogger();
    const db = await open("bg_index_default", {}, { logger });
    try {
      await db.backgroundIndexes.settled;
      expect(db.backgroundIndexes.status(GUIDE_GAMES_INDEX_NAME)).toBe("ready");
      expect(logged(logger.info, "background_index_ready")).toEqual([
        [{ index: GUIDE_GAMES_INDEX_NAME, durationMs: expect.any(Number) }, "background_index_ready"],
      ]);
      expect(logged(logger.warn, "background_index_failed")).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("a conflicting existing index fails the build at warn without failing boot", async () => {
    const dbName = "bg_index_conflict";
    const first = await open(dbName, { awaitBackgroundIndexes: true });
    await first.games.dropIndex(GUIDE_GAMES_INDEX_NAME);
    await first.games.createIndex({ myBuild: 1 }, { name: GUIDE_GAMES_INDEX_NAME });
    await first.close();

    const logger = fakeLogger();
    const db = await open(dbName, {}, { logger });
    try {
      await db.backgroundIndexes.settled;
      expect(db.backgroundIndexes.status(GUIDE_GAMES_INDEX_NAME)).toBe("failed");
      const [[fields]] = logged(logger.warn, "background_index_failed");
      expect(fields).toEqual({ index: GUIDE_GAMES_INDEX_NAME, durationMs: expect.any(Number), err: expect.any(String) });
      // Boot's awaited indexes are unaffected.
      expect((await db.guideStats.indexes()).map((ix) => ix.name)).toContain("guide_stats_key");
    } finally {
      await db.close();
    }
  });
});

describe("GuideStatsService.recompute and a background-building games index", () => {
  let db;

  beforeAll(async () => {
    db = await open("sc2tools_test_guide_stats_bg_index", { awaitBackgroundIndexes: true });
  });
  beforeEach(async () => {
    await resetDb(db);
    await db.games.insertMany(cellGames({ users: 6, perUser: 20, winsPerUser: 11 }));
  });
  afterAll(async () => {
    if (db) await db.close();
  });

  /** ``db`` whose guide index reports ``state`` until ``settled`` resolves. */
  const withBuild = (state, settled) => ({
    ...db,
    backgroundIndexes: { settled, status: (name) => (name === GUIDE_GAMES_INDEX_NAME ? state : null) },
  });
  const service = (ctx, indexWaitMs) => new GuideStatsService(ctx, { logger: null, now: () => NOW_MS, indexWaitMs });

  test("fails fast, before reading or writing anything, when the build outlasts the wait", async () => {
    const never = new Promise(() => {});
    await expect(service(withBuild("building", never), SHORT_WAIT_MS).recompute()).rejects.toThrow(GAMES_INDEX_BUILDING);
    expect(await db.guideStats.countDocuments({})).toBe(0);
  });

  test("runs as soon as a build in progress finishes inside the wait", async () => {
    const gate = deferred();
    const run = service(withBuild("building", gate.promise), LONG_WAIT_MS).recompute();
    setTimeout(gate.resolve, RELEASE_AFTER_MS);
    const result = await run;
    expect(result.counts.builds).toBeGreaterThan(0);
    expect(await db.guideStats.countDocuments({ kind: "run" })).toBe(1);
  });

  test.each(["ready", "failed"])("a %s build is not waited on", async (state) => {
    const never = new Promise(() => {});
    const result = await service(withBuild(state, never), SHORT_WAIT_MS).recompute();
    expect(result.counts.builds).toBeGreaterThan(0);
  });

  test("a context without background builds (hand-built db) runs as before", async () => {
    const plain = { ...db };
    delete plain.backgroundIndexes;
    const result = await service(plain, SHORT_WAIT_MS).recompute();
    expect(result.counts.builds).toBeGreaterThan(0);
  });
});
