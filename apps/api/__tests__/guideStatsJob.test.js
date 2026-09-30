// @ts-nocheck
"use strict";

/**
 * jobs/guideStatsRecomputeJob.js: owner-safe jobLocks lease (respected,
 * extended per matchup, lost lease aborts), freshness skip vs force,
 * single flight, kill switch, schedule, fail-soft revalidation, and the
 * makeServices wiring (built, never started by buildApp).
 */

const pino = require("pino");
const { buildGuideStatsRecomputeJob, __internal } = require("../src/jobs/guideStatsRecomputeJob");
const { GuideStatsService } = require("../src/services/guideStats");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { NOW_MS, startDb, resetDb, cellGames } = require("./helpers/guideStatsSeed");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async () => { throw new Error("invalid"); }),
}));

const HOUR_MS = 60 * 60 * 1000;
const logger = pino({ level: "silent" });
const RUN = Object.freeze({
  computedAt: new Date(NOW_MS), durationMs: 5, counts: { builds: 1, published: 1, counters: 0, maps: 0 }, eraRule: 2,
});

/** A guideStats stand-in: ``readRun`` returns ``last``; ``recompute`` calls onProgress ``progress`` times. */
function fakeStats({ last = null, progress = 1, onRecompute } = {}) {
  return {
    readRun: jest.fn(async () => last),
    recompute: jest.fn(async (opts) => {
      for (let i = 0; i < progress; i += 1) await opts.onProgress();
      if (onRecompute) await onRecompute(opts);
      return RUN;
    }),
  };
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

describe("guide stats recompute job", () => {
  let mongo; let db;
  const locks = () => db.db.collection("jobLocks");
  const build = (deps) => buildGuideStatsRecomputeJob({ db, logger, nowFn: () => NOW_MS, ...deps });

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_stats_job"));
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("does not run while another owner holds the lock, and leaves that lock alone", async () => {
    await locks().insertOne({ key: __internal.LOCK_KEY, owner: "other", expiresAt: new Date(NOW_MS + HOUR_MS) });
    const guideStats = fakeStats();
    const revalidate = jest.fn();
    const summary = await build({ guideStats, revalidate }).runOnce({ force: true });
    expect(summary).toEqual({ ran: false, ranAsLeader: false, reason: "lock_held" });
    expect(guideStats.recompute).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(await locks().findOne({ key: __internal.LOCK_KEY })).toMatchObject({ owner: "other" });
  });

  test("runs as leader: extends the lease per matchup, releases the lock, then revalidates", async () => {
    let leaseSeen = null;
    const guideStats = fakeStats({
      progress: 3,
      onRecompute: async () => { leaseSeen = await locks().findOne({ key: __internal.LOCK_KEY }); },
    });
    const revalidate = jest.fn(async () => ({ ok: true, status: 200 }));
    const summary = await build({ guideStats, revalidate }).runOnce();
    expect(summary).toEqual({ ran: true, ranAsLeader: true, run: RUN, revalidated: true });
    expect(leaseSeen.expiresAt).toEqual(new Date(NOW_MS + __internal.LEASE_MS));
    expect(await locks().countDocuments({ key: __internal.LOCK_KEY })).toBe(0);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  test("an expired lock is reclaimed", async () => {
    await locks().insertOne({ key: __internal.LOCK_KEY, owner: "crashed", expiresAt: new Date(NOW_MS - 1) });
    const summary = await build({ guideStats: fakeStats() }).runOnce({ force: true });
    expect(summary.ran).toBe(true);
  });

  test("a lost lease aborts the run: no revalidation, the new owner's lock survives", async () => {
    const guideStats = fakeStats({ progress: 0 });
    guideStats.recompute.mockImplementation(async (opts) => {
      await locks().updateOne({ key: __internal.LOCK_KEY }, { $set: { owner: "thief" } });
      await opts.onProgress();
      return RUN;
    });
    const revalidate = jest.fn();
    const summary = await build({ guideStats, revalidate }).runOnce({ force: true });
    expect(summary).toEqual({ ran: false, reason: "failed" });
    expect(revalidate).not.toHaveBeenCalled();
    expect(await locks().findOne({ key: __internal.LOCK_KEY })).toMatchObject({ owner: "thief" });
  });

  test("skips while the last run is younger than interval − 1 h unless forced", async () => {
    const fresh = fakeStats({ last: { ...RUN, computedAt: new Date(NOW_MS - 2 * HOUR_MS) } });
    expect(await build({ guideStats: fresh }).runOnce()).toEqual({ ran: false, reason: "fresh" });
    expect(fresh.recompute).not.toHaveBeenCalled();
    expect((await build({ guideStats: fresh }).runOnce({ force: true })).ran).toBe(true);

    const due = fakeStats({ last: { ...RUN, computedAt: new Date(NOW_MS - 23 * HOUR_MS) } });
    expect((await build({ guideStats: due }).runOnce()).ran).toBe(true);

    // The interval floor is 1 h, so a 1 s interval can never be "fresh".
    const floor = fakeStats({ last: { ...RUN, computedAt: new Date(NOW_MS - 1000) } });
    expect((await build({ guideStats: floor, intervalMs: 1000 }).runOnce()).ran).toBe(true);

    // A run under an older era rule (util/patchEra.js) is never fresh: the
    // first check after a rule change recomputes.
    for (const eraRule of [1, null]) {
      const oldRule = fakeStats({ last: { ...RUN, computedAt: new Date(NOW_MS - 2 * HOUR_MS), eraRule } });
      expect((await build({ guideStats: oldRule }).runOnce()).ran).toBe(true);
    }
  });

  test("re-checks freshness under the lock: a run another replica just finished is not repeated", async () => {
    const guideStats = fakeStats();
    guideStats.readRun
      .mockResolvedValueOnce({ ...RUN, computedAt: new Date(NOW_MS - 30 * HOUR_MS) })
      .mockResolvedValueOnce({ ...RUN, computedAt: new Date(NOW_MS - 1000) });
    const revalidate = jest.fn();
    expect(await build({ guideStats, revalidate }).runOnce()).toEqual({ ran: false, reason: "fresh" });
    expect(guideStats.readRun).toHaveBeenCalledTimes(2);
    expect(guideStats.recompute).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(await locks().countDocuments({ key: __internal.LOCK_KEY })).toBe(0);
  });

  test("concurrent runOnce calls share one run; recompute failures resolve as reason 'failed'", async () => {
    const guideStats = fakeStats();
    const job = build({ guideStats });
    const [a, b] = await Promise.all([job.runOnce({ force: true }), job.runOnce({ force: true })]);
    expect(a).toBe(b);
    expect(guideStats.recompute).toHaveBeenCalledTimes(1);
    expect(job.isRunning()).toBe(false);

    guideStats.recompute.mockRejectedValueOnce(new Error("boom"));
    expect(await job.runOnce({ force: true })).toEqual({ ran: false, reason: "failed" });
    expect(await locks().countDocuments({ key: __internal.LOCK_KEY })).toBe(0);
  });

  test("a failing revalidation never fails the run", async () => {
    const revalidate = jest.fn(async () => { throw new Error("web down"); });
    const summary = await build({ guideStats: fakeStats(), revalidate }).runOnce({ force: true });
    expect(summary).toMatchObject({ ran: true, revalidated: false });
  });

  test("SC2TOOLS_GUIDE_STATS_DISABLED=1: start() schedules nothing and runOnce is a no-op", async () => {
    await withEnv("SC2TOOLS_GUIDE_STATS_DISABLED", "1", async () => {
      const guideStats = fakeStats();
      const job = build({ guideStats, startDelayMs: 0 });
      job.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await job.runOnce({ force: true })).toEqual({ ran: false, reason: "disabled" });
      await job.stop();
      expect(guideStats.recompute).not.toHaveBeenCalled();
    });
  });

  test("start() runs the first check after startDelayMs; stop() cancels the schedule", async () => {
    const guideStats = fakeStats();
    const job = build({ guideStats, startDelayMs: 10 });
    job.start();
    job.start();
    expect(guideStats.recompute).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await job.stop();
    expect(guideStats.recompute).toHaveBeenCalledTimes(1);
    expect(__internal.parseSecondsMs("900")).toBe(900000);
    expect(__internal.parseSecondsMs("0")).toBe(0);
    expect(__internal.parseSecondsMs("-5")).toBeNull();
    expect(__internal.parseSecondsMs(undefined)).toBeNull();
  });

  test("with the real service: a forced run writes the run doc", async () => {
    await db.games.insertMany(cellGames({ users: 6, perUser: 20, winsPerUser: 10, userPrefix: "j" }));
    const guideStats = new GuideStatsService(db, { logger: null, now: () => NOW_MS });
    const summary = await build({ guideStats }).runOnce({ force: true });
    expect(summary).toMatchObject({ ran: true, revalidated: false, run: { counts: { published: 1 } } });
    expect(await guideStats.readRun()).toMatchObject({ computedAt: new Date(NOW_MS) });
    expect(await build({ guideStats }).runOnce()).toEqual({ ran: false, reason: "fresh" });
  });
});

describe("makeServices wiring", () => {
  test("buildApp builds guideStats + guideStatsJob and never starts the job", async () => {
    const { mongo, db } = await startDb("sc2tools_test_guide_stats_wiring");
    try {
      const { services } = buildApp({
        db, logger,
        config: {
          port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "sc2tools_test_guide_stats_wiring",
          clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [],
          rateLimitPerMinute: 5000, agentReleaseAdminToken: "admin", pythonExe: null,
          pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [],
        },
        pulseMmr: new PulseMmrService({ fetchImpl: async () => { throw new Error("network_disabled_in_tests"); } }),
      });
      expect(services.guideStats).toBeInstanceOf(GuideStatsService);
      expect(typeof services.guideStatsJob.runOnce).toBe("function");
      expect(services.guideStatsJob.isRunning()).toBe(false);
      await services.guideStatsJob.stop();
      await services.customBuilds.stopReclassifications();
    } finally {
      await db.close();
      await mongo.stop();
    }
  });
});
