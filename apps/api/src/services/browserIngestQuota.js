"use strict";

/**
 * Per-user daily cap on games accepted from in-browser ingest.
 *
 * Signed-in browsers (Clerk sessions) can now parse replays locally and
 * upload them through POST /v1/games. The desktop agent is naturally rate
 * limited by the replays a player actually produces; a browser is not, so
 * this service keeps one small counter row per user per UTC day in the
 * ``browser_ingest_daily`` collection:
 *
 *   { userId, day: "YYYY-MM-DD" (UTC), count, updatedAt, expiresAt, _schemaVersion }
 *
 * A unique ``{userId, day}`` index makes the ``$inc`` upsert idempotent in
 * shape, and a TTL index on ``expiresAt`` (a few days after the row's UTC
 * day) keeps the collection tiny. Counters live in Mongo rather than an
 * in-process rate-limit store so a deploy or restart cannot reset them.
 * Device-token (agent) uploads never touch this service.
 *
 * The cap is soft by at most one batch per concurrent ingest lane: ``check``
 * reads the counter before a batch and ``record`` adds only the games that
 * were actually accepted afterwards. POST /v1/games already runs one batch
 * at a time per process (REPLAY_INGEST_MAX_ACTIVE), so a user can overshoot
 * only by the batches in flight on other processes (<= 50 games each).
 * Counters only ever grow by positive integers, so they cannot go negative.
 */

const { DEFAULTS, COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;
// Only the current UTC day is ever read. Keeping rows a little longer than
// one day lets a request that straddles midnight still find its own row
// before Mongo's asynchronous TTL monitor reclaims it.
const RETENTION_DAYS = 3;
const DAY_KEY_LENGTH = "YYYY-MM-DD".length;

/**
 * @typedef {{
 *   day: string,
 *   used: number,
 *   limit: number,
 *   remaining: number,
 *   resetAt: Date,
 *   retryAfterSec: number,
 * }} BrowserIngestUsage
 *
 * @typedef {BrowserIngestUsage & { allowed: boolean }} BrowserIngestDecision
 */

class BrowserIngestQuotaService {
  /**
   * Example:
   *   const quota = new BrowserIngestQuotaService(db.browserIngestDaily, { cap: 5000 });
   *
   * @param {import('mongodb').Collection} collection ``browser_ingest_daily``
   * @param {{ cap?: number, now?: () => Date }} [opts] ``now`` is injectable
   *        so tests can roll the UTC day without fake timers.
   */
  constructor(collection, opts = {}) {
    this.collection = collection;
    this.cap = positiveIntegerOr(opts.cap, DEFAULTS.BROWSER_INGEST_DAILY_CAP);
    this.now = typeof opts.now === "function" ? opts.now : () => new Date();
  }

  /**
   * Current UTC-day usage for one user.
   *
   * Example:
   *   const { used, remaining, resetAt } = await quota.usage("u1");
   *
   * @param {string} userId
   * @returns {Promise<BrowserIngestUsage>}
   */
  async usage(userId) {
    const now = this.now();
    const day = utcDayKey(now);
    const row = await this.collection.findOne(
      { userId, day },
      { projection: { _id: 0, count: 1 } },
    );
    // A counter only ever grows by positive integers, but never let a
    // hand-edited or corrupt row hand out more than the cap.
    const used = row && Number.isFinite(row.count) ? Math.max(0, Number(row.count)) : 0;
    const resetAt = nextUtcMidnight(now);
    return {
      day,
      used,
      limit: this.cap,
      remaining: Math.max(0, this.cap - used),
      resetAt,
      retryAfterSec: secondsUntil(now, resetAt),
    };
  }

  /**
   * Would ``incoming`` more games stay within today's cap?
   *
   * Example:
   *   const decision = await quota.check("u1", 50);
   *   if (!decision.allowed) respond429(decision.resetAt);
   *
   * @param {string} userId
   * @param {number} incoming games in the batch about to be processed
   * @returns {Promise<BrowserIngestDecision>}
   */
  async check(userId, incoming) {
    const usage = await this.usage(userId);
    const requested = Math.max(0, Math.floor(Number(incoming) || 0));
    return { ...usage, allowed: usage.used + requested <= usage.limit };
  }

  /**
   * Add ``accepted`` games to a user's counter for ``day`` (default: today).
   * Pass the ``day`` returned by ``check`` so a batch that straddles UTC
   * midnight is billed to the day it was admitted on.
   *
   * Example:
   *   await quota.record("u1", accepted.length, decision.day);
   *
   * @param {string} userId
   * @param {number} accepted
   * @param {string} [day] UTC day key "YYYY-MM-DD"
   * @returns {Promise<void>}
   */
  async record(userId, accepted, day) {
    if (!Number.isInteger(accepted) || accepted <= 0) return;
    const now = this.now();
    const dayKey = isDayKey(day) ? day : utcDayKey(now);
    const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
    await this.collection.updateOne(
      { userId, day: dayKey },
      {
        $inc: { count: accepted },
        $set: { updatedAt: now },
        $setOnInsert: {
          expiresAt: new Date(dayStart + RETENTION_DAYS * MS_PER_DAY),
          _schemaVersion: expectedVersion(COLLECTIONS.BROWSER_INGEST_DAILY),
        },
      },
      { upsert: true },
    );
  }
}

/**
 * UTC calendar day of ``date``.
 * Example: utcDayKey(new Date("2026-09-27T23:59:59Z")) === "2026-09-27"
 * @param {Date} date
 * @returns {string}
 */
function utcDayKey(date) {
  return date.toISOString().slice(0, DAY_KEY_LENGTH);
}

/**
 * The next UTC midnight strictly after ``date``.
 * Example: nextUtcMidnight(new Date("2026-09-27T10:00:00Z")) -> 2026-09-28T00:00:00Z
 * @param {Date} date
 * @returns {Date}
 */
function nextUtcMidnight(date) {
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  return new Date(start + MS_PER_DAY);
}

/**
 * Whole seconds from ``now`` until ``later`` (at least 1, for Retry-After).
 * Example: secondsUntil(t, new Date(t.getTime() + 1500)) === 2
 * @param {Date} now
 * @param {Date} later
 */
function secondsUntil(now, later) {
  return Math.max(1, Math.ceil((later.getTime() - now.getTime()) / MS_PER_SECOND));
}

/**
 * Example: isDayKey("2026-09-27") === true; isDayKey("today") === false
 * @param {unknown} value
 * @returns {value is string}
 */
function isDayKey(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

/**
 * Example: positiveIntegerOr(undefined, 5000) === 5000; positiveIntegerOr(10, 5000) === 10
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

module.exports = {
  BrowserIngestQuotaService,
  utcDayKey,
  nextUtcMidnight,
  RETENTION_DAYS,
};
