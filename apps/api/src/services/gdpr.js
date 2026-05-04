"use strict";

/**
 * GDPR service. Three jobs:
 *
 *  1. Export every per-user document we hold as a single JSON archive.
 *  2. Delete every per-user document, hard, on user request.
 *  3. Manual snapshots — point-in-time backups the user can take before
 *     a migration. We store these as a JSON blob inside the existing
 *     `import_jobs`-style collection (small footprint, gives us a
 *     human-restorable record without an extra Atlas snapshot).
 *
 * The export/delete code lives in one place so a future schema change
 * can't accidentally leak old fields or leave behind orphan rows. Every
 * collection that holds user data must be listed in
 * USER_SCOPED_COLLECTIONS — that single source of truth gates both
 * paths.
 */

const USER_SCOPED_COLLECTIONS = [
  // (db key, file/json key)
  ["games", "games"],
  ["opponents", "opponents"],
  ["customBuilds", "customBuilds"],
  ["overlayTokens", "overlayTokens"],
  ["deviceTokens", "deviceTokens"],
  ["mlModels", "mlModels"],
  ["mlJobs", "mlJobs"],
  ["importJobs", "importJobs"],
  ["macroJobs", "macroJobs"],
  ["profiles", "profiles"],
];

class GdprService {
  /**
   * @param {import('../db/connect').DbContext} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Build a JSON archive of every per-user record. Returns an object
   * keyed by collection — caller serializes / streams as needed.
   *
   * @param {string} userId
   * @returns {Promise<{userId: string, exportedAt: string, data: Record<string, object[]>, user: object|null}>}
   */
  async export(userId) {
    /** @type {Record<string, object[]>} */
    const data = {};
    for (const [key, jsonKey] of USER_SCOPED_COLLECTIONS) {
      const coll = /** @type {any} */ (this.db)[key];
      if (!coll) continue;
      data[jsonKey] = await coll
        .find({ userId }, { projection: { _id: 0 } })
        .toArray();
    }
    const user = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0 } },
    );
    return {
      userId,
      exportedAt: new Date().toISOString(),
      user,
      data,
    };
  }

  /**
   * Permanently delete every per-user document including the user
   * record itself. Returns counts so the caller can audit-log them.
   *
   * @param {string} userId
   * @returns {Promise<Record<string, number>>}
   */
  async deleteAll(userId) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const [key] of USER_SCOPED_COLLECTIONS) {
      const coll = /** @type {any} */ (this.db)[key];
      if (!coll) continue;
      const res = await coll.deleteMany({ userId });
      counts[key] = res.deletedCount || 0;
    }
    const userRes = await this.db.users.deleteOne({ userId });
    counts.users = userRes.deletedCount || 0;
    return counts;
  }

  /**
   * Take a manual snapshot. We store the export as a single document
   * in a "user_backups"-style collection scoped to the user — for
   * SC2-Tools volumes (a few hundred MB at most), Mongo handles this
   * fine, and it keeps GDPR export & restore symmetric.
   *
   * @param {string} userId
   * @returns {Promise<{id: string, createdAt: Date, sizeBytes: number}>}
   */
  async snapshot(userId) {
    const exportData = await this.export(userId);
    const json = JSON.stringify(exportData);
    const sizeBytes = Buffer.byteLength(json, "utf8");
    const id = `bk_${Date.now()}_${Math.floor(Math.random() * 1e6)
      .toString(36)
      .padStart(4, "0")}`;
    const doc = {
      id,
      userId,
      createdAt: new Date(),
      sizeBytes,
      type: /** @type {const} */ ("manual"),
      payload: exportData,
    };
    const coll = this.db.db.collection("user_backups");
    await coll.insertOne(doc);
    return { id, createdAt: doc.createdAt, sizeBytes };
  }

  /**
   * @param {string} userId
   * @returns {Promise<{items: Array<{id: string, createdAt: Date, sizeBytes: number, type: string}>}>}
   */
  async listSnapshots(userId) {
    const coll = this.db.db.collection("user_backups");
    const items = await coll
      .find(
        { userId },
        { projection: { _id: 0, id: 1, createdAt: 1, sizeBytes: 1, type: 1 } },
      )
      .sort({ createdAt: -1 })
      .toArray();
    return { items };
  }

  /**
   * Restore from a snapshot — clear current per-user state, then re-insert
   * everything from the snapshot. Atomic insofar as Mongo's batched ops
   * are; we accept the trade-off because the alternative (transactions)
   * forces a replica set on the dev Atlas tier.
   *
   * @param {string} userId
   * @param {string} snapshotId
   */
  async restoreSnapshot(userId, snapshotId) {
    const coll = this.db.db.collection("user_backups");
    const snap = await coll.findOne({ userId, id: snapshotId });
    if (!snap) {
      const err = new Error("snapshot_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    // Clear current data (NOT the user record — the user keeps their id).
    for (const [key] of USER_SCOPED_COLLECTIONS) {
      const c = /** @type {any} */ (this.db)[key];
      if (c) await c.deleteMany({ userId });
    }
    const data = snap.payload?.data || {};
    for (const [key, jsonKey] of USER_SCOPED_COLLECTIONS) {
      const c = /** @type {any} */ (this.db)[key];
      const rows = Array.isArray(data[jsonKey]) ? data[jsonKey] : [];
      if (c && rows.length > 0) {
        await c.insertMany(
          rows.map((r) => ({ ...r, userId })),
          { ordered: false },
        );
      }
    }
    return { restoredAt: new Date(), counts: countsOf(data) };
  }
}

/** @param {Record<string, unknown[]>} data */
function countsOf(data) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = Array.isArray(v) ? v.length : 0;
  }
  return out;
}

module.exports = { GdprService, USER_SCOPED_COLLECTIONS };
