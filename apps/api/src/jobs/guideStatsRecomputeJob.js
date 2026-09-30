"use strict";

/**
 * Nightly guide_stats rebuild (services/guideStats.js) + ISR revalidation.
 *
 * Schedule: the first check lands ``startDelayMs`` after ``start()``
 * (default 15 min, so the boot-time ladderMeta rebuild finishes first),
 * then one check every CHECK_EVERY_MS (hourly, or the interval if that is
 * shorter). A check runs the recompute only when the last completed run
 * is at least ``interval − 1 h`` old — so a deploy never triggers an
 * extra full rebuild, and a deploy right before the nightly slot delays
 * the run by at most an hour instead of a whole interval.
 *
 * ``runOnce({ force: true })`` (the admin "Recompute now") skips the
 * freshness check but still honours the lock and the kill switch.
 *
 * Safety:
 *   - owner-safe ``jobLocks`` lock (util/jobLock.js) keyed
 *     "guideStatsRecompute"; its lease is extended after every matchup and
 *     a lost lease aborts the run before anything is written;
 *   - in-process single flight: concurrent ``runOnce`` calls share the run;
 *   - kill switch SC2TOOLS_GUIDE_STATS_DISABLED=1 (start and runOnce no-op);
 *   - ``runOnce`` never rejects: failures come back as ``reason: "failed"``
 *     and a warn log (no ids or names in any log line).
 * After a successful run ``revalidate()`` (services/guideRevalidate.js) is
 * awaited fail-soft. server.js starts the job only when GUIDES_ENABLED.
 */

const { buildJobLock } = require("../util/jobLock");
const { PATCH_ERA_RULE } = require("../util/patchEra");

const LOCK_COLLECTION = "jobLocks";
const LOCK_KEY = "guideStatsRecompute";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;
const DEFAULT_INTERVAL_MS = 24 * HOUR_MS;
const MIN_INTERVAL_MS = HOUR_MS;
const DEFAULT_START_DELAY_MS = 15 * MINUTE_MS;
/** A run this much younger than the interval counts as fresh. */
const FRESHNESS_SLACK_MS = HOUR_MS;
/** How often the scheduler checks freshness. */
const CHECK_EVERY_MS = HOUR_MS;
/** Longer than one matchup's aggregations (4 × 2 min budget) plus the examples/write tail. */
const LEASE_MS = 45 * MINUTE_MS;

/**
 * @typedef {object} GuideStatsJobSummary
 * @property {boolean} ran
 * @property {boolean} [ranAsLeader]
 * @property {"disabled"|"fresh"|"lock_held"|"failed"} [reason]
 * @property {import('../services/guideStats').GuideStatsRun} [run]
 * @property {boolean} [revalidated]
 */

/**
 * @typedef {object} GuideStatsJobDeps
 * @property {import('../db/connect').DbContext} db
 * @property {Pick<import('../services/guideStats').GuideStatsService, "recompute"|"readRun">} guideStats
 * @property {import('pino').Logger} logger
 * @property {number} [intervalMs]   default 24 h (env SC2TOOLS_GUIDE_STATS_INTERVAL_SEC), floor 1 h
 * @property {number} [startDelayMs] default 15 min (env SC2TOOLS_GUIDE_STATS_START_DELAY_SEC)
 * @property {() => number} [nowFn]
 * @property {() => Promise<unknown>} [revalidate]
 */

/**
 * @param {string|undefined} raw seconds
 * @returns {number|null} milliseconds, or null when unset/invalid/negative
 */
