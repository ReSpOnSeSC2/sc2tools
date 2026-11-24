"use strict";

const { randomUUID } = require("crypto");
const {
  globalRowStages, replayKeyExpr, replayFileKeyExpr, GLOBAL_DEDUPE_ORDER,
} = require("./adminGlobalTrendsScope");

const HISTORY_COLLECTION = "admin_global_trends_history";
const HISTORY_FRESH_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const HISTORY_BUILD_TIMEOUT_MS = 60000;
const DUPLICATE_DELETE_BATCH = 5000;

/** GLOBAL_DEDUPE_ORDER on stored rows, where the source game id is
 * _globalSourceId. */
const STORED_DEDUPE_ORDER = Object.freeze(Object.fromEntries(Object.entries(GLOBAL_DEDUPE_ORDER)
  .map(([field, direction]) => [field === "_id" ? "_globalSourceId" : field, direction])));

/** The two deduplication passes, in order: per replay id, then per replay
 * file among the survivors. Each key's index lists the snapshot, the key and
 * then STORED_DEDUPE_ORDER, so the index supplies the window's sort.
 * Atlas Flex caps an in-memory sort at 32 MB and cannot spill to disk. */
const DEDUPE_PASSES = Object.freeze([
  Object.freeze({ key: "_globalReplayKey", index: "global_trends_dedupe_replay" }),
  Object.freeze({ key: "_globalFileKey", index: "global_trends_dedupe_file" }),
]);

/** @param {string} snapshotId @param {string} key
 * @returns {Array<Record<string, any>>} */
function duplicateRowsPipeline(snapshotId, key) {
  return [
    // Nothing between this $match and the window: the window's sort is then
    // pushed down to, and supplied by, the hinted index (no blocking sort).
    { $match: { _globalSnapshotId: snapshotId } },
    { $setWindowFields: {
      partitionBy: `$${key}`, sortBy: STORED_DEDUPE_ORDER,
      // Every row after the first of its key is a duplicate. $documentNumber
      // would need a single sort key; $shift needs no buffering either.
      output: { _globalDuplicate: { $shift: { output: true, by: -1, default: false } } },
    } },
    { $match: { _globalDuplicate: true } },
    { $project: { _id: 1 } },
  ];
}

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
        for (const { key, index } of DEDUPE_PASSES) {
          await this.collection.createIndex({ _globalSnapshotId: 1, [key]: 1, ...STORED_DEDUPE_ORDER }, { name: index });
        }
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
      await this.execute(async () => {
        // Building all rows is a once-per-snapshot write, not a chart read.
        // Its commands share one deadline, which starts once admitted. Driver
        // CSOT replaces the client's 30s socket timer and bounds both server
        // work and the response to it. No allowDiskUse: Atlas Flex does not
        // support it, and no stage here sorts or groups the corpus in memory.
        const deadline = Date.now() + HISTORY_BUILD_TIMEOUT_MS;
        const remaining = () => {
          const ms = Math.max(1, deadline - Date.now());
          return { maxTimeMS: ms, timeoutMS: ms };
        };
        await this.db.games.aggregate([
          ...globalRowStages(),
          { $set: {
            _globalSnapshotId: id, _globalExpiresAt: new Date(Date.now() + HISTORY_TTL_MS),
            _globalSourceId: "$_id",
            _globalReplayKey: { player: "$_globalPlayerId", replay: replayKeyExpr() },
            _globalFileKey: { player: "$_globalPlayerId", file: replayFileKeyExpr() },
            _id: { generation: id, source: "$_id" },
          } },
          // Every generation has fresh IDs, so bulk inserts avoid an upsert
          // lookup per replay. A collision fails the unpublished generation.
          { $merge: { into: HISTORY_COLLECTION, on: "_id", whenMatched: "fail", whenNotMatched: "insert" } },
        ], remaining()).toArray();
        // Keep the rows globalHistoryStages() keeps: the first of each key by
        // GLOBAL_DEDUPE_ORDER, per replay id and then per replay file.
        for (const { key, index } of DEDUPE_PASSES) {
          const duplicates = await this.collection.aggregate(duplicateRowsPipeline(id, key), { ...remaining(), hint: index }).toArray();
          for (let start = 0; start < duplicates.length; start += DUPLICATE_DELETE_BATCH) {
            const ids = duplicates.slice(start, start + DUPLICATE_DELETE_BATCH).map((row) => row._id);
            await this.collection.deleteMany({ _globalSnapshotId: id, _id: { $in: ids } });
          }
        }
      });
    } catch (err) {
      // A failed build can leave a partial generation. It is never published.
      await this.collection.deleteMany({ _globalSnapshotId: id }).catch(() => {});
      // The passes hint their indexes: re-ensure them (createIndex is
      // idempotent) in case an index or the collection was dropped.
      this.indexes = null;
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

module.exports = {
  GlobalTrendsHistory, HISTORY_COLLECTION, HISTORY_FRESH_MS, HISTORY_TTL_MS, HISTORY_BUILD_TIMEOUT_MS,
  DEDUPE_PASSES, STORED_DEDUPE_ORDER, duplicateRowsPipeline,
};
