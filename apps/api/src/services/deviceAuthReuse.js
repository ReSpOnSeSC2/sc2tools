"use strict";

const { sha256 } = require("../util/hash");
const { DEVICE_TOUCH_MS } = require("./deviceLiveness");
const { deviceAuthOwnerHash } = require("./deviceAuthAuthority");
const { beforeDeviceAuthDeadline } = require("./deviceAuthDeadline");

// Accounted cache bytes cover keys/DTOs and fixed task/ticket allowances, not
// VM/driver heap. Lease/probe/session/waiter objects have separate count caps.
const DEVICE_AUTH_LIMITS = Object.freeze({ entries: 1024, bytes: 512 * 1024, entryBytes: 1024,
  loads: 4, subscribers: 16, tickets: 16, preparations: 16, ttlMs: 60000 });
const TICKET_BYTES = 256;

/** Unwired positive retention only. Returning null always means the eventual
 * middleware must issue its original authoritative lookup independently. */
class DeviceAuthReuse {
  /** @param {import('./deviceAuthLease').DeviceAuthLease} lease
   * @param {(hash:string,options:any)=>Promise<any>} readSnapshot
   * @param {{wallNow?:()=>number,limits?:Partial<typeof DEVICE_AUTH_LIMITS>}} [options] */
  constructor(lease, readSnapshot, options = {}) {
    this.lease = lease; this.readSnapshot = readSnapshot; this.wallNow = options.wallNow || Date.now;
    this.limits = { ...DEVICE_AUTH_LIMITS, ...options.limits };
    for (const name of Object.keys(DEVICE_AUTH_LIMITS)) {
      const key = /** @type {keyof typeof DEVICE_AUTH_LIMITS} */ (name);
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] <= 0 || this.limits[key] > DEVICE_AUTH_LIMITS[key]) {
        throw new Error("device_auth_invalid_limits");
      }
    }
    /** @type {Map<string,any>} */ this.states = new Map();
    /** @type {Set<any>} */ this.tasks = new Set();
    /** @type {Map<object,any>} */ this.tickets = new Map();
    /** @type {Set<Promise<any>>} */ this.preparations = new Set();
    this.bytes = 0; this.stateCount = 0; this.epoch = {}; this.generation = ""; this.stopped = false;
  }

  /** @param {string} hash @returns {Promise<object|null>} */
  prepare(hash) {
    if (this.stopped || this.preparations.size >= this.limits.preparations) return Promise.resolve(null);
    const task = prepareTicket(this, hash); this.preparations.add(task);
    void task.then(() => this.preparations.delete(task)); return task;
  }

  /** The only admission seam is synchronous and one-use. No rejected result
   * can become a baseline read. @param {string} hash @param {object|null} ticket */
  consume(hash, ticket) {
    if (!ticket) return null;
    const saved = this.tickets.get(ticket); if (!saved) return null;
    releaseTicket(this, ticket, saved);
    const entry = saved.state.entry;
    if (this.stopped || saved.key !== privateKey(hash) || saved.epoch !== this.epoch) return null;
    if (!entry || entry.identity !== saved.identity || !eligible(this, saved.state, entry, saved.grant)) return null;
    return { userId: entry.value.userId, deviceId: entry.value.deviceId };
  }

  /** Retire synchronously, then own actual loads, subscribers and sessions. */
  async stopAndDrain() {
    this.stopped = true; retireAll(this);
    const leaseDrain = this.lease.stopAndDrain();
    await Promise.allSettled([leaseDrain, ...this.preparations, ...[...this.tasks].map(task => task.promise)]);
    for (const state of [...this.states.values()]) evictState(this, state);
  }
}

/** @param {string} hash */
function privateKey(hash) {
  return typeof hash === "string" && /^[\da-f]{64}$/.test(hash)
    ? sha256(`device-rest-auth-cache:v1\0${hash}`) : null;
}

/** @param {any} cache @param {any} state */
function releaseState(cache, state) {
  if (!state.mapped && !state.pins && state.charged) {
    state.charged = false; cache.stateCount -= 1; cache.bytes -= state.keyBytes;
  }
}

/** @param {any} cache @param {object} ticket @param {any} saved */
function releaseTicket(cache, ticket, saved) {
  if (!cache.tickets.delete(ticket)) return;
  cache.bytes -= TICKET_BYTES; saved.state.pins -= 1; releaseState(cache, saved.state);
}

