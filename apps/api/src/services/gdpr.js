"use strict";

const { randomUUID } = require("crypto");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");

const GDPR_MUTATION_LEASE_MS = 15 * 60 * 1000;
const GDPR_MUTATION_RENEW_MS = 60 * 1000;

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Collections purged on account deletion but deliberately NOT part of
 * the export/restore round-trip (USER_SCOPED_COLLECTIONS): pairings
 * and leaderboard rows are device/derived state a restore should not
 * resurrect, and community content is public-facing — restoring it
 * would re-publish content the user may have deleted in between.
 *
 * (db key, filter field holding the user's id)
 */
const PURGE_ONLY_COLLECTIONS = [
  ["devicePairings", "userId"],
  // Ephemeral background work must never be exported/restored: doing so could
  // resurrect a completed classifier after an account recovery.
  ["customBuildJobs", "userId"],
  ["arcadeLeaderboard", "userId"],
  ["communityBuilds", "ownerUserId"],
  ["communityReports", "reporterUserId"],
  // Credentials are encrypted and intentionally excluded from export/restore;
  // account deletion still removes them and all short-lived event rows.
  ["platformConnections", "userId"],
  ["platformOauthStates", "userId"],
  ["platformEvents", "userId"],
];

class GdprService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   opponents?: import('./opponents').OpponentsService,
   *   logger?: import('pino').Logger,
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   *   replayFiles?: import('./replayFiles').ReplayFilesService|null,
   *   customBuilds?: import('./types').CustomBuildsService,
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
    // GameDetailsService — the store-aware deleter for the heavy
    // per-game blobs. Required so delete/wipe also removes R2/S3
    // objects when GAME_DETAILS_STORE=r2; a bare
    // ``db.gameDetails.deleteMany`` only covers the Mongo backend.
    this.gameDetails = (opts && opts.gameDetails) || null;
    this.replayFiles = (opts && opts.replayFiles) || null;
    this.customBuilds = (opts && opts.customBuilds) || null;
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

    // Resolve identity BEFORE deleting the user doc — the admin-events
    // scrub below needs the clerkUserId to find signup/message rows.
    const user = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, clerkUserId: 1 } },
    );

    const gdprFence = await this._acquireMutationFence(userId, "delete_all");
    try {
      await gdprFence.assert();
      await this._drainOpponentBuildOrderWriters(userId);

    if (this.customBuilds) {
      await this.customBuilds.cancelUserReclassifications(userId);
    }

    await this._assertReplayCleanupAvailable({ userId });

    // Original replay binaries are outside Mongo. Delete them while the
    // account still exists so an R2 failure aborts the request instead of
    // reporting success with private objects orphaned in storage.
    if (this.replayFiles) {
      await gdprFence.assert();
      await this.replayFiles.deleteAllForUser(userId);
      await gdprFence.assert();
      counts.replayFiles = -1;
    }

    await gdprFence.assert();
    for (const [key] of USER_SCOPED_COLLECTIONS) {
      await gdprFence.assert();
      const coll = /** @type {any} */ (this.db)[key];
      if (!coll) continue;
      const res = await coll.deleteMany({ userId });
      counts[key] = res.deletedCount || 0;
    }

    // Heavy per-game blobs. Store-aware: removes R2/S3 objects when
    // that backend is active; falls back to the Mongo collection when
    // the service wasn't injected (older callers / focused tests).
    await gdprFence.assert();
    if (this.gameDetails) {
      await this.gameDetails.deleteAllForUser(userId);
      await gdprFence.assert();
      counts.gameDetails = -1; // store contract doesn't report counts
    } else if (this.db.gameDetails) {
      const res = await this.db.gameDetails.deleteMany({ userId });
      counts.gameDetails = res.deletedCount || 0;
    }

    for (const [key, field] of PURGE_ONLY_COLLECTIONS) {
      const coll = /** @type {any} */ (this.db)[key];
      if (!coll) continue;
      const res = await coll.deleteMany({ [field]: userId });
      counts[key] = res.deletedCount || 0;
    }

    // Manual snapshots hold a FULL export of the user's data — the
    // single most sensitive thing to leave behind.
    const backups = this.db.db.collection("user_backups");
    const backupsRes = await backups.deleteMany({ userId });
    counts.userBackups = backupsRes.deletedCount || 0;

    // Admin events keep their (now-orphaned, random) userId for
    // aggregate counts, but the PII riding on signup/message payloads
    // (email, clerk id) is scrubbed in place.
    if (this.db.adminEvents) {
      /** @type {Record<string, string>[]} */
      const identityFilters = [{ "payload.userId": userId }];
      if (user && user.clerkUserId) {
        identityFilters.push({ "payload.clerkUserId": user.clerkUserId });
      }
      const scrubRes = await this.db.adminEvents.updateMany(
        { $or: identityFilters },
        {
          $set: {
            "payload.email": null,
            "payload.clerkUserId": null,
            anonymizedAt: new Date(),
          },
        },
      );
      counts.adminEventsScrubbed = scrubRes.modifiedCount || 0;
    }

    // Close the upload-completion race: a request that passed ownership
    // checks before the first purge can promote its pending object while the
    // Mongo rows are being removed. With ownership gone it cannot become a
    // valid download, and this second deterministic prefix purge removes any
    // object that landed in that interval. Do this before removing the user
    // row so an R2 failure remains retryable under the same account identity.
    if (this.replayFiles) {
      await gdprFence.assert();
      await this.replayFiles.deleteAllForUser(userId);
      await gdprFence.assert();
    }
    await gdprFence.assert();
    clearInterval(gdprFence.timer);
    const userRes = await this.db.users.deleteOne({
      userId,
      "_gdprMutation.id": gdprFence.id,
    });
    counts.users = userRes.deletedCount || 0;
    return counts;
    } catch (err) {
      await this._releaseMutationFence(userId, gdprFence);
      throw err;
    }
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
    const gdprFence = await this._acquireMutationFence(userId, "wipe_games");
    try {
      await gdprFence.assert();
      await this._drainOpponentBuildOrderWriters(userId);
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

    if (this.customBuilds) {
      await this.customBuilds.cancelUserReclassifications(userId);
    }

    await this._assertReplayCleanupAvailable(filter);

    // Resolve raw-replay keys before removing their Mongo ownership rows.
    // A full wipe can delete by user prefix; a ranged wipe needs the exact
    // game ids because object storage cannot filter by Mongo dates.
    /** @type {string[]} */
    let replayGameIds = [];
    let gamesDeleteFilter = filter;
    if (this.replayFiles) {
      await gdprFence.assert();
      if (since || until) {
        const replayRows = await this.db.games
          .find(filter, { projection: { _id: 0, gameId: 1 } })
          .toArray();
        replayGameIds = replayRows
          .map((row) => row && row.gameId)
          .filter((gameId) => typeof gameId === "string" && gameId);
        // Linearize a ranged wipe at this snapshot. Deleting with the broad
        // date filter below could also remove a replay that the agent inserts
        // between this ID read and deleteMany; that new row's R2 key would not
        // be in replayGameIds and could be orphaned. The unique gameId list
        // ensures every Mongo row this operation removes has a deterministic
        // pre/post object cleanup, while concurrent later inserts survive for
        // a future wipe instead of losing their ownership record.
        gamesDeleteFilter = {
          userId,
          gameId: { $in: replayGameIds },
        };
        await this.replayFiles.deleteMany(
          userId,
          replayGameIds,
        );
      } else {
        await this.replayFiles.deleteAllForUser(userId);
      }
      await gdprFence.assert();
    }

    await gdprFence.assert();
    const gamesRes = await this.db.games.deleteMany(gamesDeleteFilter);
    // A completion already in flight may have promoted an object after the
    // first purge. Repeat the same key-scoped cleanup immediately after the
    // matching ownership rows are gone; completion's conditional marker
    // update can no longer authorize the object.
    if (this.replayFiles) {
      await gdprFence.assert();
      if (since || until) {
        await this.replayFiles.deleteMany(userId, replayGameIds);
      } else {
        await this.replayFiles.deleteAllForUser(userId);
      }
      await gdprFence.assert();
    }
    // Mirror the delete on the split-out ``game_details`` storage so
    // heavy per-game fields (build logs, macro breakdown, apm curve,
    // spatial extracts) are removed in lockstep with the slim row.
    // Store-aware: in R2 mode the Mongo collection only holds index
    // rows — the blobs live as objects, and deleting just the rows
    // would orphan every object. Detail rows duplicate the ``date``
    // field precisely so this ranged filter works.
    await gdprFence.assert();
    if (this.gameDetails && (since || until)) {
      // Ranged wipe: resolve the affected gameIds from the detail
      // index rows, then delete blob+row per game through the store.
      // When replay storage is active, use the same linearized game-ID
      // snapshot as the slim-row/raw-file cleanup so an in-range game that
      // arrives concurrently survives with both its row and detail object.
      const detailFilter = this.replayFiles
        ? { userId, gameId: { $in: replayGameIds } }
        : filter;
      const rows = await this.db.gameDetails
        .find(detailFilter, { projection: { _id: 0, gameId: 1 } })
        .toArray();
      for (const row of rows) {
        await gdprFence.assert();
        if (row && typeof row.gameId === "string" && row.gameId) {
          await this.gameDetails.delete(userId, row.gameId);
        }
      }
    } else if (this.gameDetails) {
      await this.gameDetails.deleteAllForUser(userId);
    } else if (this.db.gameDetails) {
      await this.db.gameDetails.deleteMany(filter);
    }
    await gdprFence.assert();
    const macroJobsRes = await this.db.macroJobs.deleteMany({ userId });

    const opponentsDeleted = await this.rebuildOpponentsForUser(userId);
    await gdprFence.assert();

    return {
      games: gamesRes.deletedCount || 0,
      opponents: opponentsDeleted,
      macroJobs: macroJobsRes.deletedCount || 0,
      range: {
        since: since ? since.toISOString() : null,
        until: until ? until.toISOString() : null,
      },
    };
    } finally {
      await this._releaseMutationFence(userId, gdprFence);
    }
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
    const buckets = await this._competitiveOpponentBuckets(userId);
    if (buckets.size > 0) {
      const docs = [];
      for (const b of buckets.values()) {
        /** @type {{
         *   userId: string,
         *   pulseId: string,
         *   displayNameSample: string,
         *   race: string,
         *   firstSeen: Date,
         *   lastSeen: Date,
         *   gameCount: number,
         *   wins: number,
         *   losses: number,
         *   openings: Record<string, number>,
         *   pulseResolveAttemptedAt: null,
         *   mmr?: number,
         *   leagueId?: number,
         *   toonHandle?: string,
         *   pulseCharacterId?: string,
         * }} */
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
   * @private
   * @param {string} userId
   * @returns {Promise<Map<string, any>>}
   */
  async _competitiveOpponentBuckets(userId) {
    const cursor = this.db.games.find(
      {
        userId,
        isResumedFromReplay: { $ne: true },
        "opponent.pulseId": { $exists: true, $ne: "" },
      },
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
      if (Number.isNaN(playedAt.getTime())) continue;
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
        if (opp.displayName) bucket.displayNameSample = opp.displayName;
        if (opp.race) bucket.race = opp.race;
        if (typeof opp.mmr === "number") bucket.mmr = opp.mmr;
        if (typeof opp.leagueId === "number") bucket.leagueId = opp.leagueId;
        if (typeof opp.toonHandle === "string") bucket.toonHandle = opp.toonHandle;
        if (typeof opp.pulseCharacterId === "string") {
          bucket.pulseCharacterId = opp.pulseCharacterId;
        }
      }
      if (opp.opening) {
        const k = String(opp.opening).replace(/[.$ ]/g, "_");
        bucket.openings[k] = (bucket.openings[k] || 0) + 1;
      }
    }
    return buckets;
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
    const items =
      /** @type {Array<{id: string, createdAt: Date, sizeBytes: number, type: string}>} */ (
        /** @type {unknown} */ (
          await coll
            .find(
              { userId },
              { projection: { _id: 0, id: 1, createdAt: 1, sizeBytes: 1, type: 1 } },
            )
            .sort({ createdAt: -1 })
            .toArray()
        )
      );
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
    const gdprFence = await this._acquireMutationFence(userId, "restore");
    try {
      await gdprFence.assert();
      await this._drainOpponentBuildOrderWriters(userId);
    if (this.customBuilds) {
      await this.customBuilds.cancelUserReclassifications(userId);
    }
    const snapshotGames = /** @type {Array<Record<string, any>>} */ (
      Array.isArray(snap.payload?.data?.games) ? snap.payload.data.games : []
    );
    const snapshotHasReplayMarkers = snapshotGames.some(
      (game) => game && (
        (game.replayFile && game.replayFile.storedAt)
        || (game.replayUpload && game.replayUpload.uploadId)
      ),
    );
    await this._assertReplayCleanupAvailable(
      { userId },
      snapshotHasReplayMarkers,
    );
    // Heavy detail blobs are not embedded in manual snapshot JSON. Purge the
    // active store before restoring slim game rows so current R2/Mongo detail
    // data cannot survive the restore and attach to a historical gameId.
    await gdprFence.assert();
    if (this.gameDetails) {
      await this.gameDetails.deleteAllForUser(userId);
      await gdprFence.assert();
    } else if (this.db.gameDetails) {
      await this.db.gameDetails.deleteMany({ userId });
    }
    // Replay binaries are intentionally not embedded in JSON snapshots.
    // Remove current objects before clearing their Mongo ownership rows, so
    // any object-store failure aborts before historical rows are inserted.
    if (this.replayFiles) {
      await gdprFence.assert();
      await this.replayFiles.deleteAllForUser(userId);
      await gdprFence.assert();
    }
    // Clear current data (NOT the user record — the user keeps their id).
    await gdprFence.assert();
    for (const [key] of USER_SCOPED_COLLECTIONS) {
      await gdprFence.assert();
      const c = /** @type {any} */ (this.db)[key];
      if (c) await c.deleteMany({ userId });
    }
    const data = snap.payload?.data || {};
    for (const [key, jsonKey] of USER_SCOPED_COLLECTIONS) {
      await gdprFence.assert();
      const c = /** @type {any} */ (this.db)[key];
      const rows = Array.isArray(data[jsonKey]) ? data[jsonKey] : [];
      if (c && rows.length > 0) {
        await c.insertMany(
          rows.map((r) => {
            const restored = { ...r, userId };
            if (key === "games") {
              delete restored.replayFile;
              delete restored.replayUpload;
              delete restored._customBuildReclassify;
              delete restored._customBuildClassificationSequence;
              delete restored._opponentBuildOrderWriteLease;
              restored._customBuildRevision = randomUUID();
              // Preserve both perspective-specific provenance fields: unlike
              // transient stage/order state, they are durable ownership
              // metadata for `myBuild` and `opponent.strategy`.
              stampVersion(restored, COLLECTIONS.GAMES);
            }
            return restored;
          }),
          { ordered: false },
        );
      }
    }
    // Snapshot JSON never restores raw replay markers. A second pass closes
    // the same in-flight completion race as account/history deletion.
    if (this.replayFiles) {
      await gdprFence.assert();
      await this.replayFiles.deleteAllForUser(userId);
      await gdprFence.assert();
    }
    return { restoredAt: new Date(), counts: countsOf(data) };
    } finally {
      await this._releaseMutationFence(userId, gdprFence);
    }
  }

  /** @param {string} userId @param {string} kind */
  async _acquireMutationFence(userId, kind) {
    const id = randomUUID();
    const now = new Date();
    const claimed = await this.db.users.updateOne(
      { userId, $or: [
        { _gdprMutation: { $exists: false } },
        { "_gdprMutation.leaseUntil": { $lte: now } },
        { "_gdprMutation.leaseUntil": { $exists: false } },
      ] },
      { $set: { _gdprMutation: {
        id,
        kind,
        startedAt: now,
        leaseUntil: new Date(now.getTime() + GDPR_MUTATION_LEASE_MS),
      } } },
    );
    if (claimed.matchedCount === 0) {
      const err = new Error("gdpr_operation_busy");
      /** @type {any} */ (err).status = 409;
      throw err;
    }
    let lost = false;
    const renew = async () => {
      const renewed = await this.db.users.updateOne(
        { userId, "_gdprMutation.id": id },
        { $set: {
          "_gdprMutation.leaseUntil": new Date(
            Date.now() + GDPR_MUTATION_LEASE_MS,
          ),
        } },
      );
      if (renewed.matchedCount === 0) {
        lost = true;
        throw new Error("gdpr_operation_lease_lost");
      }
    };
    const timer = setInterval(() => {
      void renew().catch((err) => {
        lost = true;
        if (this.logger?.error) {
          this.logger.error(
            { err, userId, kind },
            "gdpr_operation_lease_renew_failed",
          );
        }
      });
    }, GDPR_MUTATION_RENEW_MS);
    if (typeof timer.unref === "function") timer.unref();
    const assert = async () => {
      if (lost) throw new Error("gdpr_operation_lease_lost");
      await renew();
      if (lost) throw new Error("gdpr_operation_lease_lost");
    };
    return { id, timer, assert };
  }

  /** @param {string} userId @param {{id: string, timer: NodeJS.Timeout, assert: () => Promise<void>}} fence */
  async _releaseMutationFence(userId, fence) {
    clearInterval(fence.timer);
    await this.db.users.updateOne(
      { userId, "_gdprMutation.id": fence.id },
      { $unset: { _gdprMutation: "" } },
    );
  }

  /** @param {string} userId */
  async _drainOpponentBuildOrderWriters(userId) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const now = new Date();
      // Crash residue cannot write again. Remove its row fence immediately so
      // the destructive operation can proceed without waiting five minutes.
      await this.db.games.updateMany(
        {
          userId,
          "_opponentBuildOrderWriteLease.leaseUntil": { $lte: now },
        },
        { $set: { _customBuildRevision: randomUUID() }, $unset: {
          _opponentBuildOrderWriteLease: "",
          _customBuildClassificationSequence: "",
          _customBuildReclassify: "",
        } },
      );
      const active = await this.db.games.findOne(
        {
          userId,
          "_opponentBuildOrderWriteLease.leaseUntil": { $gt: now },
        },
        { projection: { _id: 1 } },
      );
      if (!active) return;
      if (Date.now() >= deadline) {
        const err = new Error("opponent_build_order_write_busy");
        /** @type {any} */ (err).status = 503;
        throw err;
      }
      await wait(50);
    }
  }

  /**
   * Never remove the Mongo ownership rows while their private objects cannot
   * be addressed. Explicitly disabling replay storage is safe for local
   * development, but production cleanup fails closed if archived markers
   * prove that R2 objects may exist.
   *
   * @param {Record<string, any>} gameFilter
   * @param {boolean} [additionalMarker]
   */
  async _assertReplayCleanupAvailable(gameFilter, additionalMarker = false) {
    if (this.replayFiles) return;
    const archivedGame = await this.db.games.findOne(
      {
        ...gameFilter,
        $or: [
          { "replayFile.storedAt": { $exists: true } },
          { "replayUpload.uploadId": { $exists: true } },
        ],
      },
      { projection: { _id: 1 } },
    );
    if (!archivedGame && !additionalMarker) return;
    const err = /** @type {Error & {status: number, code: string}} */ (
      new Error("replay_storage_unavailable")
    );
    err.status = 503;
    err.code = "replay_storage_unavailable";
    throw err;
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

module.exports = {
  GdprService,
  USER_SCOPED_COLLECTIONS,
  PURGE_ONLY_COLLECTIONS,
};
