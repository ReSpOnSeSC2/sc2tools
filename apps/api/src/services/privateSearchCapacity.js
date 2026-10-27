"use strict";

const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 60;
const MAX_ACTIVE = 2;
const MAX_OWNERS = 4096;
/** @param {number|undefined} value @param {number} maximum */
const limit = (value, maximum) => Number.isSafeInteger(value) && Number(value) > 0
  ? Math.min(Number(value), maximum) : maximum;

/** @param {string} code @param {number} status @param {number} [retryAfter] */
function capacityError(code, status, retryAfter = 1) {
  return Object.assign(new Error(code), { code, status, retryAfter });
}

/** No waiting queue, result cache or joins. A worker owns its permit until
 * its actual reads and cleanup settle, including after an HTTP deadline. */
class PrivateSearchCapacity {
  /** @param {{now?:()=>number,maxActive?:number,maxOwners?:number}} [options] */
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.maxActive = limit(options.maxActive, MAX_ACTIVE);
    this.maxOwners = limit(options.maxOwners, MAX_OWNERS);
    /** @type {Map<string,object>} */ this.active = new Map();
    /** @type {Map<string,{until:number,count:number}>} */ this.rates = new Map();
  }

  /** @param {string} owner @returns {()=>void} */
  acquire(owner) {
    if (typeof owner !== "string" || !owner || owner.length > 200) {
      throw capacityError("private_search_invalid_owner", 401);
    }
    this.charge(owner);
    if (this.active.has(owner) || this.active.size >= this.maxActive) {
      throw capacityError("private_search_busy", 503);
    }
    const ticket = {};
    this.active.set(owner, ticket);
    return () => {
      if (this.active.get(owner) === ticket) this.active.delete(owner);
    };
  }

  /** Busy attempts count too; unexpired buckets are never evicted to make
   * room for a different owner and silently reset the account limit.
   * @param {string} owner */
  charge(owner) {
    const now = this.now();
    let bucket = this.rates.get(owner);
    if (bucket && bucket.until <= now) { this.rates.delete(owner); bucket = undefined; }
    if (!bucket) {
      if (this.rates.size >= this.maxOwners) {
        for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
      }
      if (this.rates.size >= this.maxOwners) throw capacityError("private_search_busy", 503);
      bucket = { until: now + WINDOW_MS, count: 0 };
      this.rates.set(owner, bucket);
    }
    if (bucket.count >= REQUESTS_PER_WINDOW) {
      throw capacityError("private_search_rate_limited", 429, Math.max(1, Math.ceil((bucket.until - now) / 1000)));
    }
    bucket.count += 1;
  }

  /** @template T @param {string} owner @param {()=>Promise<T>} work @returns {Promise<T>} */
  async run(owner, work) {
    const release = this.acquire(owner);
    let reusable = true;
    try { return await work(); }
    catch (error) {
      // A failed cursor-close proof must not open another lane over a
      // possibly surviving reader. Keep this slot unavailable until restart.
      reusable = !(error && typeof error === "object" && "code" in error
        && error.code === "private_search_cleanup_failed");
      throw error;
    } finally { if (reusable) release(); }
  }

  capacitySnapshot() {
    return { active: this.active.size, maximumActive: this.maxActive,
      rateBuckets: this.rates.size, maximumRateBuckets: this.maxOwners,
      requestsPerWindow: REQUESTS_PER_WINDOW, windowMs: WINDOW_MS, queued: 0, cached: 0 };
  }
}

module.exports = { PrivateSearchCapacity };