/** @param {any} cache @param {any} state */
function discardEntry(cache, state) {
  if (state.entry) cache.bytes -= state.entry.bytes;
  state.entry = null;
}

/** @param {any} cache @param {any} state */
function evictState(cache, state) {
  discardEntry(cache, state); state.token = {}; state.task = null;
  for (const [ticket, saved] of cache.tickets) if (saved.state === state) releaseTicket(cache, ticket, saved);
  if (cache.states.get(state.key) === state) cache.states.delete(state.key);
  state.mapped = false; releaseState(cache, state);
}

/** @param {any} cache */
function retireAll(cache) {
  cache.epoch = {};
  for (const [ticket, saved] of cache.tickets) releaseTicket(cache, ticket, saved);
  for (const state of cache.states.values()) { discardEntry(cache, state); state.token = {}; state.task = null; }
}

/** @param {any} cache @param {number} bytes @param {any} [protect] */
function reserve(cache, bytes, protect) {
  for (const state of cache.states.values()) {
    if (cache.bytes + bytes <= cache.limits.bytes) break;
    if (state !== protect) evictState(cache, state);
  }
  return cache.bytes + bytes <= cache.limits.bytes;
}

/** @param {any} cache @param {string} key */
function stateFor(cache, key) {
  let state = cache.states.get(key);
  if (state) { cache.states.delete(key); cache.states.set(key, state); return state; }
  const keyBytes = Buffer.byteLength(key) + 128;
  for (const victim of cache.states.values()) {
    if (cache.stateCount < cache.limits.entries && cache.bytes + keyBytes <= cache.limits.bytes) break;
    evictState(cache, victim);
  }
  if (cache.stateCount >= cache.limits.entries || !reserve(cache, keyBytes)) return null;
  state = { key, keyBytes, mapped: true, charged: true, pins: 0, token: {}, entry: null, task: null };
  cache.states.set(key, state); cache.stateCount += 1; cache.bytes += keyBytes; return state;
}

/** Every guard is synchronous. An observed timestamp can only shorten reuse;
 * a scheduled touch is never evidence it succeeded.
 * @param {any} cache @param {any} state @param {any} entry @param {any} grant */
function eligible(cache, state, entry, grant) {
  if (cache.stopped || !cache.lease.current(grant) || cache.states.get(state.key) !== state) return false;
  if (!sameScope(entry, grant)) return false;
  const now = cache.lease.now(); let wall;
  try { wall = cache.wallNow(); } catch { return false; }
  return now !== null && now < entry.expiresAt && Number.isFinite(wall) && wall < entry.seen + DEVICE_TOUCH_MS;
}

/** @param {any} entry @param {any} grant */
function sameScope(entry, grant) {
  return entry.incarnation === grant.incarnation && entry.generation === grant.generation
    && !grant.denyAll && !grant.denied.includes(entry.ownerHash);
}

/** @param {any} cache @param {number} now */
function reapTickets(cache, now) {
  for (const [ticket, saved] of cache.tickets) {
    if (saved.grant.deadline <= now || saved.state.entry?.identity !== saved.identity) releaseTicket(cache, ticket, saved);
  }
}

/** @param {any} cache @param {any} state @param {any} grant */
function ticketFor(cache, state, grant) {
  const now = cache.lease.now(); if (now === null) return null;
  reapTickets(cache, now);
  const entry = state.entry;
  if (!entry || !eligible(cache, state, entry, grant) || cache.tickets.size >= cache.limits.tickets) return null;
  if (!reserve(cache, TICKET_BYTES, state)) return null;
  const ticket = Object.freeze({});
  cache.tickets.set(ticket, { state, key: state.key, identity: entry.identity, grant, epoch: cache.epoch });
  state.pins += 1; cache.bytes += TICKET_BYTES; return ticket;
}

/** @param {any} cache @param {any} task */
function releaseTask(cache, task) {
  if (!task.done || task.subscribers || !cache.tasks.delete(task)) return;
  cache.bytes -= task.bytes; task.state.pins -= 1; releaseState(cache, task.state);
}

/** @param {any} cache @param {any} task */
function currentTask(cache, task) {
  return !cache.stopped && !task.retired && task.epoch === cache.epoch && task.token === task.state.token
    && cache.states.get(task.state.key) === task.state && task.state.task === task && cache.lease.current(task.grant);
}

