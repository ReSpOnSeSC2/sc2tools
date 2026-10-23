"use strict";

/**
 * Database backup health for the admin Health page and the stale-backup
 * alert.
 *
 * Two kinds of backup exist and this service reports both:
 *
 *   - Atlas Cloud Backup: scheduled snapshots of the whole cluster, read
 *     through the existing read-only Atlas service account
 *     (AtlasInfrastructureClient.backupStatus). Results are cached for ten
 *     minutes and refreshed single-flight, so the admin page and the hourly
 *     alert check never fan out into repeated Atlas calls.
 *   - In-app snapshots: the per-user copies people take in Settings →
 *     Backups (``user_backups``). Counted with index/metadata reads only;
 *     the snapshot payloads are never scanned.
 *
 * Everything fails soft. Missing credentials report ``not_configured``, a
 * service account without Project Read Only reports
 * ``atlas_backup_forbidden``, and any other Atlas failure reports
 * ``atlas_backup_unavailable`` (or the last good result, marked stale).
 */

const { EVENT_TYPES } = require("./adminEvents");

const CACHE_TTL_MS = 10 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const QUERY_TIMEOUT_MS = 5 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Snapshot-age bands. Atlas takes one snapshot a day under the default
 * policy, so a day plus two hours of slack is on time, a missed day is
 * late, and two missed days is overdue (and raises the admin alert).
 */
const FRESH_MAX_HOURS = 26;
const AGING_MAX_HOURS = 50;

/** @typedef {"fresh"|"aging"|"stale"|"missing"|"unknown"} BackupFreshness */

