"use strict";

const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");

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
   * @param {{
   *   opponents?: import('./opponents').OpponentsService,
   *   logger?: import('pino').Logger,
   * }} [opts]
   *   ``opts.opponents`` lets ``rebuildOpponentsForUser`` immediately
   *   chain a pulse-character-id backfill so the admin "Rebuild
   *   opponents" action both rebuilds counters AND heals missing
   *   pulse ids in one shot. Optional in unit tests that only
   *   exercise export/delete.
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.opponents = (opts && opts.opponents) || null;
    this.logger = (opts && opts.logger) || null;
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
   * Delete the user's replay history without touching their account,
   * custom builds, device pairings, or other configuration. Optional
   * `since` / `until` bound the wipe to a date window — omitting both
   * clears the entire history.
   *
   * After deleting the matching games we recompute the opponents
   * collection from whatever remains. We can't just `$inc` opponents
   * downward because the on-disk counters were arrived at via repeated
   * `recordGame($inc:1)` and we don't know which specific opponent rows
   * each deleted game contributed to. Rebuilding from the surviving
   * games is the only way to keep the counters honest.
   *
   * @param {string} userId
   * @param {{ since?: Date | null, until?: Date | null }} [opts]
   * @returns {Promise<{ games: number, opponents: number, macroJobs: number, range: { since: string|null, until: string|null } }>}
   */
  async wipeGames(userId, opts = {}) {
    const since = opts.since instanceof Date && !Number.isNaN(opts.since.getTime())
      ? opts.since
      : null;
    const until = opts.until instanceof Date && !Number.isNaN(opts.until.getTime())
      ? opts.until
      : null;

    /** @type {Record<string, any>} */
    const filter = { userId };
    if (since || until) {
      /** @type {Record<string, Date>} */
      const range = {};
      if (since) range.$gte = since;
      if (until) range.$lt = until;
      filter.date = range;
    }

    const gamesRes = await this.db.games.deleteMany(filter);
    // Mirror the delete on the split-out ``game_details`` collection
    // so heavy per-game fields (build logs, macro breakdown, apm
    // curve, spatial extracts) are removed in lockstep with the
    // slim row. Without this, GDPR purges would leave a sidecar
    // detail row for every deleted game — a data-residency bug as
    // soon as the v0.4.3 dual-write makes detail rows a real thing.
    // The same filter applies (userId + optional date range), since
    // detail rows duplicate the ``date`` field for exactly this kind
    // of scoped delete.
    if (this.db.gameDetails) {
      await this.db.gameDetails.deleteMany(filter);
    }
    const macroJobsRes = await this.db.macroJobs.deleteMany({ userId });

    const opponentsDeleted = await this.rebuildOpponentsForUser(userId);

    return {
      games: gamesRes.deletedCount || 0,
      opponents: opponentsDeleted,
      macroJobs: macroJobsRes.deletedCount || 0,
      range: {
        since: since ? since.toISOString() : null,
        until: until ? until.toISOString() : null,
      },
    };
  }

  /**
   * Drop every opponent row for the user, then re-derive them from the
   * surviving games. Called from ``wipeGames`` and the AdminService's
   * "Rebuild opponents" tool — see ``services/admin.js``.
   *
   * Idempotent: a no-op when the user has zero games (just leaves the
   * collection empty). Returns the pre-rebuild row count so callers
   * can show a "dropped N → recreated M" message.
   *
   * Exposed (no underscore prefix) so the admin tool can call it
   * directly without depending on the wider ``wipeGames`` flow.
   *
   * @param {string} userId
   * @returns {Promise<number>} count of opponent rows deleted before rebuild
   */
  async rebuildOpponentsForUser(userId) {
    const dropped = await this.db.opponents.deleteMany({ userId });
    const cursor = this.db.games.find(
      { userId, "opponent.pulseId": { $exists: true, $ne: "" } },
      {
        projection: {
          _id: 0,
          gameId: 1,
          date: 1,
          result: 1,
          opponent: 1,
        },
      },
    );
    /** @type {Map<string, any>} */
    const buckets = new Map();
    for await (const g of cursor) {
      const opp = g.opponent || {};
      const pulseId = opp.pulseId;
      if (typeof pulseId !== "string" || !pulseId) continue;
      const playedAt = g.date instanceof Date ? g.date : new Date(g.date);
      let bucket = buckets.get(pulseId);
      if (!bucket) {
        bucket = {
          userId,
          pulseId,
          displayNameSample: opp.displayName || "",
          race: opp.race || "U",
          firstSeen: playedAt,
          lastSeen: playedAt,
          gameCount: 0,
          wins: 0,
          losses: 0,
          openings: /** @type {Record<string, number>} */ ({}),
          mmr: typeof opp.mmr === "number" ? opp.mmr : undefined,
          leagueId: typeof opp.leagueId === "number" ? opp.leagueId : undefined,
          toonHandle: typeof opp.toonHandle === "string" ? opp.toonHandle : undefined,
          pulseCharacterId:
            typeof opp.pulseCharacterId === "string" ? opp.pulseCharacterId : undefined,
        };
        buckets.set(pulseId, bucket);
      }
      bucket.gameCount += 1;
      if (g.result === "Victory") bucket.wins += 1;
      else if (g.result === "Defeat") bucket.losses += 1;
      if (playedAt < bucket.firstSeen) bucket.firstSeen = playedAt;
      if (playedAt > bucket.lastSeen) {
        bucket.lastSeen = playedAt;
        // Keep the most recent display-name sample.
        if (opp.displayName) bucket.displayNameSample = opp.displayName;
        if (opp.race) bucket.race = opp.race;
      }
      if (opp.opening) {
        const k = String(opp.opening).replace(/[.$ ]/g, "_");
        bucket.openings[k] = (bucket.openings[k] || 0) + 1;
      }
    }
    if (buckets.size > 0) {
      const docs = [];
      for (const b of buckets.values()) {
        const doc = {
          userId: b.userId,
          pulseId: b.pulseId,
          displayNameSample: b.displayNameSample,
          race: b.race,
          firstSeen: b.firstSeen,
          lastSeen: b.lastSeen,
          gameCount: b.gameCount,
          wins: b.wins,
          losses: b.losses,
          openings: b.openings,
          // v2: every fresh row carries the resolve-attempt slot,
          // so the backfill cron's filter shape is uniform.
          pulseResolveAttemptedAt: null,
        };
        if (b.mmr !== undefined) doc.mmr = b.mmr;
        if (b.leagueId !== undefined) doc.leagueId = b.leagueId;
        if (b.toonHandle !== undefined) doc.toonHandle = b.toonHandle;
        if (b.pulseCharacterId !== undefined) doc.pulseCharacterId = b.pulseCharacterId;
        stampVersion(doc, COLLECTIONS.OPPONENTS);
        docs.push(doc);
      }
      await this.db.opponents.insertMany(docs, { ordered: false });
    }
    return dropped.deletedCount || 0;
  }

  /**
   * Public companion of ``rebuildOpponentsForUser`` that ALSO
   * heals missing pulseCharacterIds before returning. Wraps the
   * raw rebuild in a single call the admin tool can use without
   * having to thread the OpponentsService through itself.
   *
   * The pulse backfill is best-effort: a transient SC2Pulse
   * outage just means the heal step skipped. Counters were
   * already rebuilt; the periodic backfill cron will pick the
   * survivors up next cycle.
   *
   * @param {string} userId
   * @param {{ backfillLimit?: number }} [opts]
   * @returns {Promise<{
   *   droppedRows: number,
   *   pulseBackfill: {
   *     scanned: number,
   *     resolved: number,
   *     updated: number,
   *     skipped: number,
   *   } | null,
   * }>}
   */
  async rebuildOpponentsAndHealForUser(userId, opts = {}) {
    const droppedRows = await this.rebuildOpponentsForUser(userId);
    let pulseBackfill = null;
    if (this.opponents
      && typeof this.opponents.backfillPulseCharacterId === "function") {
      try {
        pulseBackfill = await this.opponents.backfillPulseCharacterId(userId, {
          limit: typeof opts.backfillLimit === "number" ? opts.backfillLimit : 500,
          // The admin tool explicitly asked for a heal — bypass the
          // "skip rows attempted within the last 6h" guard so the
          // operator sees a fresh result rather than a stale stamp.
          force: true,
        });
      } catch (err) {
        if (this.logger) {
          this.logger.warn(
            { err, userId },
            "rebuild_opponents_pulse_backfill_failed",
          );
        }
      }
    }
    return { droppedRows, pulseBackfill };
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
