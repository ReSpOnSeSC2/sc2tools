"use strict";

const { performance } = require("perf_hooks");
const { beforeDeviceAuthDeadline } = require("./deviceAuthDeadline");
const { prepareCredentialAuthority } = require("./deviceCredentialPreparation");

const READINESS_MS = 5000;
const READINESS_WAITERS = 8;

/** Writer-owned readiness only. Readers cannot prepare or activate authority.
 * A caller timeout retires publication, not ownership of the actual IO. */
class DeviceCredentialReadiness {
  /** @param {any} collection @param {{capability?:'causal'|'writer-only-standalone'|'unavailable',now?:()=>number, prepare?:(deadline:number,now:()=>number|null)=>Promise<any>}} [options] */
  constructor(collection, options = {}) {
    this.clock = options.now || (() => performance.now());
    this.capability = options.capability || "unavailable";
    this.prepare = options.prepare || ((deadline, now) => prepareCredentialAuthority(collection, deadline, now, this.capability));
    this.last = -Infinity; this.stopped = false;
    /** @type {any} */ this.attempt = null;
  }

  /** @returns {number|null} */
  now() {
    let value;
    try { value = this.clock(); } catch { return null; }
    if (!Number.isFinite(value) || value < this.last) return null;
    this.last = value; return value;
  }

  /** One actual preparation, at most eight waiters, no detached replacement.
   * @returns {Promise<any>} */
  async ensure() {
    const start = this.now();
    if (!canPrepare(this, start)) throw unavailable();
    let attempt = this.attempt;
    if (!attempt) {
      attempt = { deadline: start + READINESS_MS, waiters: 0, retired: false, promise: null };
      this.attempt = attempt;
      attempt.promise = this.perform(attempt);
      void attempt.promise.then(() => { if (this.attempt === attempt) this.attempt = null; });
    }
    if (attempt.retired || attempt.waiters >= READINESS_WAITERS) throw unavailable();
    attempt.waiters += 1;
    try {
      const row = await beforeDeviceAuthDeadline(attempt.promise, attempt.deadline,
        () => this.now(), () => { attempt.retired = true; });
      const current = this.now();
      if (!publishable(this, attempt, row, current)) throw unavailable();
      return row;
    } finally { attempt.waiters -= 1; }
  }

  /** @param {any} attempt @returns {Promise<any>} */
  async perform(attempt) {
    try { return await this.prepare(attempt.deadline, () => this.now()); }
    catch { return null; }
  }

  /** Synchronous retirement precedes the await; actual IO remains charged. */
  async stopAndDrain() {
    this.stopped = true;
    if (this.attempt) this.attempt.retired = true;
    await Promise.allSettled([this.attempt?.promise]);
  }
}

/** @param {DeviceCredentialReadiness} readiness @param {any} attempt
 * @param {any} row @param {number|null} current */
function publishable(readiness, attempt, row, current) {
  return !!row && !readiness.stopped && !attempt.retired && current !== null && current < attempt.deadline;
}

/** @param {DeviceCredentialReadiness} readiness @param {number|null} start
 * @returns {start is number} */
function canPrepare(readiness, start) {
  return !readiness.stopped && start !== null
    && (readiness.capability === "causal" || readiness.capability === "writer-only-standalone");
}

/** Startup availability is independent of retention metadata readiness.
 * @param {any} service @param {any} logger */
async function prepareDeviceCredentialsForServing(service, logger) {
  try { await service.readiness.ensure(); return true; }
  catch {
    try { logger?.warn?.({ code: "device_credential_readiness_unavailable" }, "device_credential_readiness_unavailable"); }
    catch { /* Reporting cannot turn retention metadata into a boot outage. */ }
    return false;
  }
}

function unavailable() { return Object.assign(new Error("device_credential_readiness_unavailable"), { status: 503, code: "device_credential_readiness_unavailable" }); }

module.exports = { DeviceCredentialReadiness, prepareDeviceCredentialsForServing, READINESS_MS, READINESS_WAITERS };
