"use strict";

/**
 * Fixed-window express-rate-limit store with an explicit LRU cardinality cap.
 * Callers should still supply hashed or internal keys, never credentials.
 */
class BoundedRateLimitStore {
  /** @param {{maxEntries?: number}} [opts] */
  constructor(opts = {}) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries || 1024));
    this.windowMs = 60_000;
    this.localKeys = true;
    /** @type {Map<string, {totalHits: number, resetTime: Date}>} */
    this.entries = new Map();
  }

  /** @param {{windowMs?: number}} options */
  init(options) {
    this.windowMs = Math.max(1, Number(options?.windowMs) || 60_000);
  }

  /** @param {string} key */
  async increment(key) {
    const now = Date.now();
    this._prune(now);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
    } else {
      this.entries.delete(key);
    }
    entry.totalHits += 1;
    this.entries.set(key, entry);
    this._trim();
    return { totalHits: entry.totalHits, resetTime: entry.resetTime };
  }

  /** @param {string} key */
  async decrement(key) {
    const entry = this.entries.get(key);
    if (entry) entry.totalHits = Math.max(0, entry.totalHits - 1);
  }

  /** @param {string} key */
  async resetKey(key) {
    this.entries.delete(key);
  }

  async resetAll() {
    this.entries.clear();
  }

  /** @param {number} now */
  _prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.resetTime.getTime() <= now) this.entries.delete(key);
    }
  }

  _trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}

module.exports = { BoundedRateLimitStore };
