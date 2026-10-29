"use strict";

const { randomUUID } = require("crypto");
const { performance } = require("perf_hooks");
const { beforeDeviceAuthDeadline } = require("./deviceAuthDeadline");
const { deviceAuthGrantFilter, validDeviceAuthGrant, copyDeviceAuthOperationTime } = require("./deviceAuthAuthority");

const DEVICE_AUTH_LEASE_MS = 1800;
const DEVICE_AUTH_READS = 4;
const DEVICE_AUTH_WAITERS = 16;

/** Unwired demand-only grants. Actual in-flight work remains owned after a
 * caller deadline. There is no initialization, activation or repair path. */
class DeviceAuthLease {
  /** @param {any} collection @param {import('mongodb').MongoClient} client
   * @param {{now?:()=>number}} [options] */
  constructor(collection, client, options = {}) {
    this.collection = collection; this.client = client;
    this.clock = options.now || (() => performance.now()); this.last = -Infinity;
    this.stopped = false; this.poisoned = false;
    /** @type {any} */ this.grant = null;
    /** @type {any} */ this.probe = null;
    /** @type {Set<Promise<any>>} */ this.reads = new Set();
  }

  /** A bad elapsed clock retires this process's reuse, not baseline auth.
   * @returns {number|null} */
  now() {
    if (this.poisoned) return null;
    let value;
    try { value = this.clock(); } catch { this.poisoned = true; this.grant = null; return null; }
    if (!Number.isFinite(value) || value < this.last) {
      this.poisoned = true; this.grant = null; return null;
    }
    this.last = value; return value;
  }

  /** Exact local grant identity prevents old-ticket renewal.
   * @param {any} [grant] */
  current(grant = this.grant) {
    const now = this.now();
    return !this.stopped && grant && grant === this.grant && !grant.retired
      && now !== null && now < grant.deadline ? grant : null;
  }

  /** @returns {Promise<any>} */
  async acquire() {
    const now = this.now(); if (this.stopped || now === null) return null;
    const current = this.current(); if (current) return current;
    this.grant = null;
    let task = this.probe;
    if (!task) {
      task = { id: {}, deadline: now + DEVICE_AUTH_LEASE_MS, waiters: 0, retired: false, promise: null };
      this.probe = task; task.promise = this.#probe(task);
      void task.promise.then(() => { if (this.probe === task) this.probe = null; });
    }
    if (task.retired || task.waiters >= DEVICE_AUTH_WAITERS) return null;
    task.waiters += 1;
    try { return await beforeDeviceAuthDeadline(task.promise, task.deadline, () => this.now(), () => { task.retired = true; this.grant = null; }); }
    finally { task.waiters -= 1; }
  }

  /** @param {any} task */
  async #probe(task) {
    let session, candidate = null;
    try {
      session = this.client.startSession({ causalConsistency: true });
      const start = this.now(); if (start === null) return null;
      task.deadline = start + DEVICE_AUTH_LEASE_MS;
      const nonce = randomUUID();
      // Literal command concern avoids mongodb6.13's collection-option CSOT
      // normalization bug while still bounding selection/checkout/transport.
      const reply = await this.client.db(this.collection.dbName).command({
        findAndModify: this.collection.collectionName, query: deviceAuthGrantFilter(),
        update: { $set: { grantProbeNonce: nonce } }, new: true, upsert: false,
        maxTimeMS: DEVICE_AUTH_LEASE_MS, writeConcern: { w: "majority", j: true, wtimeout: DEVICE_AUTH_LEASE_MS },
      }, { session, readPreference: "primary", timeoutMS: DEVICE_AUTH_LEASE_MS });
      const row = acknowledgedValue(reply);
      const operationTime = copyDeviceAuthOperationTime(session.operationTime);
      if (validDeviceAuthGrant(row, nonce) && operationTime) candidate = Object.freeze({
        id: task.id, incarnation: row.incarnation, generation: row.generation,
        denyAll: row.denyAll, denied: Object.freeze(row.pending.map((/** @type {any} */ entry) => entry.ownerHash)),
        operationTime: Object.freeze(operationTime), deadline: task.deadline, retired: false,
      });
    } catch { candidate = null; }
    finally { try { await session?.endSession(); } catch { candidate = null; } }
    return this.#publish(task, candidate);
  }

  /** @param {any} task @param {any} candidate */
  #publish(task, candidate) {
    const now = this.now();
    if (!this.stopped && !task.retired && this.probe === task && now !== null && now < task.deadline) this.grant = candidate;
    return this.current(candidate);
  }

  /** One fresh causal session per cold load; the caller still owns the entire
   * returned task through cleanup, even after its own deadline.
   * @param {any} grant @param {(options:any)=>Promise<any>} reader @returns {Promise<any>} */
  read(grant, reader) {
    if (!this.current(grant) || this.reads.size >= DEVICE_AUTH_READS) return Promise.resolve(null);
    const task = this.#read(grant, reader); this.reads.add(task);
    void task.then(() => this.reads.delete(task)); return task;
  }

  /** @param {any} grant @param {(options:any)=>Promise<any>} reader */
  async #read(grant, reader) {
    let session, result = null, startedAt = null;
    try {
      session = this.client.startSession({ causalConsistency: true });
      const floor = copyDeviceAuthOperationTime(grant.operationTime); if (!floor) return null;
      session.advanceOperationTime(floor);
      startedAt = this.now();
      if (startedAt === null || !this.current(grant)) return null;
      const remaining = Math.max(1, Math.floor(grant.deadline - startedAt));
      result = await reader({ session, readPreference: "primary", readConcern: { level: "majority" },
        maxTimeMS: remaining, timeoutMS: remaining });
    } catch { result = null; }
    finally { try { await session?.endSession(); } catch { result = null; } }
    return result && this.current(grant) ? { snapshot: result, startedAt, grant } : null;
  }

  /** A real caller deadline may retire a grant conservatively even when its
   * elapsed clock is slow. @param {any} grant */
  expire(grant) { if (this.grant === grant) this.grant = null; }

  /** Synchronously retire before the first await; no late grant/admission. */
  async stopAndDrain() {
    this.stopped = true; this.grant = null;
    if (this.probe) this.probe.retired = true;
    await Promise.allSettled([this.probe?.promise, ...this.reads]);
  }
}

/** Raw commands must reject write-concern errors themselves. The exact nonce
 * and matched row also prove this was a write, not a stale read/no-op.
 * @param {any} reply */
function acknowledgedValue(reply) {
  if (!reply || reply.ok !== 1 || Object.hasOwn(reply, "writeConcernError")) return null;
  return reply.lastErrorObject?.n === 1 ? reply.value : null;
}

module.exports = { DeviceAuthLease, DEVICE_AUTH_LEASE_MS, DEVICE_AUTH_READS, DEVICE_AUTH_WAITERS };
