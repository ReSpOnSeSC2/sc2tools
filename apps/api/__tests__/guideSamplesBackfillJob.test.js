// @ts-nocheck
"use strict";

/**
 * jobs/guideSamplesBackfillJob.js against mongod: distils game_details
 * history into guide_samples newest-first, throttled (injected sleep),
 * behind an owner-safe jobLocks lock, with a persisted resumable cursor
 * and an env kill switch. Never starts on its own.
 */

const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const { GuideSamplesService, extractSample } = require("../src/services/guideSamples");
const { guideGameHash } = require("../src/util/guideHash");
const { buildGuideSamplesBackfillJob, __internal } = require("../src/jobs/guideSamplesBackfillJob");

const PEPPER = Buffer.alloc(32, 9);
const NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const logger = pino({ level: "silent" });

describe("guide samples backfill job", () => {
  let mongo; let db; let details; let guideSamples;
  const locks = () => db.db.collection("jobLocks");

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_guide_backfill" });
    details = new GameDetailsService(new MongoDetailsStore(db));
    guideSamples = new GuideSamplesService(db, { pepper: PEPPER, logger: null, disabled: false });
  });

  beforeEach(async () => {
    await Promise.all([
      db.games.deleteMany({}), db.gameDetails.deleteMany({}), db.guideSamples.deleteMany({}), locks().deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  /** Seed one game: slim row + heavy detail row, ``daysAgo`` before NOW. */
  async function seed(gameId, daysAgo, overrides = {}) {
    const date = new Date(NOW_MS - daysAgo * DAY_MS);
    const userId = overrides.userId || "u-backfill";
    await db.games.insertOne({
      userId, gameId, date, result: "Victory", myRace: "Protoss", myBuild: "PvZ - Stargate into Glaives",
      map: "Site Delta LE", durationSec: 640, playerCount: 2, isLadderGame: true, gameBuild: 97425,
      opponent: { displayName: "HiddenFoe", race: "Zerg", leagueId: 3, mmr: 3600 },
      ...overrides,
    });
    await details.upsert(userId, gameId, date, {
      buildLog: ["[0:00] Nexus", "[0:18] Pylon", "[1:30] Nexus", `[3:0${daysAgo % 10}] Stargate`],
      macroBreakdown: { unit_timeline: [{ time: 360, my: { Oracle: 1, Adept: 2 } }], stats_events: [] },
    });
  }

  function job(extra = {}) {
    return buildGuideSamplesBackfillJob({
      db, guideSamples, gameDetails: details, logger, nowFn: () => NOW_MS, sleep: jest.fn(async () => {}), ...extra,
    });
  }

  test("never starts on its own; a pass distils eligible games in the window, throttled", async () => {
    await seed("g-1", 1);
    await seed("g-2", 5);
    await seed("g-team", 3, { playerCount: 4 });
    await seed("g-custom", 4, { _customBuildSlug: "mine", myBuild: "Mine" });
    await seed("g-ancient", 200);
    const sleep = jest.fn(async () => {});
    const j = job({ sleep });
    expect(j.status()).toMatchObject({ running: false, processed: 0, startedAt: null });

    const started = j.start({ days: 30 });
    expect(started).toMatchObject({ disabled: false, running: true, days: 30 });
    await j.inflight;

    expect(j.status()).toMatchObject({
      running: false, done: true, processed: 4, written: 2, skipped: 2, failed: 0, lastError: null,
      since: new Date(NOW_MS - 30 * DAY_MS).toISOString(),
    });
    expect(sleep).toHaveBeenCalledTimes(4);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(__internal.GAME_INTERVAL_MS);
    const docs = await db.guideSamples.find({}).sort({ "milestones.Stargate": 1 }).toArray();
    expect(docs.map((d) => d.gameHash)).toEqual([
      guideGameHash(PEPPER, "u-backfill", "g-1"),
      guideGameHash(PEPPER, "u-backfill", "g-2"),
    ]);
    expect(docs[0]).toMatchObject({ milestones: { Pylon: 18, "Nexus#2": 90, Stargate: 181 }, army: { 360: { Adept: 2, Oracle: 1 } } });
    const text = JSON.stringify([docs, j.status()]);
    for (const needle of ["u-backfill", "g-1", "HiddenFoe"]) expect(text).not.toContain(needle);
    // Lock released; a finished pass is marked done so the next start begins fresh.
    expect(await locks().findOne({ key: __internal.LOCK_KEY })).toBeNull();
    expect(await locks().findOne({ key: __internal.CURSOR_KEY })).toMatchObject({ done: true, after: null });
  });

  test("processes newest first and resumes from the persisted cursor after a restart", async () => {
    for (let i = 1; i <= 5; i += 1) await seed(`g-${i}`, i);
    const order = [];
    const spy = jest.spyOn(db.games, "findOne").mockImplementation(async function (filter, opts) {
      if (opts && opts.projection && opts.projection.myBuild) order.push(filter.gameId); // slim reads only
      return jest.requireActual("mongodb").Collection.prototype.findOne.call(this, filter, opts);
    });
    let first;
    let calls = 0;
    const stopAfterTwo = jest.fn(async () => {
      calls += 1;
      if (calls === 2) void first.stop();
    });
    first = job({ sleep: stopAfterTwo });
    first.start({ days: 30 });
    await first.inflight;
    expect(first.status()).toMatchObject({ processed: 2, written: 2, done: false });
    const cursor = await locks().findOne({ key: __internal.CURSOR_KEY });
    expect(cursor).toMatchObject({ done: false });
    expect(cursor.after.date).toEqual(new Date(NOW_MS - 2 * DAY_MS));

    const second = job(); // a fresh process: state comes only from jobLocks
    second.start({ days: 30 });
    await second.inflight;
    spy.mockRestore();
    expect(second.status()).toMatchObject({ processed: 3, written: 3, done: true });
    expect(order).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5"]);
    expect(await db.guideSamples.countDocuments({})).toBe(5);
  });

  test("removes stale samples of games that are gone or no longer guide games", async () => {
    await seed("g-keep", 1);
    await seed("g-relabelled", 2, { _customBuildSlug: "mine", myBuild: "Mine" });
    await seed("g-orphan", 3);
    await db.games.deleteOne({ gameId: "g-orphan" }); // detail row without its slim row
    const stale = extractSample({
      date: new Date(NOW_MS), result: "Victory", myRace: "Protoss", myBuild: "PvZ - Stargate into Glaives",
      map: "Site Delta LE", isLadderGame: true, gameBuild: 97425, opponent: { race: "Zerg" }, buildLog: ["[0:18] Pylon"],
    });
    await guideSamples.writeSample("u-backfill", "g-relabelled", stale);
    await guideSamples.writeSample("u-backfill", "g-orphan", stale);
    await guideSamples.writeSample("u-other", "g-relabelled", stale); // same gameId, another user: untouched
    const j = job();
    j.start({ days: 30 });
    await j.inflight;
    expect(j.status()).toMatchObject({ processed: 3, written: 1, skipped: 2, failed: 0 });
    const hashes = (await db.guideSamples.find({}).toArray()).map((d) => d.gameHash).sort();
    expect(hashes).toEqual([
      guideGameHash(PEPPER, "u-backfill", "g-keep"),
      guideGameHash(PEPPER, "u-other", "g-relabelled"),
    ].sort());
  });

  test("a sample written for a game a GDPR wipe removed mid-flight is taken back out", async () => {
    await seed("g-1", 1);
    const racing = {
      disabled: false,
      removeSample: (...args) => guideSamples.removeSample(...args),
      writeSample: async (...args) => {
        await db.games.deleteMany({ userId: "u-backfill" }); // the wipe lands between read and write
        await db.guideSamples.deleteMany({});
        return guideSamples.writeSample(...args);
      },
    };
    const j = job({ guideSamples: racing });
    j.start({ days: 30 });
    await j.inflight;
    expect(j.status()).toMatchObject({ processed: 1, written: 0, skipped: 1 });
    expect(await db.guideSamples.countDocuments({})).toBe(0);
  });

  test("a stop that interrupts a game leaves the cursor before it, so the resumed pass redoes it", async () => {
    for (let i = 1; i <= 3; i += 1) await seed(`g-${i}`, i);
    let first;
    const interrupting = { findMany: jest.fn(async (userId, ids, opts) => {
      if (ids[0] === "g-2") {
        void first.stop();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return details.findMany(userId, ids, opts);
    }) };
    first = job({ gameDetails: interrupting });
    first.start({ days: 30 });
    await first.inflight;
    expect(first.status()).toMatchObject({ written: 1, failed: 0, done: false });
    const cursor = await locks().findOne({ key: __internal.CURSOR_KEY });
    expect(cursor.after.date).toEqual(new Date(NOW_MS - 1 * DAY_MS)); // still at g-1

    const second = job();
    second.start({ days: 30 });
    await second.inflight;
    expect(second.status()).toMatchObject({ processed: 2, written: 2, done: true });
    expect(await db.guideSamples.countDocuments({})).toBe(3);
  });

  test("respects a lock held by another replica and leaves it alone", async () => {
    await seed("g-1", 1);
    const held = { key: __internal.LOCK_KEY, owner: "other", acquiredAt: new Date(NOW_MS), expiresAt: new Date(NOW_MS + 60_000) };
    await locks().insertOne(held);
    const j = job();
    j.start({ days: 30 });
    await j.inflight;
    expect(j.status()).toMatchObject({ processed: 0, lastError: "lock_held", running: false });
    expect(await db.guideSamples.countDocuments({})).toBe(0);
    expect(await locks().findOne({ key: __internal.LOCK_KEY })).toMatchObject({ owner: "other" });
  });

  test("takes over an expired lock and extends its lease while running", async () => {
    await seed("g-1", 1);
    await locks().insertOne({ key: __internal.LOCK_KEY, owner: "crashed", expiresAt: new Date(NOW_MS - 1) });
    let leaseSeen = null;
    const sleep = jest.fn(async () => {
      leaseSeen = await locks().findOne({ key: __internal.LOCK_KEY });
    });
    const j = job({ sleep });
    j.start({ days: 30 });
    await j.inflight;
    expect(j.status()).toMatchObject({ written: 1, done: true });
    expect(leaseSeen.owner).not.toBe("crashed");
    expect(leaseSeen.expiresAt.getTime()).toBeGreaterThan(NOW_MS);
  });

  test("a failing detail read is counted and the pass continues", async () => {
    await seed("g-1", 1);
    await seed("g-2", 2);
    const failing = { findMany: jest.fn(async (userId, ids) => {
      if (ids[0] === "g-1") throw Object.assign(new Error("r2 down for u-backfill/g-1"), { code: "ECONNRESET" });
      return details.findMany(userId, ids, { fields: ["buildLog", "macroBreakdown"] });
    }) };
    const warn = jest.fn();
    const j = buildGuideSamplesBackfillJob({
      db, guideSamples, gameDetails: failing, nowFn: () => NOW_MS, sleep: async () => {},
      logger: { child: () => ({ info: jest.fn(), warn }) },
    });
    j.start({ days: 30 });
    await j.inflight;
    expect(j.status()).toMatchObject({ processed: 2, written: 1, failed: 1, done: true });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("u-backfill");
  });

  test("kill switch SC2TOOLS_GUIDE_BACKFILL_DISABLED=1 blocks start", async () => {
    await seed("g-1", 1);
    const prev = process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED;
    process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED = "1";
    try {
      const j = job();
      expect(j.start({ days: 30 })).toMatchObject({ disabled: true, running: false });
      expect(j.inflight).toBeNull();
      expect(await db.guideSamples.countDocuments({})).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED;
      else process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED = prev;
    }
  });

  test("the samples kill switch also blocks start", () => {
    const disabledSamples = new GuideSamplesService(db, { pepper: PEPPER, logger: null, disabled: true });
    const j = buildGuideSamplesBackfillJob({ db, guideSamples: disabledSamples, gameDetails: details, logger });
    expect(j.start()).toMatchObject({ disabled: true, running: false });
  });

  test("start while running is a no-op; stop resolves", async () => {
    await seed("g-1", 1);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const j = job({ sleep: () => gate });
    j.start({ days: 30 });
    const again = j.start({ days: 5 });
    expect(again).toMatchObject({ running: true, days: 30 });
    const stopped = j.stop();
    release();
    expect(await stopped).toMatchObject({ running: false });
  });

  test("days are clamped to [1, 400] with a 90-day default", () => {
    expect(__internal.clampDays(undefined)).toBe(90);
    expect(__internal.clampDays(0)).toBe(90);
    expect(__internal.clampDays("30")).toBe(30);
    expect(__internal.clampDays(12.7)).toBe(12);
    expect(__internal.clampDays(5000)).toBe(400);
  });

  test("requires its dependencies", () => {
    expect(() => buildGuideSamplesBackfillJob({ db })).toThrow(/required/);
  });

  test("its lock is the shared util/jobLock under the backfill key, not a private copy", () => {
    // Spy (a wrapper around the real helper): one lock implementation, so a
    // fix to its compare-and-swap reaches every job.
    const real = jest.requireActual("../src/util/jobLock");
    const spy = jest.fn(real.buildJobLock);
    jest.isolateModules(() => {
      jest.doMock("../src/util/jobLock", () => ({ ...real, buildJobLock: spy }));
      const isolated = require("../src/jobs/guideSamplesBackfillJob");
      isolated.buildGuideSamplesBackfillJob({ db, guideSamples, gameDetails: details, logger, nowFn: () => NOW_MS });
    });
    jest.dontMock("../src/util/jobLock");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      collection: expect.anything(), key: __internal.LOCK_KEY, leaseMs: expect.any(Number),
    }));
  });
});
