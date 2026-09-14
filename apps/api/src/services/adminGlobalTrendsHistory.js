"use strict";

const { randomUUID } = require("crypto");
const { globalHistoryStages } = require("./adminGlobalTrendsScope");
const { QUERY_MAX_TIME_MS } = require("./adminGlobalTrendsQueries");

const HISTORY_COLLECTION = "admin_global_trends_history";
const HISTORY_FRESH_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 60 * 1000;

/** @typedef {{id: string, revision: number, readers: number, cleanup: Promise<void> | null}} HistorySnapshot */

/** Materialize dedupe once, so each card reads indexed, slim canonical rows.
 * Generations never modify source games or mix partially built snapshots.
 * Normally only one generation exists; a refresh retains its predecessor
 * until every active reader finishes. TTL removes leftovers after a restart. */
class GlobalTrendsHistory {
  /** @param {import('../db/connect').DbContext} db
   * @param {(work: () => Promise<any>) => Promise<any>} execute */
  constructor(db, execute) {
    this.db = db;
    this.execute = execute;
    this.collection = db.db.collection(HISTORY_COLLECTION);
    /** @type {HistorySnapshot | null} */
    this.current = null;
    /** @type {Promise<HistorySnapshot> | null} */
    this.pending = null;
    /** @type {Set<HistorySnapshot>} */
    this.retired = new Set();
    /** @type {Array<() => void>} */
    this.retiredWaiters = [];
    /** @type {Promise<void> | null} */
    this.indexes = null;
    this.freshUntil = 0;
    this.revision = 0;
  }

  invalidate() { this.freshUntil = 0; this.revision += 1; }

  /** Keep a generation alive for all the sequential queries in one card.
   * @param {(snapshot: HistorySnapshot) => Promise<any>} work */
  async withSnapshot(work) {
    const snapshot = await this._acquire();
    try { return await work(snapshot); } finally {
      snapshot.readers -= 1;
      if (this.retired.has(snapshot)) this._cleanup(snapshot);
    }
  }

  /** @returns {Promise<HistorySnapshot>} */
  _acquire() {
    const requestedRevision = this.revision;
    if (this.current && Date.now() < this.freshUntil) {
      // Reserve before yielding, so a concurrent refresh cannot retire it.
      this.current.readers += 1;
      return Promise.resolve(this.current);
    }
    if (!this.pending) {
      this.pending = this._build().finally(() => { this.pending = null; });
    }
    return this.pending.then((snapshot) => {
      // A refresh during a build must receive a post-refresh generation.
      if (snapshot.revision < requestedRevision) return this._acquire();
      snapshot.readers += 1;
      return snapshot;
    });
  }

  async _ensureIndexes() {
    if (!this.indexes) {
      this.indexes = (async () => {
        await this.collection.createIndex({ _globalSnapshotId: 1, date: 1 });
        await this.collection.createIndex({ _globalSnapshotId: 1, _globalPlayerId: 1, date: 1, gameId: 1 });
        await this.collection.createIndex({ _globalExpiresAt: 1 }, { expireAfterSeconds: 0 });
      })().catch((err) => { this.indexes = null; throw err; });
    }
    return this.indexes;
  }

  async _build() {
    // Bound refresh storage to the current generation and its predecessor.
    // This waits outside the DB admission pool, avoiding nested-slot waits.
    if (this.retired.size) await new Promise((resolve) => this.retiredWaiters.push(() => resolve(undefined)));
    await this._ensureIndexes();
    const id = randomUUID();
    const revision = this.revision;
    try {
      await this.execute(() => this.db.games.aggregate([
        ...globalHistoryStages(),
        { $set: {
          _globalSnapshotId: id, _globalExpiresAt: new Date(Date.now() + HISTORY_TTL_MS),
          _globalSourceId: "$_id",
          _id: { generation: id, source: "$_id" },
        } },
        { $merge: { into: HISTORY_COLLECTION, on: "_id", whenMatched: "replace", whenNotMatched: "insert" } },
      ], { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray());
    } catch (err) {
      // A killed $merge can leave a partial generation. It is never published.
      await this.collection.deleteMany({ _globalSnapshotId: id }).catch(() => {});
      throw err;
    }
    const previous = this.current;
    /** @type {HistorySnapshot} */
    const next = { id, revision, readers: 0, cleanup: null };
    this.current = next;
    this.freshUntil = revision === this.revision ? Date.now() + HISTORY_FRESH_MS : 0;
    if (previous) {
      this.retired.add(previous);
      this._cleanup(previous);
    }
    return next;
  }

  /** @param {HistorySnapshot} snapshot */
  _cleanup(snapshot) {
    if (snapshot.readers || snapshot.cleanup) return;
    snapshot.cleanup = this.collection.deleteMany({ _globalSnapshotId: snapshot.id })
      .then(() => {}, () => {}) // TTL still bounds storage if cleanup is interrupted.
      .finally(() => {
        this.retired.delete(snapshot);
        if (!this.retired.size) for (const ready of this.retiredWaiters.splice(0)) ready();
      });
  }
}

module.exports = { GlobalTrendsHistory, HISTORY_COLLECTION, HISTORY_FRESH_MS, HISTORY_TTL_MS };