class BackupStatusService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   atlasClient?: { backupStatus: () => Promise<Record<string, any>> } | null,
   *   adminEvents?: import('./adminEvents').AdminEventsService | null,
   *   logger?: import('pino').Logger | null,
   *   now?: () => Date,
   *   cacheTtlMs?: number,
   *   errorRetryMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.db) throw new Error("BackupStatusService: db required");
    this.db = deps.db;
    this.atlas = deps.atlasClient || null;
    this.adminEvents = deps.adminEvents || null;
    this.logger = deps.logger || null;
    this.now = deps.now || (() => new Date());
    this.cacheTtlMs = positiveMs(deps.cacheTtlMs, CACHE_TTL_MS);
    this.errorRetryMs = positiveMs(deps.errorRetryMs, ERROR_RETRY_MS);

    /** @type {{ value: Record<string, any>, checkedAt: string } | null} */
    this._lastGood = null;
    this._freshUntil = 0;
    /** @type {string | null} */
    this._lastErrorCode = null;
    this._retryAfter = 0;
    /** @type {Promise<void> | null} */
    this._inflight = null;
    /** @type {string | null} UTC day of the last alert this process raised */
    this._alertedDay = null;
  }

  /** True when an Atlas service account is configured. */
  isConfigured() {
    return Boolean(this.atlas);
  }

  /**
   * Admin payload: Atlas snapshot health plus in-app snapshot counts.
   * Never throws for provider trouble; a Mongo failure on the counts
   * leaves ``inApp`` null instead of hiding the Atlas card.
   */
  async adminSnapshot() {
    const [atlas, inApp] = await Promise.all([
      this.atlasStatus(),
      this.inAppCounts().catch((err) => {
        if (this.logger) this.logger.warn({ err }, "backup_in_app_counts_failed");
        return null;
      }),
    ]);
    return {
      asOf: this._now().toISOString(),
      thresholds: {
        freshMaxHours: FRESH_MAX_HOURS,
        agingMaxHours: AGING_MAX_HOURS,
      },
      atlas,
      inApp,
    };
  }

  /**
   * Cached Atlas backup status with freshness worked out at read time, so
   * a cached result still ages correctly between refreshes.
   */
  async atlasStatus() {
    if (!this.atlas) return unavailableAtlasBackup("not_configured");
    const nowMs = this._now().getTime();
    const due = nowMs >= this._freshUntil && nowMs >= this._retryAfter;
    if (due) await this._refreshOnce();
    if (this._lastGood) {
      return this._present(
        this._lastGood.value,
        this._lastGood.checkedAt,
        this._lastErrorCode,
      );
    }
    return unavailableAtlasBackup(
      this._lastErrorCode || "atlas_backup_unavailable",
    );
  }

  /**
   * Counts for the snapshots people take in Settings → Backups. Uses the
   * collection's metadata count, a DISTINCT_SCAN on the userId index and a
   * single _id-ordered read, so it stays cheap however large the snapshot
   * payloads grow.
   */
  async inAppCounts() {
    const coll = this.db.userBackups;
    const [snapshotCount, userIds, newest, storageBytes] = await Promise.all([
      coll.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS }),
      coll.distinct("userId", {}, { maxTimeMS: QUERY_TIMEOUT_MS }),
      coll
        .find({}, { projection: { _id: 0, createdAt: 1 } })
        .sort({ _id: -1 })
        .limit(1)
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .next(),
      this._userBackupsStorageBytes(),
    ]);
    const newestAt = newest && newest.createdAt instanceof Date
      ? newest.createdAt.toISOString()
      : null;
    return {
      snapshotCount: Number(snapshotCount) || 0,
      userCount: Array.isArray(userIds) ? userIds.length : 0,
      newestAt,
      storageBytes,
    };
  }

  /**
   * Raise one ``backup_stale`` admin event per UTC day while the newest
   * Atlas snapshot is overdue or there is none. Only a fresh Atlas answer
   * counts: a last-good result served during an outage could miss a newer
   * snapshot, and an unreadable status is shown on the admin page instead.
   *
   * @returns {Promise<{ alerted: boolean, reason: string }>}
   */
  async checkAndAlert() {
    if (!this.adminEvents) return { alerted: false, reason: "no_event_feed" };
    const status = await this.atlasStatus();
    if (!status.available || status.stale) {
      return { alerted: false, reason: status.errorCode || "unavailable" };
    }
    if (status.freshness !== "stale" && status.freshness !== "missing") {
      return { alerted: false, reason: status.freshness };
    }
    const day = this._now().toISOString().slice(0, 10);
    if (this._alertedDay === day) return { alerted: false, reason: "already_alerted" };
    // The ingestion key makes the event unique per day across restarts and
    // instances; record() returns the existing row for a repeat.
    const doc = await this.adminEvents.record(
      EVENT_TYPES.BACKUP_STALE,
      {
        reason: status.freshness,
        lastSnapshotAt: status.lastSnapshotAt,
        ageHours: status.ageHours,
        latestStatus: status.latestStatus,
      },
      { ingestionKey: `backup_stale:${day}` },
    );
    if (!doc) return { alerted: false, reason: "record_failed" };
    this._alertedDay = day;
    return { alerted: true, reason: status.freshness };
  }

  async _refreshOnce() {
    if (this._inflight) return this._inflight;
    const pending = this._refresh();
    this._inflight = pending;
    try {
      await pending;
    } finally {
      if (this._inflight === pending) this._inflight = null;
    }
  }

  async _refresh() {
    const atlas = this.atlas;
    if (!atlas) return;
    try {
      const raw = await atlas.backupStatus();
      const nowMs = this._now().getTime();
      this._lastGood = {
        value: raw && typeof raw === "object" ? raw : {},
        checkedAt: new Date(nowMs).toISOString(),
      };
      this._freshUntil = nowMs + this.cacheTtlMs;
      this._lastErrorCode = null;
      this._retryAfter = 0;
    } catch (err) {
      this._lastErrorCode = backupErrorCode(err);
      this._freshUntil = 0;
      this._retryAfter = this._now().getTime() + this.errorRetryMs;
      if (this.logger) {
        this.logger.warn({ code: this._lastErrorCode }, "atlas_backup_status_failed");
      }
    }
  }

  /**
   * @param {Record<string, any>} value
   * @param {string} checkedAt
   * @param {string|null} errorCode set when this is a last-good result
   */
  _present(value, checkedAt, errorCode) {
    const lastSnapshotAt = typeof value.lastSnapshotAt === "string"
      ? value.lastSnapshotAt
      : null;
    const nowMs = this._now().getTime();
    const ageHours = snapshotAgeHours(lastSnapshotAt, nowMs);
    return {
      configured: true,
      available: true,
      stale: errorCode !== null,
      checkedAt,
      errorCode,
      freshness: backupFreshness(ageHours),
      ageHours,
      lastSnapshotAt,
      latestStatus: typeof value.latestStatus === "string"
        ? value.latestStatus
        : null,
      completedSnapshotCount: Number(value.completedSnapshotCount) || 0,
      nextSnapshotAt: typeof value.nextSnapshotAt === "string"
        ? value.nextSnapshotAt
        : null,
      retention: Array.isArray(value.retention) ? value.retention : [],
      cloudBackupEnabled: typeof value.cloudBackupEnabled === "boolean"
        ? value.cloudBackupEnabled
        : null,
      pointInTime: {
        enabled: typeof value.pointInTime?.enabled === "boolean"
          ? value.pointInTime.enabled
          : null,
        windowDays: Number.isSafeInteger(value.pointInTime?.windowDays)
          ? value.pointInTime.windowDays
          : null,
      },
    };
  }

  async _userBackupsStorageBytes() {
    try {
      const stats = await this.db.db.command({
        collStats: this.db.userBackups.collectionName,
        maxTimeMS: QUERY_TIMEOUT_MS,
      });
      const bytes = Number(stats?.storageSize);
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    } catch (/** @type {any} */ err) {
      // A fresh deploy has no user_backups collection until the first
      // snapshot is taken.
      if (err && err.codeName === "NamespaceNotFound") return 0;
      return null;
    }
  }

  _now() {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("BackupStatusService: now() returned invalid date");
    }
    return new Date(value.getTime());
  }
}

