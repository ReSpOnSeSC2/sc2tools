"use strict";

/**
 * Guide samples backfill — admin-triggered, never auto-started.
 *
 * Ingest captures a ``guide_samples`` row for every new eligible game
 * (services/guideSamples.js). Games uploaded before that hook existed only
 * have their build log / unit timeline in ``game_details``; this job walks
 * those rows newest-first and distils them with the same pure
 * ``extractSample``, so the backfilled rows are indistinguishable from
 * ingest-captured ones (same keys, idempotent upsert).
 *
 * Shape (mirrors the other jobs' conventions):
 *   - ``start({ days })`` kicks off one pass over the last ``days`` days
 *     (default 90, max 400) and returns ``status()`` immediately;
 *   - ``stop()`` aborts the pass and resolves once it has unwound;
 *   - ``status()`` reports progress (counts only — no ids or names).
 *
 * Safety:
 *   - throttled to at most 2 games/s (one game per GAME_INTERVAL_MS), one
 *     game resident at a time, so it never competes with ingest for the
 *     detail store;
 *   - owner-safe advisory lock in ``jobLocks`` (the opponentMmrEnrichment
 *     pattern) whose lease is extended every batch, so two API replicas
 *     never run it together and a crashed holder frees it after a lease;
 *   - keyset cursor {date, _id} persisted in ``jobLocks`` under
 *     CURSOR_KEY after every game: pressing start again after a restart
 *     resumes where the last pass stopped. A finished pass is marked done
 *     and the next start begins from the newest game again;
 *   - kill switch SC2TOOLS_GUIDE_BACKFILL_DISABLED=1 (and the samples kill
 *     switch) make ``start`` a no-op that reports ``disabled: true``;
 *   - samples of games that are gone or no longer guide games (custom-build
 *     relabels) are removed, and a sample written for a game a GDPR wipe
 *     removed mid-flight is taken back out (see ``_processGame``).
 *
 * Heavy fields are read through GameDetailsService (R2 admission gate and
 * Mongo fallback included). The store's projection allowlist has no
 * ``macroBreakdown.unit_timeline`` entry, so the whole ``macroBreakdown``
 * is read and only its unit timeline is used.
 */

const { extractSample } = require("../services/guideSamples");
const { isGuideEligibleGame } = require("../services/guideRules");
const { buildJobLock } = require("../util/jobLock");

const LOCK_COLLECTION = "jobLocks";
const LOCK_KEY = "guideSamplesBackfill";
const CURSOR_KEY = "guideSamplesBackfill:cursor";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;
/** ≤ 2 games per second. */
const GAME_INTERVAL_MS = 500;
/** Rows per keyset page; the lease is extended once per page. */
const BATCH_SIZE = 10;
/** Comfortably longer than one page (BATCH_SIZE games incl. slow detail reads). */
const LEASE_MS = 10 * 60 * 1000;
const SCAN_SORT = Object.freeze({ date: -1, _id: -1 });
const DETAIL_FIELDS = Object.freeze(["buildLog", "macroBreakdown"]);
/** Slim games fields extractSample / the eligibility rules read. */
const SLIM_PROJECTION = Object.freeze({
  _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, myBuild: 1, map: 1, durationSec: 1,
  playerCount: 1, matchFormat: 1, isLadderGame: 1, gameVersion: 1, gameBuild: 1,
  isResumedFromReplay: 1, _customBuildSlug: 1,
  "opponent.race": 1, "opponent.leagueId": 1, "opponent.mmr": 1,
});

/**
 * @typedef {object} BackfillStatus
 * @property {boolean} disabled
 * @property {boolean} running
 * @property {number|null} days
 * @property {string|null} since       ISO lower bound of the pass
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {boolean} done            the pass reached the end of the window
 * @property {number} processed
 * @property {number} written
 * @property {number} skipped
 * @property {number} failed
 * @property {string|null} lastError   reason code ("lock_held", "lock_lost", "run_failed")
 */

/** @typedef {{ date: Date, id: import('mongodb').ObjectId }} Cursor */

/**
 * @param {unknown} raw
 * @returns {number} whole days in [1, MAX_DAYS]
 */
function clampDays(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.floor(n));
}

/**
 * Abortable timer (resolves early on abort; never rejects).
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (typeof timer.unref === "function") timer.unref();
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * @typedef {{
 *   db: import('../db/connect').DbContext,
 *   guideSamples: import('../services/guideSamples').GuideSamplesService,
 *   gameDetails: import('../services/gameDetails').GameDetailsService,
 *   logger: import('pino').Logger,
 *   nowFn?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} BackfillDeps
 */

