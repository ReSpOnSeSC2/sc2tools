"use strict";

const crypto = require("crypto");

/**
 * SnapshotCacheService — Mongo-backed cache for aggregated cohort
 * band data so the snapshot drilldown page never re-runs the full
 * games + game_details fold on every request.
 *
 * Key shape
 * ---------
 * The ``_id`` is a SHA-256 of the canonical cohort key plus a
 * fingerprint of the source row ids — that lets a stale cache row
 * naturally fall over when new games land in the cohort without
 * having to track invalidation explicitly. We surface a separate
 * ``cohortKey`` field for human-readable lookup.
 *
 * TTL
 * ---
 * ``expiresAt`` drives Mongo's built-in TTL eviction (see the index
 * registered in ``db/connect.js``). The nightly precompute cron
 * walks the top cohorts by query volume and refreshes them before
 * they expire, so steady-state misses stay near zero.
 *
 * Concurrency
 * -----------
 * Two requests racing on a cold cache will both compute the same
 * deterministic result; the second write is a no-op upsert that
 * carries the same payload. We use ``findOneAndUpdate`` with
 * upsert: true rather than insertOne to handle this idempotently.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

class SnapshotCacheService {
  /**
   * @param {{ snapshotCohorts: import('mongodb').Collection }} db
   * @param {{ ttlMs?: number, now?: () => Date, logger?: import('pino').Logger }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger;
  }

  /**
   * Build the SHA-256 cache key from the deterministic cohort key
   * and a stable fingerprint of the source game ids. The
   * fingerprint changes when games are added or removed, naturally
   * busting the cache without explicit invalidation.
   *
   * @param {string} cohortKey canonical string from snapshotCohort
   * @param {string[]} gameIds game ids participating in the cohort
   * @returns {{ hash: string, inputGameIdsHash: string }}
   */
  buildHashKey(cohortKey, gameIds) {
    const inputGameIdsHash = hashGameIds(gameIds);
    const hash = crypto
      .createHash("sha256")
      .update(cohortKey)
      .update("|")
      .update(inputGameIdsHash)
      .digest("hex");
    return { hash, inputGameIdsHash };
  }

  /**
   * Fetch a cached cohort row. Returns null on miss.
   *
   * @param {string} hash
   * @returns {Promise<object|null>}
   */
  async get(hash) {
    if (!hash) return null;
    const row = await this.db.snapshotCohorts.findOne({ _id: hash });
    if (!row) return null;
    const now = this.now().getTime();
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) {
      return null;
    }
    return row;
  }

  /**
   * Persist a freshly-computed cohort row. Upsert semantics so a
   * concurrent recompute is safe (last writer wins; both writers
   * produce the same value when the input set is stable).
   *
   * @param {{
   *   hash: string,
   *   cohortKey: string,
   *   mmrBucket: number|null,
   *   scope: string,
   *   sampleSize: number,
   *   cohortTier: number,
   *   ticks: Array<object>,
   *   inputGameIdsHash: string,
   *   metadata?: Record<string, any>,
   * }} payload
   */
  async put(payload) {
    if (!payload.hash) throw new Error("hash required");
    const generatedAt = this.now();
    const expiresAt = new Date(generatedAt.getTime() + this.ttlMs);
    const doc = {
      _id: payload.hash,
      cohortKey: payload.cohortKey,
      mmrBucket: payload.mmrBucket,
      scope: payload.scope,
      sampleSize: payload.sampleSize,
      cohortTier: payload.cohortTier,
      ticks: payload.ticks,
      inputGameIdsHash: payload.inputGameIdsHash,
      metadata: payload.metadata || {},
      generatedAt,
      expiresAt,
    };
    await this.db.snapshotCohorts.findOneAndUpdate(
      { _id: payload.hash },
      { $set: doc },
      { upsert: true, returnDocument: "after" },
    );
    return doc;
  }

  /**
   * Force-evict one row (used by the admin /tools page when a
   * cohort schema change needs a flush) plus by the inputGameIds
   * mismatch path before recomputing.
   *
   * @param {string} hash
   */
  async evict(hash) {
    await this.db.snapshotCohorts.deleteOne({ _id: hash });
  }

  /**
   * Return the oldest N rows by ``generatedAt``. Drives the
   * nightly precompute cron's "refresh the most stale cohort first"
   * walk so the limited time budget hits the rows that need it
   * most.
   *
   * @param {number} limit
   */
  async listOldest(limit) {
    const cap = Math.max(1, Math.min(Math.floor(Number(limit) || 0), 500));
    return this.db.snapshotCohorts
      .find({}, { projection: { _id: 1, cohortKey: 1, scope: 1, mmrBucket: 1 } })
      .sort({ generatedAt: 1 })
      .limit(cap)
      .toArray();
  }
}

/**
 * Stable fingerprint of a game-id set. Order-insensitive (we sort
 * before hashing) so re-running over the same underlying games in a
 * different order still hits the same cache row. SHA-256 truncated
 * to 16 chars — 64 bits of collision resistance is plenty inside a
 * single cohort key namespace.
 *
 * @param {string[]} gameIds
 */
function hashGameIds(gameIds) {
  const sorted = [...gameIds].sort();
  const h = crypto.createHash("sha256");
  for (const id of sorted) {
    h.update(id);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

module.exports = {
  SnapshotCacheService,
  hashGameIds,
  DEFAULT_TTL_MS,
};
