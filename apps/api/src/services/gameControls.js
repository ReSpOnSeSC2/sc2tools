"use strict";
const { gameWrite } = require("../util/userRevision");

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const accountRules = require("../config/accountFilter.json");
const controlRules = require("../config/gameControls.json");

const HIDE_REASONS = Object.freeze(controlRules.reasons.map(reason => reason.value));
const CONTROL_PROJECTION = Object.freeze({ _id: 0, gameId: 1, "opponent.pulseId": 1,
  _deleted: 1, _deletionPending: 1, deletedAt: 1, _cleanupRequired: 1,
  "replayFile.storedAt": 1, "replayUpload.uploadId": 1, "playbackArtifact.artifactId": 1, "playbackUpload.artifactId": 1 });

/** Per-owner replay controls. The existing owner/game unique index also owns
 * minimal deletion tombstones; no collection or startup migration is needed. */
class GameControlsService {
  /** @param {import('../db/connect').DbContext} db
   * @param {{gdpr:import('./gdpr').GdprService,onChanged?:(userId:string,game:Record<string,any>|null)=>Promise<void>}} deps */
  constructor(db, deps) { this.db = db; this.gdpr = deps.gdpr; this.onChanged = deps.onChanged; }

  /** Settings-only control records, including incomplete cleanup retries.
   * Tombstones never enter the replay library or analysis DTOs.
   * @param {string} userId @param {{cursor?:unknown}} [opts] */
  async hidden(userId, opts = {}) {
    let cursor = "";
    if (opts.cursor !== undefined) {
      if (typeof opts.cursor !== "string" || opts.cursor.length > 600) throw failure("invalid_cursor", 400);
      cursor = Buffer.from(opts.cursor, "base64url").toString("utf8");
      if (!cursor || cursor.length > 200 || Buffer.from(cursor).toString("base64url") !== opts.cursor) throw failure("invalid_cursor", 400);
    }
    const rows = await this.db.games.find({ userId,
      ...(cursor ? { gameId: { $gt: cursor } } : {}),
      $or: [{ excluded: true, _deleted: { $ne: true } }, { _deleted: true, _cleanupRequired: { $exists: true } }],
    }, { projection: { _id: 0, gameId: 1, date: 1, map: 1, "opponent.displayName": 1, exclusionReason: 1, _deleted: 1, _deletionPending: 1, _cleanupRequired: 1 }, maxTimeMS: 5000 })
      .hint({ userId: 1, gameId: 1 }).sort({ gameId: 1 }).limit(26).toArray();
    const page = rows.slice(0, 25);
    return { items: page.map(row => ({
      gameId: row.gameId, date: row.date instanceof Date ? row.date.toISOString() : null,
      map: typeof row.map === "string" ? row.map.slice(0, 200) : "",
      opponent: typeof row.opponent?.displayName === "string" ? row.opponent.displayName.slice(0, 80) : "",
      reason: HIDE_REASONS.includes(row.exclusionReason) ? row.exclusionReason : null,
      pendingDeletion: row._deleted === true || row._deletionPending === true,
    })), nextCursor: rows.length > 25 ? Buffer.from(String(page[page.length - 1].gameId)).toString("base64url") : null };
  }

  /** Owner-only slim account metadata, no Pulse lookup or replay detail.
   * @param {string} userId */
  async accounts(userId) {
    const rowsPromise = this.db.games.aggregate([
      { $match: { userId, ...LIVE_GAME_MATCH, myToonHandle: { $regex: new RegExp(accountRules.handlePattern, "i") } } },
      { $sort: { date: -1, _id: -1 } },
      { $group: { _id: { $toUpper: "$myToonHandle" }, lastSeen: { $first: "$date" }, mmr: { $first: "$myMmr" }, leagueId: { $first: "$myLeagueId" } } },
      { $sort: { lastSeen: -1, _id: 1 } }, { $limit: accountRules.maximumAccounts },
    ], { maxTimeMS: 5000 }).toArray();
    const [rows, profile] = await Promise.all([rowsPromise, this.db.users.findOne({ userId }, { projection: { _id: 0, pulseId: 1, pulseIds: 1 } })]);
    const main = String(profile?.pulseIds?.[0] || profile?.pulseId || "").toUpperCase();
    const seen = new Set();
    return { items: rows.filter(row => { const handle = String(row._id).toUpperCase(); if (seen.has(handle)) return false; seen.add(handle); return true; }).map((row, index) => ({
      handle: String(row._id).toUpperCase(), label: String(row._id).toUpperCase() === main ? "Main" : index === 0 ? "Most recent" : `Account ${index + 1}`,
      region: require("../util/regionFromToonHandle").regionFromToonHandle(String(row._id)),
      leagueId: Number.isInteger(row.leagueId) && row.leagueId >= 0 && row.leagueId <= 6 ? row.leagueId : null,
      mmr: Number.isFinite(row.mmr) && row.mmr >= 500 && row.mmr <= 9999 ? row.mmr : null,
    })) };
  }

