"use strict";

const crypto = require("crypto");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");

/** Durable bounded diagnostics. Ledger failure never changes a worker result.
 * Run-now uses the very same single-flight wrapper as scheduled invocations. */
class JobLedger {
  /** @param {{db:any,adminEvents?:any,now?:()=>number}} deps */
  constructor(deps) { this.db = deps.db; this.events = deps.adminEvents; this.now = deps.now || Date.now; /** @type {Map<string,any>} */ this.jobs = new Map(); this.alerted = new Set(); this.alertDay = ""; }

  /** @param {string} name @param {number} intervalMs @param {(...args:any[])=>any} tick @param {{disabled?:boolean,envFlag?:string,manual?:boolean,scheduleDisabled?:boolean,firstDelayMs?:number,minRecordIntervalMs?:number}} [options] */
  instrumentJob(name, intervalMs, tick, options = {}) {
    /** @type {any} */
    const state = { name, intervalMs, envFlag: options.envFlag || null, disabled: !!options.disabled, scheduleDisabled: !!options.scheduleDisabled,
      manual: options.manual !== false, firstDelayMs: options.firstDelayMs ?? intervalMs, minRecordIntervalMs: options.minRecordIntervalMs || 0, lastRecordedAt: null, registeredAt: this.now(), lastStarted: null, lastOk: null, running: null, failure: null };
    /** @param {any[]} args */
    const run = (...args) => this.run(state, tick, args);
    run.failed = (/** @type {unknown} */ error) => { state.failure = safeError(error); };
    this.jobs.set(name, { state, run });
    if (state.disabled) void this.write({ job: name, startedAt: new Date(this.now()), durationMs: 0, status: "disabled", summary: {}, errorCode: null });
    return run;
  }

  /** @param {any} state @param {(...args:any[])=>any} tick @param {any[]} args */
  run(state, tick, args) {
    if (state.disabled) return Promise.resolve(null);
    if (state.running) return state.running;
    state.lastStarted = this.now(); state.failure = null;
    state.running = (async () => {
      let result;
      try { result = await tick(...args); return result; }
      catch (error) { state.failure = safeError(error); throw error; }
      finally {
        if (!state.failure && (result?.reason === "failed" || result?.error)) state.failure = "job_failed";
        const status = state.failure ? "error" : lockHeld(result) ? "lock_held" : "ok";
        if (status === "ok") state.lastOk = this.now();
        if (status !== "ok" || state.lastRecordedAt === null || this.now() - state.lastRecordedAt >= state.minRecordIntervalMs) {
        state.lastRecordedAt = this.now();
        await this.write({ job: state.name, startedAt: new Date(state.lastStarted), durationMs: Math.max(0, this.now() - state.lastStarted),
          status, summary: numericSummary(result), errorCode: state.failure || (result?.reason === "failed" || result?.error ? "job_failed" : null) });
        }
        state.running = null;

      }
    })();
    return state.running;
  }

  /** @param {Record<string,any>} row */
  async write(row) { try { await this.db.jobRuns.insertOne(stampVersion({ runId: crypto.randomUUID(), ...row }, COLLECTIONS.JOB_RUNS)); } catch { /* Observability is best effort. */ } }

  async snapshot() {
    const rows = await this.db.jobRuns.find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(5000).toArray();
    return { jobs: [...this.jobs.values()].map(({ state }) => jobSnapshot(state, rows, this.now())), generatedAt: new Date(this.now()) };
  }

  /** One idempotent alert per job/day. No provider polling or scheduler added. */
  async checkOverdue() {
    const day = new Date(this.now()).toISOString().slice(0,10);
    if (this.alertDay !== day) { this.alertDay = day; this.alerted.clear(); }
    for (const { state } of this.jobs.values()) {
      if (this.alerted.has(state.name) || state.disabled || state.scheduleDisabled || this.now() - (state.lastOk || state.registeredAt) < 3 * state.intervalMs) continue;
      try { const event = await this.events?.record("job_overdue", { job: state.name, intervalMs: state.intervalMs }, { ingestionKey: `job-overdue:${state.name}:${day}` }); if (event) this.alerted.add(state.name); } catch { /* Best effort. */ }
    }
  }

  /** @param {string} name */
  async runNow(name) {
    const job = this.jobs.get(name);
    if (!job || !job.state.manual) throw Object.assign(new Error("job_not_found"), { status: 404, code: "job_not_found" });
    if (job.state.disabled) throw Object.assign(new Error("job_disabled"), { status: 409, code: "job_disabled" });
    try { await job.run(); } catch { throw Object.assign(new Error("Job failed. Check its last error and retry."), { status: 503, code: "job_failed" }); }
    if (job.state.failure) throw Object.assign(new Error("Job failed. Check its last error and retry."), { status: 503, code: "job_failed" });
    return { ok: true, job: name };
  }
}

/** @param {any} state @param {any[]} rows @param {number} now */
function jobSnapshot(state, rows, now) {
  const history = rows.filter((row) => row.job === state.name).slice(0, 20);
  return { job: state.name, intervalMs: state.intervalMs, envFlag: state.envFlag, disabled: state.disabled || state.scheduleDisabled, running: !!state.running,
    canRun: state.manual && !state.disabled, lastOk: history.find((r) => r.status === "ok")?.startedAt || null,
    lastError: history.find((r) => r.status === "error") || null, durations: history.slice(0, 12).reverse().map((r) => r.durationMs), history,
    nextDue: state.disabled || state.scheduleDisabled ? null : new Date(state.lastStarted === null ? state.registeredAt + state.firstDelayMs : state.lastStarted + state.intervalMs),
    overdue: !state.disabled && !state.scheduleDisabled && now - (state.lastOk || state.registeredAt) >= 3 * state.intervalMs };
}
/** @param {unknown} error */
function safeError(error) { const code = /** @type {any} */ (error)?.code; return typeof code === "string" && /^[a-zA-Z0-9_]{1,64}$/.test(code) ? code : "job_failed"; }
/** @param {any} result */
function lockHeld(result) { return result?.lockHeld === true || result?.ranAsLeader === false || result?.reason === "lock_held" || result?.skipped === "lock_held"; }
/** Retain only bounded scalar counters, never payloads, URLs or user IDs. @param {any} result */
function numericSummary(result) {
  if (typeof result === "number") return { count: result };
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  return Object.fromEntries(Object.entries(result).filter(([key,value]) => /^[a-zA-Z]{1,32}$/.test(key) && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))).slice(0, 20));
}
/** Optional instrumentation preserves narrow worker/test callers. @param {any} deps @param {string} name @param {number} interval @param {(...args:any[])=>any} tick @param {any} [options] */
function observeJob(deps, name, interval, tick, options) {
  if (deps.jobLedger) return deps.jobLedger.instrumentJob(name, interval, tick, options);
  return Object.assign(tick, { failed: (/** @type {unknown} */ _error) => {} });
}
/** Existing-process timer: memory checks only until one idempotent alert is due. @param {JobLedger} ledger */
function startJobMonitor(ledger) { const timer = setInterval(() => { void ledger.checkOverdue(); }, 60000); timer.unref(); return () => clearInterval(timer); }
module.exports = { JobLedger, observeJob, startJobMonitor };