/** @param {any} loaded */
function snapshotParts(loaded) {
  const snapshot = loaded.snapshot; if (!snapshot || !snapshot.hit) return null;
  const value = snapshot.hit, seen = snapshot.observedLastSeenAtMs, ownerHash = deviceAuthOwnerHash(value.userId);
  if (!ownerHash || typeof value.deviceId !== "string" || value.deviceId.length > 256) return null;
  if (typeof seen !== "number" || !Number.isFinite(seen) || new Date(seen).getTime() !== seen) return null;
  return { value, seen, ownerHash };
}

/** @param {any} cache @param {any} loaded */
function entryFor(cache, loaded) {
  const parts = snapshotParts(loaded); if (!parts) return null;
  if (typeof loaded.startedAt !== "number" || !Number.isFinite(loaded.startedAt)) return null;
  const body = { value: { userId: parts.value.userId, deviceId: parts.value.deviceId }, ownerHash: parts.ownerHash, seen: parts.seen,
    incarnation: loaded.grant.incarnation, generation: loaded.grant.generation,
    expiresAt: loaded.startedAt + cache.limits.ttlMs };
  const bytes = Buffer.byteLength(JSON.stringify(body)) + 128;
  return bytes <= cache.limits.entryBytes ? { ...body, bytes, identity: {} } : null;
}

/** @param {any} cache @param {any} task @param {string} hash */
async function loadActual(cache, task, hash) {
  try {
    const loaded = await cache.lease.read(task.grant, (/** @type {any} */ options) => cache.readSnapshot(hash, options));
    if (!loaded || !currentTask(cache, task)) return null;
    const entry = entryFor(cache, loaded);
    if (!entry || !eligible(cache, task.state, entry, task.grant) || !reserve(cache, entry.bytes, task.state)) return null;
    discardEntry(cache, task.state); task.state.entry = entry; cache.bytes += entry.bytes; return entry.identity;
  } catch { return null; }
  finally { task.done = true; if (task.state.task === task) task.state.task = null; releaseTask(cache, task); }
}

/** @param {any} cache @param {any} state @param {any} grant @param {string} hash */
function loadFor(cache, state, grant, hash) {
  const previous = state.task;
  if (previous && previous.grant === grant && !previous.retired) {
    if (previous.subscribers >= cache.limits.subscribers) return null;
    previous.subscribers += 1; return previous;
  }
  const bytes = cache.limits.entryBytes + Buffer.byteLength(hash) + 512;
  if (cache.tasks.size >= cache.limits.loads || !reserve(cache, bytes, state)) return null;
  /** @type {any} */ const task = { state, grant, bytes, token: state.token, epoch: cache.epoch,
    retired: false, subscribers: 1, done: false, promise: null };
  state.task = task; state.pins += 1; cache.bytes += bytes; cache.tasks.add(task);
  task.promise = loadActual(cache, task, hash); return task;
}

/** @param {any} cache @param {string} hash */
async function prepareTicket(cache, hash) {
  const key = privateKey(hash); if (!key) return null;
  try {
    const grant = await cache.lease.acquire();
    if (!grant || cache.stopped || grant.denyAll) return null;
    const generation = `${grant.incarnation}\0${grant.generation}`;
    if (generation !== cache.generation) { retireAll(cache); cache.generation = generation; }
    const state = stateFor(cache, key); if (!state) return null;
    const existing = existingTicket(cache, state, grant);
    return existing !== undefined ? existing : await loadTicket(cache, state, grant, hash);
  } catch { return null; }
}

/** @param {any} cache @param {any} state @param {any} grant */
function existingTicket(cache, state, grant) {
  if (!state.entry) return undefined;
  if (eligible(cache, state, state.entry, grant)) return ticketFor(cache, state, grant);
  discardEntry(cache, state); return null;
}

/** @param {any} cache @param {any} state @param {any} grant @param {string} hash */
async function loadTicket(cache, state, grant, hash) {
  const task = loadFor(cache, state, grant, hash); if (!task) return null;
  try {
    const identity = await beforeDeviceAuthDeadline(task.promise, grant.deadline, () => cache.lease.now(), () => {
      task.retired = true; cache.lease.expire(grant);
    });
    return identity && state.entry?.identity === identity ? ticketFor(cache, state, grant) : null;
  } finally { task.subscribers -= 1; releaseTask(cache, task); }
}

module.exports = { DeviceAuthReuse, DEVICE_AUTH_LIMITS };
