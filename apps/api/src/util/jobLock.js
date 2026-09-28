"use strict";

/**
 * Owner-safe advisory lock with a renewable lease, stored in the shared
 * ``jobLocks`` collection (the pattern of jobs/opponentMmrEnrichmentJob.js,
 * generalised over the key/lease). Used by jobs/guideStatsRecomputeJob.js
 * and jobs/guideSamplesBackfillJob.js; ``isDuplicateKey`` is shared too.
 *
 *   - ``acquire()`` CASes the lock doc from "expired or absent" to a fresh
 *     random owner token; a live holder makes the upsert hit the unique
 *     ``key`` index (E11000) and the call returns null;
 *   - ``extend(owner)`` pushes ``expiresAt`` out by one lease, only while
 *     the caller still owns the lock (false = the lease was lost);
 *   - ``release(owner)`` deletes the doc only when the caller owns it, so
 *     a slow holder can never delete a successor's lock.
 * A crashed holder's lock frees itself after one lease (the CAS reclaims
 * it; the TTL index reaps the doc later).
 *
 * Every lock doc sets ``key``: the collection also holds the health-probe
 * doc ``{ _id: "healthcheck" }``, and the unique ``key`` index allows only
 * one key-less doc.
 */

const { randomUUID } = require("crypto");

const DUPLICATE_KEY_CODE = 11000;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKey(err) {
  const e = /** @type {{code?: unknown, codeName?: unknown}|null} */ (err);
  return Boolean(e && (e.code === DUPLICATE_KEY_CODE || e.codeName === "DuplicateKey"));
}

/**
 * @typedef {object} JobLock
 * @property {() => Promise<void>} ensureIndexes TTL on expiresAt + unique key
 * @property {() => Promise<string|null>} acquire owner token, or null when held elsewhere
 * @property {(owner: string) => Promise<boolean>} extend false when the lease was lost
 * @property {(owner: string) => Promise<void>} release
 */

/**
 * Example:
 *   const lock = buildJobLock({ collection: db.db.collection("jobLocks"), key: "guideStatsRecompute",
 *     leaseMs: 45 * 60_000, now: Date.now });
 *   const owner = await lock.acquire();
 *   if (owner) try { … } finally { await lock.release(owner); }
 *
 * @param {{ collection: import('mongodb').Collection, key: string, leaseMs: number, now: () => number }} deps
 * @returns {JobLock}
 */
function buildJobLock(deps) {
  const { collection, key, leaseMs } = deps;

  async function ensureIndexes() {
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ key: 1 }, { unique: true });
  }

  async function acquire() {
    const owner = randomUUID();
    const now = deps.now();
    try {
      const doc = await collection.findOneAndUpdate(
        { key, $or: [{ expiresAt: { $lte: new Date(now) } }, { expiresAt: { $exists: false } }] },
        { $set: { key, owner, acquiredAt: new Date(now), expiresAt: new Date(now + leaseMs) } },
        { upsert: true, returnDocument: "after" },
      );
      return doc && doc.owner === owner ? owner : null;
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  /** @param {string} owner */
  async function extend(owner) {
    const res = await collection.updateOne(
      { key, owner },
      { $set: { expiresAt: new Date(deps.now() + leaseMs) } },
    );
    return res.matchedCount === 1;
  }

  /** @param {string} owner */
  async function release(owner) {
    await collection.deleteOne({ key, owner });
  }

  return { ensureIndexes, acquire, extend, release };
}

module.exports = { buildJobLock, isDuplicateKey };
