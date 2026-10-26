"use strict";

const { requestKey } = require("../services/trendsRequests");
const ALLOWED_ROUTES = new Set(["timeseries", "dayHourHeatmap", "lengthBuckets", "activityCalendar", "momentum", "mapTrend"]);
const LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, entryBytes: 512 * 1024,
  keyBytes: 16 * 1024, entries: 512, ttlMs: 600000, active: 4, ownerActive: 2,
  waiting: 32, subscribers: 16, responses: 64, queueMs: 5000, responseMs: 30000 });

/** Explicit opt-in personal chart cache. Byte accounting includes retired,
 * response-pinned buffers; it is not a limit on Mongo or the entire JS heap. */
class UserCache {
  /** @param {import('../util/userRevision').UserRevision} revisions
   * @param {{enabled?:boolean,now?:()=>number,limits?:Partial<typeof LIMITS>}} [opts] */
  constructor(revisions, opts = {}) {
    this.enabled = opts.enabled === true && revisions.enabled;
    this.revisions = revisions; this.now = opts.now || Date.now;
    this.limits = { ...LIMITS, ...opts.limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("user_cache_invalid_limits");
    /** @type {Map<string,any>} */ this.completed = new Map();
    /** @type {Map<string,any>} */ this.pending = new Map();
    /** @type {any[]} */ this.queue = [];
    /** @type {Map<string,number>} */ this.ownerActive = new Map();
    this.bytes = 0; this.reserved = 0; this.active = 0; this.waiting = 0; this.responses = 0; this.serial = 0;
    /** @type {Record<string,number>} */
    this.stats = { hit: 0, miss: 0, join: 0, eviction: 0, expiry: 0, oversize: 0, bypass: 0, rejected: 0, late_fill: 0 };
    if (this.enabled) revisions.addInvalidator((owner) => this.invalidateForUser(owner));
  }
  get counters() {
    return { ...this.stats, ...this.revisions.counters, bytes: this.bytes, reserved_bytes: this.reserved,
      pinned_bytes: [...this.completed.values()].reduce((n, entry) => n + (entry.refs ? entry.charge : 0), 0)
        + this.retiredPinnedBytes, entries: this.completed.size, active: this.active, queued: this.waiting, response_leases: this.responses };
  }
  /** @returns {number} */
  get retiredPinnedBytes() { return this._retiredBytes || 0; }
  /** @param {string|null} owner */
  invalidateForUser(owner) {
    for (const [key, entry] of this.completed) if (owner === null || entry.owner === owner) this.evict(key);
    // Detach joins, never release the active computation's permit here.
    for (const [key, task] of this.pending) if (owner === null || task.owner === owner) this.pending.delete(key);
  }
  /** @param {string} key @param {string} [reason] */
  evict(key, reason = "eviction") {
    const entry = this.completed.get(key); if (!entry) return;
    this.completed.delete(key); entry.cached = false;
    if (entry.refs) this._retiredBytes = this.retiredPinnedBytes + entry.charge;
    else this.free(entry);
    this.stats[reason] += 1;
  }
  /** @param {any} entry */
  free(entry) {
    if (entry.freed) return; entry.freed = true;
    this.bytes -= entry.charge; entry.body = null;
  }
  /** @param {any} entry */
  releaseEntry(entry) {
    entry.refs -= 1;
    if (!entry.refs && !entry.cached) { this._retiredBytes = this.retiredPinnedBytes - entry.charge; this.free(entry); }
  }
  /** @param {number} charge */
  reserve(charge) {
    for (const [key, entry] of this.completed) if (entry.expiresAt <= this.now()) this.evict(key, "expiry");
    while (this.bytes + this.reserved + charge > this.limits.bytes && this.completed.size) {
      this.evict(this.completed.keys().next().value || "");
    }
    if (this.bytes + this.reserved + charge > this.limits.bytes) throw this.busy();
    this.reserved += charge;
  }
  busy() { this.stats.rejected += 1; return Object.assign(new Error("user_cache_busy"), { status: 503, code: "user_cache_busy" }); }
  retired() { this.stats.late_fill += 1; return Object.assign(new Error("user_cache_changed"), { status: 503, code: "user_cache_changed" }); }
  /** @param {any} req @param {any} res @param {string} owner @param {string} route
   * @param {object} filters @param {object} options @param {()=>Promise<any>} work */
  async send(req, res, owner, route, filters, options, work) {
    if (!this.enabled || req.method !== "GET" || !ALLOWED_ROUTES.has(route)) return res.json(await work());
    if (this.responses >= this.limits.responses) { res.set("Retry-After", "1"); throw this.busy(); }
    this.responses += 1;
    const sub = { active: true, entry: /** @type {any} */ (null), task: /** @type {any} */ (null),
      queued: false, timer: /** @type {any} */ (null), responseTimer: /** @type {any} */ (null),
      reject: /** @type {null|((error:any)=>void)} */ (null) };
    const close = () => {
      if (!sub.active) return; sub.active = false; this.responses -= 1;
      clearTimeout(sub.timer); clearTimeout(sub.responseTimer);
      req.removeListener("aborted", close); res.removeListener("close", close); res.removeListener("finish", close);
      if (sub.queued) { sub.queued = false; this.waiting -= 1; }
      if (sub.entry) this.releaseEntry(sub.entry);
      if (sub.task) {
        sub.task.subs.delete(sub);
        if (!sub.task.started && !sub.task.subs.size) {
          const index = this.queue.indexOf(sub.task); if (index >= 0) this.queue.splice(index, 1);
          if (this.pending.get(sub.task.key) === sub.task) this.pending.delete(sub.task.key);
        }
        if (!sub.task.subs.size && sub.task.releaseResponse) sub.task.releaseResponse();
      }
      sub.reject?.(Object.assign(new Error("request_aborted"), { status: 499, code: "request_aborted" }));
      this.drain();
    };
    req.once("aborted", close); res.once("close", close); res.once("finish", close);
    try {
      const snapshot = await this.revisions.snapshot(owner);
      if (!sub.active || res.destroyed) return;
      if (!this.revisions.sameGeneration(snapshot)) throw this.retired();
      const stable = this.revisions.current(snapshot);
      const encoded = stable ? requestKey([owner, route, filters, options, snapshot.rev, snapshot.epoch, snapshot.token.id]) : null;
      const key = encoded !== null && Buffer.byteLength(encoded) <= this.limits.keyBytes ? encoded : null;
      let entry = key ? this.completed.get(key) : null;
      if (entry && key && entry.expiresAt <= this.now()) { this.evict(key, "expiry"); entry = null; }
      if (entry && key) {
        this.stats.hit += 1; this.completed.delete(key); this.completed.set(key, entry);
        entry.refs += 1; sub.entry = entry;
        return this.respond(res, entry.body, sub);
      }
      if (this.waiting >= this.limits.waiting) throw this.busy();
      let task = key ? this.pending.get(key) : null;
      if (task && task.subs.size >= this.limits.subscribers) throw this.busy();
      if (!task) {
        this.stats.miss += 1; if (!key) this.stats.bypass += 1;
        task = { owner, key: key || `uncached:${++this.serial}`, cacheKey: key, snapshot, work,
          subs: new Set(), started: false, serialize: (/** @type {any} */ value) => serialize(req, value), releaseResponse: null };
        if (key) this.pending.set(key, task);
        this.queue.push(task);
      } else this.stats.join += 1;
      sub.task = task; sub.queued = true; this.waiting += 1; task.subs.add(sub);
      const packet = await new Promise((resolve, reject) => {
        sub.reject = reject;
        Object.assign(sub, { resolve });
        if (!task.started) {
          sub.timer = setTimeout(() => { if (!task.started && sub.active) { reject(this.busy()); close(); } }, this.limits.queueMs);
          sub.timer.unref?.();
        }
        this.drain();
      });
      if (sub.active && !res.destroyed) {
        // Promise delivery is another scheduling boundary: a write may have
        // retired the task after it resolved but before this subscriber sends.
        if (!this.revisions.sameGeneration(task.snapshot)) throw this.retired();
        return this.respond(res, /** @type {Buffer|string} */ (packet), sub);
      }
    } catch (error) {
      close();
      if (!res.destroyed && /** @type {any} */ (error).status === 503) res.set("Retry-After", "1");
      throw error;
    }
  }
  /** @param {any} res @param {Buffer|string} body @param {any} sub */
  respond(res, body, sub) {
    sub.responseTimer = setTimeout(() => res.destroy(), this.limits.responseMs); sub.responseTimer.unref?.();
    res.status(200).set("Cache-Control", "private, no-store").set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Length", String(Buffer.byteLength(body)));
    // res.end avoids Express's implicit freshness/304 branch. Conditional
    // browser body caching is a separate, explicitly unfinished slice.
    return res.end(body);
  }
  drain() {
    while (this.active < this.limits.active) {
      const index = this.queue.findIndex((task) => !task.subs.size || (this.ownerActive.get(task.owner) || 0) < this.limits.ownerActive);
      if (index < 0) return;
      const task = this.queue.splice(index, 1)[0];
      if (!task.subs.size) { if (this.pending.get(task.key) === task) this.pending.delete(task.key); continue; }
      task.started = true; this.active += 1; this.ownerActive.set(task.owner, (this.ownerActive.get(task.owner) || 0) + 1);
      for (const sub of task.subs) clearTimeout(sub.timer);
      void this.perform(task);
    }
  }
  /** @param {any} task */
  async perform(task) {
    const allowance = this.limits.entryBytes + (task.cacheKey ? Buffer.byteLength(task.cacheKey) : 0);
    let reserved = false;
    try {
      this.reserve(allowance); reserved = true;
      const value = await task.work();
      // A deleted identity must not receive a delayed private response.
      const latest = await this.revisions.snapshot(task.owner);
      if (!this.revisions.sameGeneration(task.snapshot) || !this.revisions.sameGeneration(latest)) throw this.retired();
      const text = task.serialize(value), size = Buffer.byteLength(text);
      if (!this.revisions.sameGeneration(task.snapshot) || !this.revisions.sameGeneration(latest)) throw this.retired();
      this.reserved -= allowance; reserved = false;
      if (!task.subs.size) return;
      const keep = !!task.cacheKey && this.revisions.current(task.snapshot) && this.revisions.current(latest);
      if (task.cacheKey && !keep) this.stats.late_fill += 1;
      if (size > this.limits.entryBytes) {
        this.stats.oversize += 1;
        // An oversized baseline response is not retained; keep its compute
        // permit until every slow response has finished or closed.
        const done = new Promise((resolve) => { task.releaseResponse = () => resolve(undefined); });
        for (const sub of task.subs) { this.deliver(sub, text); }
        await done;
      } else {
        const body = Buffer.from(text), charge = body.length + (task.cacheKey ? Buffer.byteLength(task.cacheKey) : 0);
        const entry = { owner: task.owner, body, charge, refs: task.subs.size, cached: keep,
          expiresAt: this.now() + this.limits.ttlMs, freed: false };
        this.bytes += charge;
        if (keep) {
          while (this.completed.size >= this.limits.entries) this.evict(this.completed.keys().next().value || "");
          this.completed.set(task.cacheKey, entry);
        } else this._retiredBytes = this.retiredPinnedBytes + charge;
        for (const sub of task.subs) { sub.entry = entry; this.deliver(sub, body); }
      }
    } catch (error) {
      for (const sub of task.subs) sub.reject?.(error);
    } finally {
      if (reserved) this.reserved -= allowance;
      if (this.pending.get(task.key) === task) this.pending.delete(task.key);
      this.active -= 1;
      const count = (this.ownerActive.get(task.owner) || 1) - 1;
      if (count) this.ownerActive.set(task.owner, count); else this.ownerActive.delete(task.owner);
      this.drain();
    }
  }
  /** @param {any} sub @param {Buffer|string} body */
  deliver(sub, body) {
    if (sub.queued) { sub.queued = false; this.waiting -= 1; }
    sub.reject = null; sub.resolve(body);
  }
}
/** Match Express JSON defaults/options without sharing mutable DTOs.
 * @param {any} req @param {any} value @returns {string} */
function serialize(req, value) {
  let text = JSON.stringify(value, req.app.get("json replacer"), req.app.get("json spaces"));
  if (text === undefined) throw new Error("user_cache_invalid_json");
  if (req.app.get("json escape")) text = text.replace(/[<>&]/g, (character) => character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026");
  return text;
}
module.exports = { UserCache, ALLOWED_ROUTES, LIMITS };
