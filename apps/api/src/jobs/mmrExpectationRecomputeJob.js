"use strict";

const { buildJobLock } = require("../util/jobLock");
const { observeJob } = require("../util/jobLedger");
const { RULE_VERSION } = require("../services/mmrExpectation");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const START_DELAY_MS = 15 * 60_000;
const LEASE_MS = 5 * 60_000; // Longer than the single two-minute server aggregation.

/** @typedef {{ran:boolean,reason?:string,run?:Awaited<ReturnType<import('../services/mmrExpectation').MmrExpectationService['recompute']>>}} Summary */
/** @typedef {{db:import('../db/connect').DbContext,mmrExpectation:Pick<import('../services/mmrExpectation').MmrExpectationService,'readRun'|'recompute'>,logger:import('pino').Logger,jobLedger?:import('../util/jobLedger').JobLedger,now?:()=>number,disabled?:boolean,startDelayMs?:number}} Dependencies */

class MmrExpectationRecomputeJob {
  /** @param {Dependencies} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.disabled = deps.disabled ?? process.env.SC2TOOLS_MMR_EXPECTATION_DISABLED === "1";
    this.delay = deps.startDelayMs ?? START_DELAY_MS;
    this.lock = buildJobLock({ collection: deps.db.db.collection("jobLocks"), key: "mmrExpectationRecompute", leaseMs: LEASE_MS, now: this.now });
    /** @type {NodeJS.Timeout|null} */ this.startTimer = null;
    /** @type {NodeJS.Timeout|null} */ this.checkTimer = null;
    /** @type {Promise<Summary>|null} */ this.inflight = null;
    this.observedRun = observeJob(deps, "mmr-expectation", HOUR_MS, () => this.runWork(), { disabled: this.disabled, firstDelayMs: this.delay, envFlag: "SC2TOOLS_MMR_EXPECTATION_DISABLED" });
  }

  start() {
    if (this.disabled || this.startTimer || this.checkTimer) return;
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

  runOnce() {
    if (this.disabled) return Promise.resolve({ ran: false, reason: "disabled" });
    return this.observedRun();
  }

  runWork() {
    if (this.inflight) return this.inflight;
    this.inflight = this.execute().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async fresh() {
    const row = await this.deps.mmrExpectation.readRun();
    const stamp = row?.updatedAt instanceof Date ? row.updatedAt.getTime() : NaN;
    return row?.ruleVersion === RULE_VERSION && this.now() >= stamp && this.now() - stamp < DAY_MS;
  }

  /** @returns {Promise<Summary>} */
  async execute() {
    let owner = null;
    try {
      if (await this.fresh()) return { ran: false, reason: "fresh" };
      await this.lock.ensureIndexes();
      owner = await this.lock.acquire();
      if (!owner) return { ran: false, reason: "lock_held" };
      if (await this.fresh()) return { ran: false, reason: "fresh" };
      const token = owner;
      const run = await this.deps.mmrExpectation.recompute({ beforePublish: async () => {
        if (!(await this.lock.extend(token))) throw new Error("mmr_expectation_lock_lost");
      } });
      return { ran: true, run };
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mmr_expectation_job_failed");
      return { ran: false, reason: "failed" };
    } finally {
      if (owner) await this.lock.release(owner).catch(() => this.deps.logger.warn("mmr_expectation_lock_release_failed"));
    }
  }
}

/** @param {Dependencies} deps */
function buildMmrExpectationRecomputeJob(deps) { return new MmrExpectationRecomputeJob(deps); }

module.exports = { buildMmrExpectationRecomputeJob, MmrExpectationRecomputeJob, DAY_MS, START_DELAY_MS, LEASE_MS };