class GuideSamplesBackfillJob {
  /** @param {BackfillDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.envDisabled = process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED === "1";
    this.now = deps.nowFn || Date.now;
    this.sleep = deps.sleep || defaultSleep;
    this.logger = deps.logger.child({ component: "guideSamplesBackfill" });
    this.locks = deps.db.db.collection(LOCK_COLLECTION);
    this.lock = buildJobLock({ collection: this.locks, key: LOCK_KEY, leaseMs: LEASE_MS, now: this.now });
    this.state = freshState();
    /** @type {Promise<void>|null} */
    this.inflight = null;
    /** @type {AbortController|null} */
    this.controller = null;
  }

  /**
   * Start one pass (no-op while running or disabled).
   *
   * @param {{ days?: unknown }} [opts] ``days`` window, default 90, max 400
   * @returns {BackfillStatus}
   */
  start(opts = {}) {
    if (this.isDisabled()) {
      this.logger.info("guide_samples_backfill_disabled");
      return this.status();
    }
    if (this.inflight) return this.status();
    const days = clampDays(opts.days);
    Object.assign(this.state, freshState(), { days, startedAt: new Date(this.now()).toISOString() });
    const controller = new AbortController();
    this.controller = controller;
    this.logger.info({ days }, "guide_samples_backfill_started");
    this.inflight = this._run(days, controller.signal)
      .catch((err) => {
        this.state.lastError = "run_failed";
        this.logger.warn({ code: errorCode(err) }, "guide_samples_backfill_failed");
      })
      .finally(() => {
        this.state.finishedAt = new Date(this.now()).toISOString();
        this.inflight = null;
      });
    return this.status();
  }

  /** Abort the pass and wait for it to unwind. @returns {Promise<BackfillStatus>} */
  async stop() {
    if (this.controller) this.controller.abort();
    if (this.inflight) await this.inflight;
    return this.status();
  }

  /** @returns {BackfillStatus} counts and timestamps only — no ids or names */
  status() {
    return { disabled: this.isDisabled(), running: this.inflight !== null, ...this.state };
  }

  /** @returns {boolean} */
  isDisabled() {
    return this.envDisabled || Boolean(this.deps.guideSamples.disabled);
  }

  /** @param {number} days @param {AbortSignal} signal */
  async _run(days, signal) {
    await this.lock.ensureIndexes().catch((err) => {
      this.logger.warn({ code: errorCode(err) }, "guide_samples_backfill_lock_index_failed");
    });
    const owner = await this.lock.acquire();
    if (!owner) {
      this.state.lastError = "lock_held";
      this.logger.info("guide_samples_backfill_lock_held");
      return;
    }
    try {
      await this.deps.db.gameDetails.createIndex(SCAN_SORT);
      const since = new Date(this.now() - days * DAY_MS);
      this.state.since = since.toISOString();
      await this._walk(owner, since, signal);
    } finally {
      await this.lock.release(owner).catch((err) => {
        this.logger.warn({ code: errorCode(err) }, "guide_samples_backfill_lock_release_failed");
      });
      this.logger.info(countsOf(this.state), "guide_samples_backfill_pass_ended");
    }
  }

  /**
   * Walk the window page by page until done, stopped or the lease is lost.
   *
   * @param {string} owner
   * @param {Date} since
   * @param {AbortSignal} signal
   */
  async _walk(owner, since, signal) {
    let after = await this._loadCursor();
    while (!signal.aborted) {
      if (!(await this.lock.extend(owner))) {
        this.state.lastError = "lock_lost";
        return;
      }
      const rows = await this._loadPage(since, after);
      if (rows.length === 0) {
        this.state.done = true;
        await this._saveCursor(null, true);
        return;
      }
      for (const row of rows) {
        if (signal.aborted) return;
        await this._processRow(row, signal);
        // A stop that interrupted this row leaves the cursor before it, so
        // the resumed pass redoes it (the upsert is idempotent).
        if (signal.aborted) return;
        after = { date: row.date, id: row._id };
        await this._saveCursor(after, false);
        await this.sleep(GAME_INTERVAL_MS, signal);
      }
    }
  }

  /** @param {Date} since @param {Cursor|null} after */
  _loadPage(since, after) {
    const keyset = after
      ? [{ $or: [{ date: { $lt: after.date } }, { date: after.date, _id: { $lt: after.id } }] }]
      : [];
    return this.deps.db.gameDetails
      .find({ $and: [{ date: { $gte: since } }, ...keyset] }, {
        projection: { _id: 1, date: 1, userId: 1, gameId: 1 },
      })
      .sort(SCAN_SORT)
      .hint(SCAN_SORT)
      .limit(BATCH_SIZE)
      .toArray();
  }

  /** @returns {Promise<Cursor|null>} null when there is no unfinished pass */
  async _loadCursor() {
    const doc = await this.locks.findOne({ key: CURSOR_KEY });
    if (!doc || doc.done || !doc.after || !(doc.after.date instanceof Date)) return null;
    return { date: doc.after.date, id: doc.after.id };
  }

  /** @param {Cursor|null} after @param {boolean} done */
  async _saveCursor(after, done) {
    await this.locks.updateOne(
      { key: CURSOR_KEY },
      { $set: { key: CURSOR_KEY, after, done, updatedAt: new Date(this.now()) } },
      { upsert: true },
    );
  }

  /** @param {Record<string, any>} row @param {AbortSignal} signal */
  async _processRow(row, signal) {
    this.state.processed += 1;
    try {
      const outcome = await this._processGame(row, signal);
      this.state[outcome] += 1;
    } catch (err) {
      if (signal.aborted) return;
      this.state.failed += 1;
      this.logger.warn({ code: errorCode(err) }, "guide_samples_backfill_game_failed");
    }
  }

  /**
   * One game: slim row → eligibility → heavy fields → extract → upsert.
   *
   * @param {Record<string, any>} row game_details index row
   * @param {AbortSignal} signal
   * @returns {Promise<"written"|"skipped">}
   */
  async _processGame(row, signal) {
    const { userId, gameId } = row;
    if (typeof userId !== "string" || typeof gameId !== "string") return "skipped";
    const samples = this.deps.guideSamples;
    const game = await this.deps.db.games.findOne({ userId, gameId }, { projection: SLIM_PROJECTION });
    // Eligibility first: ineligible games never cost a detail-store read.
    // A sample left over from an earlier label (a server-side custom-build
    // relabel, a reclassification) or from a vanished game is removed: the
    // slim row is the source of truth the guide aggregate reads.
    if (!game || !isGuideEligibleGame(game)) {
      await samples.removeSample(userId, gameId);
      return "skipped";
    }
    const details = await this.deps.gameDetails.findMany(userId, [gameId], {
      fields: [...DETAIL_FIELDS], concurrency: 1, strict: true, signal,
    });
    const blob = details.get(gameId) || {};
    const sample = extractSample({ ...game, buildLog: blob.buildLog, macroBreakdown: blob.macroBreakdown });
    if ("skip" in sample || !(await samples.writeSample(userId, gameId, sample))) return "skipped";
    // GDPR: a delete/wipe that removed the game after our read has already
    // deleted its samples (games go first, samples after) — so if the game
    // is gone now, the row we just wrote is an orphan: take it back out.
    if (!(await this.deps.db.games.findOne({ userId, gameId }, { projection: { _id: 1 } }))) {
      await samples.removeSample(userId, gameId);
      return "skipped";
    }
    return "written";
  }
}

