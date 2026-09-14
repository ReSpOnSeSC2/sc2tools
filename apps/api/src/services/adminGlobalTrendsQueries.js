"use strict";

const QUERY_MAX_TIME_MS = 25000;
const CACHE_MS = 30000;
const MAX_CACHE_ENTRIES = 96;
const MAX_CONCURRENT_QUERIES = 2;
const MAX_WAITERS = 32;

/** Cache only completed work's age; pending requests always share one promise.
 * This cache is private to the authenticated global-trends service instance. */
class GlobalTrendsQueries {
  constructor() {
    /** @type {Map<string, {expiresAt: number, promise: Promise<any>}>} */
    this.cache = new Map();
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiters = [];
  }

  clear() { this.cache.clear(); }

  /** @param {string} key @param {() => Promise<any>} work @param {number} [ttl] */
  cached(key, work, ttl = CACHE_MS) {
    const previous = this.cache.get(key);
    if (previous && previous.expiresAt > Date.now()) return previous.promise;
    if (previous) this.cache.delete(key);
    for (const [oldKey, entry] of this.cache) {
      if (this.cache.size < MAX_CACHE_ENTRIES) break;
      if (entry.expiresAt !== Infinity) this.cache.delete(oldKey);
    }
    if (this.cache.size >= MAX_CACHE_ENTRIES) return Promise.reject(globalTrendsBusy());
    const entry = { expiresAt: Infinity, promise: /** @type {Promise<any>} */ (Promise.resolve()) };
    entry.promise = Promise.resolve().then(work).then((result) => {
      entry.expiresAt = Date.now() + ttl;
      return result;
    }, (err) => {
      // An explicit refresh may already have installed a newer promise.
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, entry);
    return entry.promise;
  }

  /** Admission surrounds actual DB work, never a parent chart awaiting it.
   * Roster reads and filter/range probes therefore share this same limit.
   * @param {() => Promise<any>} work */
  async execute(work) {
    if (this.active >= MAX_CONCURRENT_QUERIES) {
      if (this.waiters.length >= MAX_WAITERS) throw globalTrendsBusy();
      await new Promise((resolve, reject) => {
        const grant = () => { clearTimeout(timer); resolve(undefined); };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(grant);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(globalTrendsBusy());
        }, QUERY_MAX_TIME_MS);
        this.waiters.push(grant);
      });
    } else this.active += 1;
    try { return await work(); } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** Preserve regex filters when keying Mongo pipelines (JSON alone loses them).
 * @param {unknown} value */
function queryKey(value) {
  return JSON.stringify(value, (_key, item) => item instanceof RegExp
    ? { $regularExpression: { pattern: item.source, options: item.flags } } : item);
}

function globalTrendsBusy() {
  return Object.assign(new Error("Global Trends is busy. Please try again shortly."), {
    status: 503, code: "global_trends_busy", expose: true,
  });
}

module.exports = { GlobalTrendsQueries, QUERY_MAX_TIME_MS, queryKey };
