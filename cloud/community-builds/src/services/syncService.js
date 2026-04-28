"use strict";

const { LIMITS } = require("../constants");
const { toPublic, clampPageSize } = require("./buildSerialiser");

/**
 * Incremental sync diff: clients pass a "since" epoch ms and receive
 * upserts (created/updated since then) and deletes (soft-deleted since then).
 */
class SyncService {
  /** @param {{ builds: import('mongodb').Collection }} db */
  constructor(db) {
    this.builds = db.builds;
  }

  /**
   * @param {{ since?: unknown, limit?: unknown }} query
   * @param {number} now
   * @returns {Promise<{ upserts: object[], deletes: string[], serverNow: number }>}
   */
  async diff(query, now) {
    const since = parseEpoch(query.since);
    const limit = clampPageSize(query.limit);
    const upserts = await this.builds
      .find({
        deletedAt: null,
        flagged: { $lte: LIMITS.FLAG_HIDE_THRESHOLD },
        updatedAt: { $gt: since },
      })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    const deletes = await this.builds
      .find({ deletedAt: { $gt: since } })
      .project({ id: 1, _id: 0 })
      .limit(limit)
      .toArray();
    return {
      upserts: upserts.map((d) => /** @type {object} */ (toPublic(d))),
      deletes: deletes.map((d) => /** @type {string} */ (d.id)),
      serverNow: now,
    };
  }
}

/** @param {unknown} raw @returns {number} */
function parseEpoch(raw) {
  const n = Number.parseInt(String(raw ?? 0), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

module.exports = { SyncService };
