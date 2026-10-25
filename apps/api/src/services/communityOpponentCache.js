"use strict";
const unavailable = () => Object.assign(new Error("community_data_changed"), { status: 503, code: "community_data_changed" });

/** Public aggregate payloads only. This cache never bypasses the caller's
 * current removal/k-floor checks. Two cold materializations, a bounded LRU
 * and a generation fence keep memory and late fills bounded. */
class CommunityOpponentCache {
  /** @param {{now?:()=>number,ttlMs?:number,maxEntries?:number,maxBytes?:number,maxActive?:number}} [options] */
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 64 * 1024;
    this.maxActive = options.maxActive ?? 2;
    this.revision = 0; this.active = 0;
    /** @type {Map<string,{value:any,expiresAt:number}>} */ this.values = new Map();
    /** @type {Map<string,Promise<any>>} */ this.pending = new Map();
  }
  invalidate() { this.revision++; this.values.clear(); this.pending.clear(); }

  /** @template T @param {string} key @param {()=>Promise<T>} load @param {number} revision @returns {Promise<T>} */
  async read(key, load, revision) {
    if (revision !== this.revision) throw unavailable();
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.values.delete(key); this.values.set(key, cached); return cached.value;
    }
    this.values.delete(key);
    const shared = this.pending.get(key); if (shared) return shared;
    if (this.active >= this.maxActive) throw Object.assign(new Error("community_aggregate_busy"), { status: 503, code: "community_aggregate_busy" });
    this.active++;
    const operation = Promise.resolve().then(load).then(value => {
      if (revision !== this.revision) throw unavailable();
      let size = Infinity;
      try { size = Buffer.byteLength(JSON.stringify(value)); } catch { /* Do not cache malformed internal values. */ }
      if (value != null && size <= this.maxBytes) {
        this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
        while (this.values.size > this.maxEntries) {
          const oldest = this.values.keys().next().value; if (oldest === undefined) break;
          this.values.delete(oldest);
        }
      }
      return value;
    }).finally(() => { this.active--; if (this.pending.get(key) === operation) this.pending.delete(key); });
    this.pending.set(key, operation); return operation;
  }
}
module.exports = { CommunityOpponentCache };