/**
 * Hours since the newest completed snapshot, one decimal. A timestamp
 * slightly in the future (clock skew) counts as zero.
 *
 * @param {string|null} lastSnapshotAt
 * @param {number} nowMs
 * @returns {number|null}
 */
function snapshotAgeHours(lastSnapshotAt, nowMs) {
  if (!lastSnapshotAt) return null;
  const takenMs = new Date(lastSnapshotAt).getTime();
  if (!Number.isFinite(takenMs)) return null;
  return Math.round(Math.max(0, nowMs - takenMs) / HOUR_MS * 10) / 10;
}

/**
 * @param {number|null} ageHours null when Atlas has no completed snapshot
 * @returns {BackupFreshness}
 */
function backupFreshness(ageHours) {
  if (ageHours === null) return "missing";
  if (ageHours < FRESH_MAX_HOURS) return "fresh";
  if (ageHours < AGING_MAX_HOURS) return "aging";
  return "stale";
}

/**
 * Reduce an Atlas client failure to a stable, credential-free code. A 401
 * or 403 on the token or the API means the service account is missing the
 * Project Read Only role (or its secret is wrong).
 *
 * @param {unknown} err
 */
function backupErrorCode(err) {
  const code = String(/** @type {any} */ (err)?.code || "");
  if (/_http_(401|403)$/.test(code)) return "atlas_backup_forbidden";
  return "atlas_backup_unavailable";
}

/** @param {string} errorCode */
function unavailableAtlasBackup(errorCode) {
  return {
    configured: errorCode !== "not_configured",
    available: false,
    stale: false,
    checkedAt: null,
    errorCode,
    freshness: /** @type {BackupFreshness} */ ("unknown"),
    ageHours: null,
    lastSnapshotAt: null,
    latestStatus: null,
    completedSnapshotCount: 0,
    nextSnapshotAt: null,
    retention: [],
    cloudBackupEnabled: null,
    pointInTime: { enabled: null, windowDays: null },
  };
}

/** @param {number|undefined} value @param {number} fallback */
function positiveMs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

module.exports = {
  BackupStatusService,
  FRESH_MAX_HOURS,
  AGING_MAX_HOURS,
  _internals: {
    backupErrorCode,
    backupFreshness,
    snapshotAgeHours,
  },
};