function parseSecondsMs(raw) {
  if (raw === undefined || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n * SECOND_MS : null;
}

/**
 * @param {GuideStatsJobDeps} deps
 * @returns {{ intervalMs: number, startDelayMs: number, disabled: boolean }}
 */
function readSchedule(deps) {
  const env = process.env;
  const envInterval = parseSecondsMs(env.SC2TOOLS_GUIDE_STATS_INTERVAL_SEC);
  const envDelay = parseSecondsMs(env.SC2TOOLS_GUIDE_STATS_START_DELAY_SEC);
  return {
    intervalMs: Math.max(MIN_INTERVAL_MS, deps.intervalMs || envInterval || DEFAULT_INTERVAL_MS),
    startDelayMs: deps.startDelayMs ?? envDelay ?? DEFAULT_START_DELAY_MS,
    disabled: env.SC2TOOLS_GUIDE_STATS_DISABLED === "1",
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

class GuideStatsRecomputeJob {
  /** @param {GuideStatsJobDeps} deps */
  constructor(deps) {
    if (!deps || !deps.db || !deps.guideStats) {
      throw new Error("buildGuideStatsRecomputeJob: db and guideStats required");
    }
    if (!deps.logger) throw new Error("buildGuideStatsRecomputeJob: logger required");
    this.deps = deps;
    this.schedule = readSchedule(deps);
    this.now = deps.nowFn || Date.now;
    this.logger = deps.logger.child({ component: "guideStats" });
    this.lock = buildJobLock({
      collection: deps.db.db.collection(LOCK_COLLECTION), key: LOCK_KEY, leaseMs: LEASE_MS, now: this.now,
    });
    /** @type {NodeJS.Timeout|null} */
    this.startTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.checkTimer = null;
    /** @type {Promise<GuideStatsJobSummary>|null} */
    this.inflight = null;
  }

  /** Schedule the checks (no-op when already started or disabled). */
  start() {
    if (this.startTimer || this.checkTimer) return;
    if (this.schedule.disabled) {
      this.logger.info("guide_stats_job_disabled");
      return;
    }
    const tick = () => void this.runOnce();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      tick();
      this.checkTimer = setInterval(tick, Math.min(this.schedule.intervalMs, CHECK_EVERY_MS));
      if (typeof this.checkTimer.unref === "function") this.checkTimer.unref();
    }, this.schedule.startDelayMs);
    if (typeof this.startTimer.unref === "function") this.startTimer.unref();
    this.logger.info(
      { intervalMs: this.schedule.intervalMs, startDelayMs: this.schedule.startDelayMs },
      "guide_stats_job_started",
    );
  }

  /** Cancel the schedule and wait for an in-flight run. */
  async stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.startTimer = null;
    this.checkTimer = null;
    if (this.inflight) await this.inflight;
  }

  /**
   * One run (coalesced with an in-flight one). Never rejects.
   *
   * @param {{ force?: boolean }} [opts] ``force`` skips the freshness check
   * @returns {Promise<GuideStatsJobSummary>}
   */
  runOnce(opts = {}) {
    if (this.schedule.disabled) return Promise.resolve({ ran: false, reason: "disabled" });
    if (this.inflight) return this.inflight;
    this.inflight = this._execute(Boolean(opts.force)).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** @returns {boolean} */
  isRunning() {
    return this.inflight !== null;
  }

  /**
   * @param {boolean} force
   * @returns {Promise<GuideStatsJobSummary>}
   */
  async _execute(force) {
    try {
      if (!force && (await this._isFresh())) return { ran: false, reason: "fresh" };
      return await this._runAsLeader(force);
    } catch (err) {
      this.logger.warn({ err: errMessage(err) }, "guide_stats_job_failed");
      return { ran: false, reason: "failed" };
    }
  }

  /**
   * @returns {Promise<boolean>} the last run is younger than interval − slack
   *   and was computed under the current era rule (util/patchEra.js), so a
   *   deploy that changes the rule recomputes on the next check
   */
  async _isFresh() {
    const run = await this.deps.guideStats.readRun();
    if (!run || run.eraRule !== PATCH_ERA_RULE) return false;
    return this.now() - run.computedAt.getTime() < this.schedule.intervalMs - FRESHNESS_SLACK_MS;
  }

  /**
   * @param {boolean} force skip the (re-)check of freshness under the lock
   * @returns {Promise<GuideStatsJobSummary>}
   */
  async _runAsLeader(force) {
    const warn = (/** @type {string} */ msg) => (/** @type {unknown} */ err) => {
      this.logger.warn({ err: errMessage(err) }, msg);
    };
    await this.lock.ensureIndexes().catch(warn("guide_stats_lock_index_failed"));
    const owner = await this.lock.acquire();
    if (!owner) return { ran: false, ranAsLeader: false, reason: "lock_held" };
    let run;
    try {
      // Another replica may have finished a run between the unlocked
      // freshness check and this lock: re-check so it is not repeated.
      if (!force && (await this._isFresh())) return { ran: false, reason: "fresh" };
      run = await this.deps.guideStats.recompute({
        onProgress: async () => {
          if (!(await this.lock.extend(owner))) throw new Error("guide_stats_lock_lost");
        },
      });
    } finally {
      await this.lock.release(owner).catch(warn("guide_stats_lock_release_failed"));
    }
    const revalidated = await this._revalidate();
    this.logger.info({ durationMs: run.durationMs, counts: run.counts, revalidated }, "guide_stats_job_ran");
    return { ran: true, ranAsLeader: true, run, revalidated };
  }

  /** @returns {Promise<boolean>} true when the web app accepted the purge */
  async _revalidate() {
    if (!this.deps.revalidate) return false;
    try {
      const res = /** @type {{ok?: boolean}|null} */ (await this.deps.revalidate());
      return Boolean(res && res.ok);
    } catch (err) {
      this.logger.warn({ err: errMessage(err) }, "guide_stats_revalidate_failed");
      return false;
    }
  }
}

/**
 * Example:
 *   const job = buildGuideStatsRecomputeJob({ db, guideStats, logger, revalidate });
 *   if (config.guidesEnabled) job.start();
 *   await job.runOnce({ force: true }); // admin "Recompute now"
 *
 * @param {GuideStatsJobDeps} deps
 * @returns {{
 *   start: () => void,
 *   stop: () => Promise<void>,
 *   runOnce: (opts?: { force?: boolean }) => Promise<GuideStatsJobSummary>,
 *   isRunning: () => boolean,
 * }}
 */
function buildGuideStatsRecomputeJob(deps) {
  const job = new GuideStatsRecomputeJob(deps);
  return {
    start: () => job.start(),
    stop: () => job.stop(),
    runOnce: (opts) => job.runOnce(opts),
    isRunning: () => job.isRunning(),
  };
}

module.exports = {
  GuideStatsRecomputeJob,
  buildGuideStatsRecomputeJob,
  __internal: {
    LOCK_KEY, LEASE_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, DEFAULT_START_DELAY_MS, FRESHNESS_SLACK_MS,
    CHECK_EVERY_MS, parseSecondsMs,
  },
};
