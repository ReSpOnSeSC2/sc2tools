"use strict";

const { sha256 } = require("../util/hash");

const LIVENESS_LIMITS = Object.freeze({ owners: 1024, bytes: 512 * 1024, entryBytes: 16 * 1024,
  reads: 4, subscribers: 16, touches: 4, ttlMs: 30000 });
const DEVICE_TOUCH_MS = 60000;
/** @typedef {{paired:boolean,version:string|null,lastSeenAt:Date|null}} AgentSummary */

/** Bounded metadata reuse. Uncached queries preserve baseline read semantics;
 * cache admission never adds a new error or retries a metadata query. */
class DeviceLiveness {
  /** @param {{now?:()=>number,limits?:Partial<typeof LIVENESS_LIMITS>}} [opts] */
  constructor(opts = {}) {
    this.now = opts.now || Date.now; this.limits = { ...LIVENESS_LIMITS, ...opts.limits };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("device_liveness_invalid_limits");
    /** @type {Map<string,any>} */ this.owners = new Map();
    /** @type {Set<any>} */ this.tasks = new Set();
    /** @type {Map<string,Promise<void>>} */ this.touches = new Map();
    this.bytes = 0; this.keyBytes = 0; this.bodyBytes = 0; this.ownerStates = 0;
    this.reads = 0; this.overflow = 0; this.epoch = {};
  }
  /** @param {any} state */
  discard(state) {
    if (state.entry) { this.bodyBytes -= state.entry.charge; this.bytes -= state.entry.charge; }
    state.entry = null;
  }
  /** Retirement fences retention and future joins, not baseline in-flight DTOs.
   * @param {any} state */
  retire(state) { this.discard(state); state.token = {}; state.pending = null; }
  retireAll() { this.epoch = {}; for (const state of this.owners.values()) this.retire(state); }
  /** A detached read/subscriber still pins its key until it settles. @param {any} state */
  releaseKey(state) {
    if (state.charged && !state.mapped && !state.pins && !state.active) {
      state.charged = false; this.ownerStates -= 1; this.keyBytes -= state.keyCharge; this.bytes -= state.keyCharge;
    }
  }
  /** @param {any} state */
  evict(state) {
    this.retire(state); this.owners.delete(state.key); state.mapped = false; this.releaseKey(state);
  }
  /** @param {string} owner */
  state(owner) {
    const key = sha256(owner); let state = this.owners.get(key);
    if (state) { this.owners.delete(key); this.owners.set(key, state); return state; }
    const keyCharge = Buffer.byteLength(key);
    while (this.ownerStates >= this.limits.owners || this.bytes + keyCharge > this.limits.bytes) {
      const victim = [...this.owners.values()].find(value => value.active === 0);
      if (!victim) return null;
      // A retired pending query keeps its key charged; capacity may still bypass.
      this.evict(victim);
    }
    state = { key, keyCharge, charged: true, mapped: true, pins: 0, token: {}, active: 0, entry: null, pending: null };
    this.owners.set(key, state); this.ownerStates += 1; this.keyBytes += keyCharge; this.bytes += keyCharge; return state;
  }
  /** Called synchronously before a possible device write. Its finalizer is pure,
   * idempotent and cannot replace the write's result or rejection.
   * @param {string} owner @returns {()=>void} */
  begin(owner) {
    const state = this.state(owner);
    if (state) { state.active += 1; this.retire(state); }
    else { this.overflow += 1; this.retireAll(); }
    let finished = false;
    return () => {
      if (finished) return; finished = true;
      if (state) { this.retire(state); state.active -= 1; this.releaseKey(state); }
      else { this.retireAll(); this.overflow -= 1; }
    };
  }
  /** @template T @param {string} owner @param {()=>Promise<T>} work @returns {Promise<T>} */
  async mutate(owner, work) { const finish = this.begin(owner); try { return await work(); } finally { finish(); } }
  /** Best effort: no waiting queue, no success memo, and no auth failure on capacity.
   * Failed and unknown writes can retry from the next authoritative token read.
   * @param {string} owner @param {string} hash @param {()=>Promise<unknown>} work @returns {Promise<void>} */
  touch(owner, hash, work) {
    const key = sha256(hash), pending = this.touches.get(key);
    if (pending) return pending;
    if (this.touches.size >= this.limits.touches) return Promise.resolve();
    const keyCharge = Buffer.byteLength(key);
    for (const state of this.owners.values()) {
      if (this.bytes + keyCharge <= this.limits.bytes) break;
      this.discard(state);
    }
    if (this.bytes + keyCharge > this.limits.bytes) return Promise.resolve();
    this.bytes += keyCharge; this.keyBytes += keyCharge;
    const task = Promise.resolve().then(() => this.mutate(owner, work)).then(() => undefined).catch(() => {})
      .finally(() => {
        if (this.touches.get(key) === task) { this.touches.delete(key); this.bytes -= keyCharge; this.keyBytes -= keyCharge; }
      });
    this.touches.set(key, task); return task;
  }
  /** @param {any} task */
  current(task) {
    return !this.overflow && task.epoch === this.epoch && this.owners.get(task.state.key) === task.state
      && task.state.token === task.token && !task.state.active;
  }
  /** Exactly one baseline read; no cache state, queue, retry or admission error.
   * @param {()=>Promise<AgentSummary>} read @returns {Promise<AgentSummary>} */
  async uncached(read) { return cloneSummary(await read()); }
  /** @param {string} owner @param {()=>Promise<AgentSummary>} read @returns {Promise<AgentSummary>} */
  async latest(owner, read) {
    const state = this.state(owner);
    if (!state || this.overflow || state.active) return this.uncached(read);
    if (state.entry && state.entry.expiresAt <= this.now()) this.discard(state);
    if (state.entry) return cloneSummary(state.entry.value);
    let task = state.pending;
    if (task) {
      if (task.subscribers >= this.limits.subscribers) return this.uncached(read);
      task.subscribers += 1;
    } else {
      // This bounds only cache-owned work. Bypass keeps baseline HTTP IO.
      if (this.reads >= this.limits.reads || this.tasks.size >= this.limits.reads) return this.uncached(read);
      task = { state, token: state.token, epoch: this.epoch, subscribers: 1, done: false, promise: null };
      state.pending = task; state.pins += 1; this.tasks.add(task); task.promise = this.load(task, read);
    }
    try { return cloneSummary(await task.promise); }
    finally { task.subscribers -= 1; this.releaseTask(task); }
  }
  /** @param {any} task */
  releaseTask(task) {
    if (!task.done || task.subscribers || !this.tasks.delete(task)) return;
    task.state.pins -= 1; this.releaseKey(task.state);
  }
  /** @param {any} task @param {()=>Promise<AgentSummary>} read @returns {Promise<AgentSummary>} */
  async load(task, read) {
    this.reads += 1;
    try {
      const value = await read();
      // Existing callers may receive their original DB snapshot after retirement,
      // exactly as before caching. It must never refill or join a new generation.
      if (this.current(task)) this.keep(task.state, value);
      return value;
    } finally {
      this.reads -= 1; task.done = true;
      if (task.state.pending === task) task.state.pending = null;
      this.releaseTask(task);
    }
  }
  /** @param {any} state @param {AgentSummary} value */
  keep(state, value) {
    const rawBytes = Buffer.byteLength(value.version || "");
    if (rawBytes > this.limits.entryBytes) return;
    const charge = Buffer.byteLength(JSON.stringify(value));
    if (charge > this.limits.entryBytes) return;
    for (const candidate of this.owners.values()) {
      if (candidate.entry && candidate.entry.expiresAt <= this.now()) this.discard(candidate);
    }
    for (const candidate of this.owners.values()) {
      if (this.bytes + charge <= this.limits.bytes) break;
      this.discard(candidate);
    }
    // Keys (including empty, active and retired pending owners) stay charged.
    if (this.bytes + charge > this.limits.bytes) return;
    state.entry = { value: cloneSummary(value), charge, expiresAt: this.now() + this.limits.ttlMs };
    this.bodyBytes += charge; this.bytes += charge;
  }
}
/** @param {AgentSummary} value @returns {AgentSummary} */
function cloneSummary(value) {
  return { paired: value.paired, version: value.version,
    lastSeenAt: value.lastSeenAt instanceof Date ? new Date(value.lastSeenAt.getTime()) : null };
}

module.exports = { DeviceLiveness, LIVENESS_LIMITS, DEVICE_TOUCH_MS };