/**
 * Build the backfill job. Nothing runs until ``start()``.
 *
 * Example: `services.guideSamplesBackfill.start({ days: 90 })`.
 *
 * @param {BackfillDeps} deps
 * @returns {GuideSamplesBackfillJob}
 */
function buildGuideSamplesBackfillJob(deps) {
  if (!deps || !deps.db || !deps.guideSamples || !deps.gameDetails || !deps.logger) {
    throw new Error("buildGuideSamplesBackfillJob: db, guideSamples, gameDetails and logger required");
  }
  return new GuideSamplesBackfillJob(deps);
}

/**
 * @returns {Omit<BackfillStatus, "disabled" | "running">}
 */
function freshState() {
  return {
    days: null, since: null, startedAt: null, finishedAt: null, done: false,
    processed: 0, written: 0, skipped: 0, failed: 0, lastError: null,
  };
}

/** @param {Omit<BackfillStatus, "disabled" | "running">} s */
function countsOf(s) {
  return { processed: s.processed, written: s.written, skipped: s.skipped, failed: s.failed, done: s.done };
}

/**
 * Error code for logs — never the message (detail-store errors can embed
 * object keys that contain user ids).
 *
 * @param {unknown} err
 * @returns {string|number|null}
 */
function errorCode(err) {
  const e = /** @type {{ code?: unknown, name?: unknown }} */ (err || {});
  if (typeof e.code === "string" || typeof e.code === "number") return e.code;
  return typeof e.name === "string" ? e.name : null;
}

module.exports = {
  GuideSamplesBackfillJob,
  buildGuideSamplesBackfillJob,
  __internal: { clampDays, LOCK_KEY, CURSOR_KEY, GAME_INTERVAL_MS, BATCH_SIZE, DEFAULT_DAYS, MAX_DAYS },
};