  /** @param {string} userId @param {string} gameId @param {{excluded:boolean,reason?:string}} input */
  async setExcluded(userId, gameId, input) {
    if (typeof input?.excluded !== "boolean" || (input.excluded && !HIDE_REASONS.includes(input.reason || ""))) {
      throw failure("invalid_game_control", 400);
    }
    const fence = await this.gdpr._acquireMutationFence(userId, "game_visibility");
    let changedGame = null;
    try {
      const game = await this.db.games.findOne({ userId, gameId }, { projection: CONTROL_PROJECTION });
      if (!game || game._deleted) return null;
      if (game._deletionPending) throw failure("game_deletion_pending", 409);
      await this.gdpr._drainOpponentBuildOrderWriters(userId, gameId);
      await fence.assert();
      // The driver can reject after committing this owner-only visibility
      // write. Its finally path must still retire cached contributions.
      changedGame = game;
      await gameWrite(this.gdpr.userRevision, userId, () => this.db.games.updateOne({ userId, gameId, _deleted: { $ne: true } }, input.excluded
        ? { $set: { excluded: true, exclusionReason: input.reason, excludedAt: new Date() } }
        : { $unset: { excluded: "", exclusionReason: "", excludedAt: "" } }));
      await this.recountOpponent(userId, game.opponent?.pulseId);
      if (this.gdpr.guideSamples) await this.gdpr.guideSamples.setExcluded(userId, gameId, input.excluded);
      // Public guide example slots never retain an owner's hidden contribution.
      if (input.excluded) await this.gdpr._scrubUserGuideExamples(userId);
      await fence.assert();
      return { gameId, excluded: input.excluded, reason: input.excluded ? input.reason : null };
    } finally { await this.notify(userId, changedGame); await this.gdpr._releaseMutationFence(userId, fence); }
  }

  /** Delete private payloads first; only then replace metadata with a minimal
   * durable marker. A failed cleanup retains its ownership row for retry.
   * @param {string} userId @param {string} gameId */
  async deleteGame(userId, gameId) {
    const fence = await this.gdpr._acquireMutationFence(userId, "delete_game");
    let changedGame = null;
    try {
      const game = await this.db.games.findOne({ userId, gameId }, { projection: CONTROL_PROJECTION });
      if (!game) return null;
      changedGame = game;
      const cleanupRequired = game._cleanupRequired || {
        replay: Boolean(this.gdpr.replayFiles || game.replayFile?.storedAt || game.replayUpload?.uploadId),
        playback: Boolean(this.gdpr.playbackArtifacts || game.playbackArtifact?.artifactId || game.playbackUpload?.artifactId),
        details: Boolean(this.gdpr.gameDetails),
      };
      if ((cleanupRequired.replay && !this.gdpr.replayFiles) || (cleanupRequired.playback && !this.gdpr.playbackArtifacts)
        || (cleanupRequired.details && !this.gdpr.gameDetails)) throw failure("game_cleanup_unavailable", 503);
      await this.gdpr._assertReplayCleanupAvailable({ userId, gameId });
      await this.gdpr._drainOpponentBuildOrderWriters(userId, gameId);
      await fence.assert();
      if (!game._deleted) {
        // Pending deletion is owner-controlled and cannot be undone by ingest
        // or Unhide if object storage fails before the operation completes.
        await gameWrite(this.gdpr.userRevision, userId, () => this.db.games.updateOne({ userId, gameId }, { $set: { excluded: true, _deletionPending: true, _cleanupRequired: cleanupRequired } }));
        await this.recountOpponent(userId, game.opponent?.pulseId);
      }
      await this.purgePayloads(userId, gameId);
      await this.db.macroJobs.deleteMany({ userId, gameId });
      await this.gdpr._deleteWipedGuideSamples(userId, [gameId]);
      await this.gdpr._scrubUserGuideExamples(userId);
      await fence.assert();
      const deletedAt = game._deleted && game.deletedAt instanceof Date ? game.deletedAt : new Date();
      await gameWrite(this.gdpr.userRevision, userId, () => this.db.games.replaceOne({ userId, gameId }, stampVersion({ userId, gameId, deletedAt, _deleted: true, excluded: true, _cleanupRequired: cleanupRequired }, COLLECTIONS.GAMES)));
      // A stale upload completion cannot authorize against the minimal row.
      // Repeat the same scoped cleanup to catch an earlier in-flight write.
      await this.purgePayloads(userId, gameId);
      await fence.assert();
      if (this.gdpr.reviews) await this.gdpr.reviews.closeForGame(userId, gameId);
      await this.db.games.updateOne({ userId, gameId, _deleted: true }, { $unset: { _cleanupRequired: "" } });
      return { gameId, deleted: true, deletedAt };
    } finally { await this.notify(userId, changedGame); await this.gdpr._releaseMutationFence(userId, fence); }
  }

  /** Cache refresh must not mask a storage cleanup failure.
   * @param {string} userId @param {Record<string,any>|null} game */
  async notify(userId, game) {
    if (!game) return;
    try { await this.onChanged?.(userId, game); }
    catch (err) { this.gdpr.logger?.warn?.({ err }, "game_control_cache_refresh_failed"); }
  }

  /** Reuses the same store-aware cleanup as GDPR without a full-user wipe.
   * Errors propagate so a partial cleanup can be retried honestly.
   * @param {string} userId @param {string} gameId */
  async purgePayloads(userId, gameId) {
    if (this.gdpr.replayFiles) await this.gdpr.replayFiles.delete(userId, gameId);
    if (this.gdpr.playbackArtifacts) await this.gdpr.playbackArtifacts.deleteMany(userId, [gameId]);
    if (this.gdpr.gameDetails) await this.gdpr.gameDetails.delete(userId, gameId);
    else await this.db.gameDetails.deleteOne({ userId, gameId });
  }

  /** Streams one indexed opponent history into one counter bucket. Never
   * rebuild every opponent or touch another uploader's copy of the replay.
   * @param {string} userId @param {unknown} pulseId */
  async recountOpponent(userId, pulseId) {
    if (typeof pulseId !== "string" || !pulseId) return;
    await this.gdpr.recountOpponent(userId, pulseId);
  }
}

/** @param {string} code @param {number} status */
function failure(code, status) { return Object.assign(new Error(code), { code, status }); }
module.exports = { GameControlsService, HIDE_REASONS };
