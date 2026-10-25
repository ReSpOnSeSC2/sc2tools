"use strict";
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_ACTIVE = 2;

/** Reuses the existing read-only Pulse client. Six-hour shared results,
 * singleflight and two process-wide cold requests; excess work is unknown
 * until a later visit. No new poller, provider budget or persistent corpus. */
class RivalsPulseService {
  /** @param {{getIntel(id:string):Promise<any>}|undefined} intel @param {()=>number} [now] */
  constructor(intel, now = () => Date.now()) {
    this.intel = intel; this.now = now;
    /** @type {Map<string,{at:number,value:any}>} */ this.cache = new Map();
    /** @type {Map<string,Promise<any>>} */ this.inflight = new Map();
  }
  /** @param {string[]} ids */
  async batch(ids) {
    const unique = [...new Set(ids.filter(id => /^[1-9]\d{0,19}$/.test(id)))].slice(0, 50);
    const entries = await Promise.all(unique.map(async id => [id, await this.get(id)]));
    return Object.fromEntries(entries);
  }
  /** @param {string} id @returns {Promise<any>} */
  async get(id) {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < TTL_MS) { this.cache.delete(id); this.cache.set(id, hit); return hit.value; }
    if (this.inflight.has(id)) return this.inflight.get(id);
    if (!this.intel || this.inflight.size >= MAX_ACTIVE) return null;
    const pending = this.intel.getIntel(id).then(intel => {
      const value = { change: intel?.ratingDelta30d || null, fetchedAt: intel?.fetchedAt || null };
      this.cache.delete(id); this.cache.set(id, { at: this.now(), value });
      while (this.cache.size > MAX_ENTRIES) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
      return value;
    }).catch(() => null).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, pending); return pending;
  }
}
module.exports = { RivalsPulseService, TTL_MS, MAX_ENTRIES, MAX_ACTIVE };
