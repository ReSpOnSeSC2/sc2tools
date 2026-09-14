"use strict";

const { DETAIL_VERSION, DETAIL_READ_FIELDS, extractDetailSummary } = require("./trendsExplorerDetail");
const BACKFILL_SORT = Object.freeze({ date: -1, _id: -1 });

/** @returns {Record<string, any>} */
function pendingSummaryMatch() {
  return { $or: [
    { "trendsExplorerDetail.version": { $ne: DETAIL_VERSION } },
    { "trendsExplorerDetail.build": { $exists: false } },
    { "trendsExplorerDetail.bases": { $exists: false } },
    { "trendsExplorerDetail.leads": { $exists: false } },
    { "trendsExplorerDetail.ratings": { $exists: false } },
  ] };
}

/**
 * Resumable bounded history materialization. Every read uses the ordinary
 * details abstraction, including its R2 admission gate and Mongo fallback.
 * One batch is resident at a time; failed object reads remain pending, and a
 * compare-and-set prevents a background result from replacing fresh ingest.
 */
class TrendsExplorerBackfill {
  /** @param {{db:{gameDetails:import('mongodb').Collection},gameDetails:import('./gameDetails').GameDetailsService,logger?:any}} deps */
  constructor(deps) {
    this.collection = deps.db.gameDetails;
    this.details = deps.gameDetails;
    this.externalStore = /** @type {any} */ (deps.gameDetails.store)?.kind === "r2";
    this.logger = deps.logger;
    /** @type {{date:any,id:any}|null} */
    this.after = null;
    /** @type {Promise<string>|null} */
    this.indexReady = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {AbortController|null} */
    this.controller = null;
    /** @type {Promise<void>|null} */
    this.pendingTick = null;
    this.running = false;
    this.stopped = true;
    this.progress = { scanned: 0, updated: 0, failed: 0, conflicts: 0 };
    this.completionLogged = false;
  }

