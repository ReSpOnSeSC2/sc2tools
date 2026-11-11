"use strict";

const { buildJobLock } = require("../util/jobLock");
const { observeJob } = require("../util/jobLedger");

/**
 * Nightly classifier quality recompute (services/classifierQuality.js).
 *
 * Checks hourly and rebuilds once the newest snapshot is a day old, under
 * the shared ``jobLocks`` lease so only one instance scans. "Run now" (the
 * Infrastructure page or the classifier console; job ``classifier-quality``)
 * goes through the same single-flight wrapper with no arguments and always
 * rebuilds; only the scheduled checks skip a snapshot that is still fresh.
 * A missing partial index (first deploy, still building) skips the run; the
 * next hourly check retries.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const START_DELAY_MS = 20 * 60_000;
const LEASE_MS = 10 * 60_000;

/** @typedef {{ran: boolean, reason?: string, checkIns?: number, pairs?: number, suppressedPairs?: number, truncated?: boolean}} Summary */
/**
 * @typedef {{
 *   db: import('../db/connect').DbContext,
 *   classifierQuality: Pick<import('../services/classifierQuality').ClassifierQualityService, 'latest'|'recompute'>,
 *   logger: import('pino').Logger,
 *   jobLedger?: import('../util/jobLedger').JobLedger,
 *   now?: () => number,
 *   startDelayMs?: number,
 * }} Dependencies
 */

class ClassifierQualityJob {
  /** @param {Dependencies} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.delay = deps.startDelayMs ?? START_DELAY_MS;
    this.lock = buildJobLock({ collection: deps.db.db.collection("jobLocks"), key: "classifierQuality", leaseMs: LEASE_MS, now: this.now });
    /** @type {NodeJS.Timeout|null} */ this.startTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.checkTimer = null;
    /** @type {Promise<Summary>|null} */ this.inflight = null;
    this.observedRun = observeJob(deps, "classifier-quality", DAY_MS,
      (/** @type {{scheduled?: boolean}|undefined} */ opts) => this.runWork({ force: !opts?.scheduled }), { firstDelayMs: this.delay });
  }

  start() {
    if (this.startTimer || this.checkTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.runOnce();
      this.checkTimer = setInterval(() => void this.runOnce(), HOUR_MS);
      this.checkTimer.unref?.();
    }, this.delay);
    this.startTimer.unref?.();
  }

  async stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.startTimer = this.checkTimer = null;
    if (this.inflight) await this.inflight;
  }

  /** A scheduled check: rebuilds only a stale snapshot. @returns {Promise<Summary>} */
  runOnce() { return this.observedRun({ scheduled: true }); }

  /** @param {{force?: boolean}} [opts] */
  runWork(opts = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = this.execute(opts).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async fresh() {
    const latest = await this.deps.classifierQuality.latest();
    const stamp = latest?.generatedAt instanceof Date ? latest.generatedAt.getTime() : NaN;
    return this.now() >= stamp && this.now() - stamp < DAY_MS;
  }

  /** @param {{force?: boolean}} [opts] @returns {Promise<Summary>} */
  async execute(opts = {}) {
    /** @type {string|null} */ let owner = null;
    try {
      if (!opts.force && await this.fresh()) return { ran: false, reason: "fresh" };
      await this.lock.ensureIndexes();
      owner = await this.lock.acquire();
      if (!owner) return { ran: false, reason: "lock_held" };
      if (!opts.force && await this.fresh()) return { ran: false, reason: "fresh" };
      const run = await this.deps.classifierQuality.recompute();
      this.deps.logger.info(run, "classifier_quality_recomputed");
      return { ran: true, ...run };
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === "classifier_quality_index_unavailable") return { ran: false, reason: "index_building" };
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "classifier_quality_job_failed");
      return { ran: false, reason: "failed" };
    } finally {
      if (owner) await this.lock.release(owner).catch(() => this.deps.logger.warn("classifier_quality_lock_release_failed"));
    }
  }
}

/** @param {Dependencies} deps */
function buildClassifierQualityJob(deps) { return new ClassifierQualityJob(deps); }

module.exports = { buildClassifierQualityJob, ClassifierQualityJob, DAY_MS, START_DELAY_MS, LEASE_MS };