  /** @param {{batchSize?:number,signal?:AbortSignal,userId?:string}} [options] */
  async runBatch(options = {}) {
    // R2 projects after decoding the object: read one object at a time and
    // retain at most two projected results even if an operator asks for a
    // large batch. Mongo performs the narrow projection inside the database.
    const batchSize = Math.max(1, Math.min(this.externalStore ? 2 : 200, Math.floor(options.batchSize || 8)));
    await this.ensureIndex();
    if (options.signal?.aborted) throw Object.assign(new Error("trends_explorer_backfill_aborted"), { name: "AbortError" });
    const scope = options.userId ? { userId: options.userId } : {};
    /** @param {{date:any,id:any}|null} after */
    const load = (after) => this.collection.find({ $and: [
      scope, pendingSummaryMatch(),
      ...(after ? [{ $or: [
        { date: { $lt: after.date } },
        { date: after.date, _id: { $lt: after.id } },
      ] }] : []),
    ] }, {
      projection: { _id: 1, date: 1, userId: 1, gameId: 1, trendsExplorerRevision: 1 },
      ...(options.signal ? { signal: options.signal } : {}),
    }).sort(BACKFILL_SORT).hint(BACKFILL_SORT).limit(batchSize).toArray();
    let rows = await load(this.after);
    if (!rows.length && this.after) {
      // Failed reads and concurrent uploads remain pending. Wrap only after
      // the older history pass, so a bad recent object cannot starve history.
      this.after = null;
      rows = await load(null);
    }
    if (!rows.length) return { scanned: 0, updated: 0, failed: 0, conflicts: 0, done: true };
    const last = rows[rows.length - 1];
    this.after = { date: last.date ?? null, id: last._id };
    const result = { scanned: rows.length, updated: 0, failed: 0, conflicts: 0, done: false };
    /** @type {Map<string, any[]>} */
    const users = new Map();
    for (const row of rows) {
      if (typeof row.userId !== "string" || typeof row.gameId !== "string") { result.failed += 1; continue; }
      if (!users.has(row.userId)) users.set(row.userId, []);
      users.get(row.userId)?.push(row);
    }
    for (const [userId, games] of users) {
      if (options.signal?.aborted) throw Object.assign(new Error("trends_explorer_backfill_aborted"), { name: "AbortError" });
      let details;
      try {
        details = await this.details.findMany(userId, games.map((row) => row.gameId), {
          fields: [...DETAIL_READ_FIELDS], concurrency: 1, strict: true, signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        result.failed += games.length;
        this.logger?.warn?.({ error: error instanceof Error ? error.message : "details read failed", games: games.length }, "Trends history batch remains pending");
        continue;
      }
      const operations = games.map((row) => {
        const blob = details.get(row.gameId);
        // Explicit unavailable branches distinguish completed history scans
        // from rows still waiting for extraction. A later source upload
        // atomically replaces only its corresponding branch.
        const summary = extractDetailSummary({ buildLog: blob?.buildLog, macroBreakdown: blob?.macroBreakdown });
        return { updateOne: { filter: {
          _id: row._id, ...pendingSummaryMatch(),
          trendsExplorerRevision: row.trendsExplorerRevision ?? { $exists: false },
        }, update: { $set: { trendsExplorerDetail: summary } } } };
      });
      if (options.signal?.aborted) throw Object.assign(new Error("trends_explorer_backfill_aborted"), { name: "AbortError" });
      const updated = await this.collection.bulkWrite(operations, { ordered: false });
      result.updated += updated.matchedCount;
      result.conflicts += operations.length - updated.matchedCount;
    }
    this.progress.scanned += result.scanned;
    this.progress.updated += result.updated;
    this.progress.failed += result.failed;
    this.progress.conflicts += result.conflicts;
    return result;
  }

  /** Creating the scan index is deferred to the background job. Its first
   * batch and any restarted process reuse the same index; failures retry.
   * @returns {Promise<string>} */
  ensureIndex() {
    if (!this.indexReady) {
      this.indexReady = this.collection.createIndex(BACKFILL_SORT).catch((error) => {
        this.indexReady = null;
        throw error;
      });
    }
    return this.indexReady;
  }

  /** Snapshot counts include all history, without a preview/sample ceiling.
   * @param {string} [userId] */
  async status(userId) {
    const scope = userId ? { userId } : {};
    const [total, pending] = await Promise.all([
      this.collection.countDocuments(scope),
      this.collection.countDocuments({ ...scope, ...pendingSummaryMatch() }),
    ]);
    return { running: this.running, total, pending, complete: total - pending, ...this.progress };
  }

  /** Background startup has a short delay and pauses between batches so replay
   * inspectors and ingest retain access to the shared external-store lane.
   * @param {{batchSize?:number,delayMs?:number,initialDelayMs?:number}} [options] */
  start(options = {}) {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    const delayMs = Math.max(50, options.delayMs ?? 50);
    const batchSize = options.batchSize ?? (this.externalStore ? 2 : 50);
    const tick = async () => {
      if (this.stopped) return;
      this.running = true;
      let nextDelay = delayMs;
      try {
        const result = await this.runBatch({ batchSize, signal: this.controller?.signal });
        if ((result.done && !this.completionLogged) || (result.updated > 0 && Math.floor(this.progress.updated / 1000) !== Math.floor((this.progress.updated - result.updated) / 1000))) {
          this.logger?.info?.({ ...this.progress, complete: result.done }, "Trends history materialization progress");
        }
        this.completionLogged = result.done;
        if (result.done) nextDelay = 5 * 60 * 1000;
        else if (result.failed) nextDelay = Math.max(delayMs, 15000);
      } catch (error) {
        if (!this.stopped) this.logger?.warn?.({ error: error instanceof Error ? error.message : "batch failed" }, "Trends history backfill will retry");
        nextDelay = 30000;
      } finally {
        this.running = false;
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.pendingTick = tick(); }, nextDelay);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { this.pendingTick = tick(); }, Math.max(0, options.initialDelayMs ?? 10000));
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pendingTick;
    this.pendingTick = null;
  }
}

module.exports = { TrendsExplorerBackfill, pendingSummaryMatch };
