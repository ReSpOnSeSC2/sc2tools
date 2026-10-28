"use strict";
const { gameWrite } = require("../util/userRevision");
const { gameStatsWritesFor } = require("./gameStatsWrites");

const { createHash, randomUUID } = require("crypto");
const { BSON } = require("mongodb");
const { USER_SCOPED_COLLECTIONS } = require("./gdpr");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { protectDeletedSnapshotGames, liveBackupGamesMatch } = require("./backupGameDeletion");

// Credentials and work queues are live state, not restore points. Restoring a
// snapshot must not revive an unlinked PC or restart an old import/classifier.
const RESTORABLE = [...USER_SCOPED_COLLECTIONS.filter(([key]) => !["deviceTokens", "importJobs", "macroJobs"].includes(key)), ["users", "preferences"], ["users", "accountProfile"]];
const PREFERENCE_KEYS = ["misc", "voice", "arcade", "randomizer", "multichat", "buildCheckin"];
// Public-profile and replay-sharing consent is live state, deliberately never
// restored from an old snapshot. It is exported/erased with the full user row.
const PROFILE_KEYS = ["battleTag", "pulseId", "pulseIds", "region", "preferredRace", "displayName", "sessionGapMinutes"];
const STAGING = COLLECTIONS.BACKUP_RESTORE_STAGING;
const RETENTION = { manual: 5, auto: 2, pre_action: 3 };
const BATCH = 100;
/** @param {string} message @param {number} status */
function failure(message, status = 503) { return Object.assign(new Error(message), { code: message, status }); }
/** @param {unknown} value */
function encode(value) { return `${BSON.EJSON.stringify(value, { relaxed: false })}\n`; }
/** @param {Record<string,any>} row */
function cleanGame(row) {
  const game = { ...row };
  for (const key of ["replayFile", "playbackArtifact", "playbackUpload", "replayUpload", "_customBuildReclassify", "_customBuildClassificationSequence", "_opponentBuildOrderWriteLease"]) delete game[key];
  game._customBuildRevision = randomUUID();
  return stampVersion(game, COLLECTIONS.GAMES);
}
/** Restore only approved literal fields, retaining account/security/setup data.
 * @param {import('mongodb').Collection} users @param {string} userId @param {string} key @param {Record<string,any>|null} saved
 * @param {Record<string,any>} [authority] */
async function restoreUserSettings(users, userId, key, saved, authority = {}) {
  if (!saved) return;
  if (key === "accountProfile") {
    const fields = Object.fromEntries(PROFILE_KEYS.map((name) => [name, Object.hasOwn(saved.data, name) ? { $literal: saved.data[name] } : "$$REMOVE"]));
    const result = await users.updateOne({ userId, ...authority }, [{ $set: { ...fields, profileUpdatedAt: new Date() } }]);
    if (Object.keys(authority).length && result.matchedCount !== 1) throw failure("gdpr_operation_lease_lost", 409);
  } else {
    const fields = Object.fromEntries(PREFERENCE_KEYS.map((name) => [`preferences.${name}`, Object.hasOwn(saved.data.preferences || {}, name) ? { $literal: saved.data.preferences[name] } : "$$REMOVE"]));
    const result = await users.updateOne({ userId, ...authority }, [{ $set: fields }]);
    if (Object.keys(authority).length && result.matchedCount !== 1) throw failure("gdpr_operation_lease_lost", 409);
  }
}

class UserBackupsService {
  /** @param {import('../db/connect').DbContext} db @param {{store: import('./userBackupsStore').UserBackupsStore|null, gdpr: import('./gdpr').GdprService, userRevision?: import('../util/userRevision').UserRevision, logger?: import('pino').Logger}} opts */
  constructor(db, opts) {
    this.userRevision = opts.userRevision || null;
    this.gameStatsWrites = gameStatsWritesFor(db, opts.logger);
    this.db = db; this.store = opts.store; this.gdpr = opts.gdpr; this.logger = opts.logger;
    this.metadata = db.userBackups || db.db.collection("user_backups");
    this.staging = db.db.collection(STAGING);
    this.indexes = null;
    /** @type {Set<Promise<void>>} */ this.pending = new Set();
    this.activeUploads = 0;
  }
  available() { if (!this.store) throw failure("backups_unavailable"); return this.store; }
  /** Fail before account erasure if an owned R2 backup cannot be cleaned up. @param {string} userId */
  async assertCleanupAvailable(userId) { if (!this.store && await this.metadata.findOne({ userId, format: 1 }, { projection: { _id: 1 } })) throw failure("backups_unavailable"); }
  async drain() { await Promise.allSettled([...this.pending]); }
  async ensureIndexes() {
    if (!this.indexes) this.indexes = Promise.all([
      this.staging.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.staging.createIndex({ operationId: 1, key: 1, gameId: 1 }),
    ]).catch((error) => { this.indexes = null; throw error; });
    await this.indexes;
  }
  /** @param {string} userId @param {{type?: 'manual'|'auto'|'pre_action', label?: string, assert?: ()=>Promise<void>, payload?: Record<string,any>, migrateId?:string, createdAt?:Date}} [opts] */
  async _create(userId, opts = {}) {
    const store = this.available(); const type = opts.type || "manual";
    const id = opts.migrateId || `bk_${Date.now()}_${randomUUID().replace(/-/g, "")}`; const createdAt = opts.createdAt || new Date();
    /** @type {Record<string,number>} */ const counts = {};
    const db = this.db;
    async function* lines() {
      const checksum = createHash("sha256");
      /** @param {unknown} row */
      function line(row) { const text = encode(row); checksum.update(text); return text; }
      yield line({ format: "sc2tools-backup", version: 1, userId, id, createdAt });
      for (const [key, jsonKey] of RESTORABLE) {
        if (opts.assert) await opts.assert();
        yield line({ collection: jsonKey }); counts[jsonKey] = 0;
        const preferenceProjection = Object.fromEntries(PREFERENCE_KEYS.map((name) => [`preferences.${name}`, 1]));
        const profileProjection = Object.fromEntries(PROFILE_KEYS.map((name) => [name, 1]));
        const source = opts.payload ? (key === "users" ? (opts.payload.user ? [opts.payload.user] : []) : (opts.payload.data?.[jsonKey] || []))
          : /** @type {any} */ (db)[key]?.find({ userId }, { projection: key === "users" ? { _id: 0, userId: 1, ...(jsonKey === "preferences" ? preferenceProjection : profileProjection) } : { _id: 0 } }).batchSize(BATCH);
        if (!source) continue;
        for await (const row of source) {
          if (key === "games" && (row._deleted || row._deletionPending)) continue;
          if (counts[jsonKey] % BATCH === 0 && opts.assert) await opts.assert();
          const record = jsonKey === "preferences" ? { userId, preferences: Object.fromEntries(PREFERENCE_KEYS.filter((name) => Object.hasOwn(row.preferences || {}, name)).map((name) => [name, row.preferences[name]])) }
            : jsonKey === "accountProfile" ? { userId, ...Object.fromEntries(PROFILE_KEYS.filter((name) => Object.hasOwn(row, name)).map((name) => [name, row[name]])) } : row;
          yield line({ row: record }); counts[jsonKey] += 1;
        }
      }
      yield encode({ end: true, counts, sha256: checksum.digest("hex") });
    }
    const { sizeBytes } = await store.put(userId, id, lines());
    const doc = stampVersion({ id, userId, type, label: String(opts.label || "").trim().slice(0, 80), createdAt, sizeBytes, counts, format: 1 }, COLLECTIONS.USER_BACKUPS);
    try {
      if (opts.assert) await opts.assert();
      if (opts.migrateId) {
        const result = await this.metadata.updateOne({ userId, id, payload: { $exists: true } }, { $set: doc, $unset: { payload: "" } });
        if (!result.modifiedCount) throw failure("backup_migration_conflict", 409);
      } else await this.metadata.insertOne(doc);
    }
    catch (error) { await store.delete(userId, id).catch(() => {}); throw error; }
    // A pruning failure never misreports an already durable snapshot as failed.
    try { await this.prune(userId, type); } catch (error) { this.logger?.warn({ err: error, userId }, "backup_prune_failed"); }
    return this.publicMetadata(doc);
  }
  /** Bound multipart buffers on the small API instance. @param {string} userId @param {Parameters<UserBackupsService['_create']>[1]} [opts] */
  async create(userId, opts = {}) {
    if (this.activeUploads >= 2) throw failure("backups_busy");
    this.activeUploads += 1;
    try { return await this._create(userId, opts); } finally { this.activeUploads -= 1; }
  }
  /** @param {Record<string,any>} doc */
  publicMetadata(doc) { return { id: doc.id, type: doc.type, label: doc.label || "", createdAt: doc.createdAt, sizeBytes: doc.sizeBytes, counts: doc.counts || {} }; }
  /** @param {string} userId @param {'manual'|'auto'|'pre_action'} type */
  async prune(userId, type) {
    const expired = this.metadata.find({ userId, type, payload: { $exists: false } }).sort({ createdAt: -1, id: -1 }).skip(RETENTION[type]);
    for await (const doc of expired) await this.remove(userId, doc.id);
  }
  /** @param {string} userId */
  async list(userId) { return { items: (await this.metadata.find({ userId }, { projection: { payload: 0 } }).sort({ createdAt: -1, id: -1 }).toArray()).map((row) => this.publicMetadata(row)) }; }
  /** @param {string} userId @param {string} id */
  async find(userId, id) { const row = await this.metadata.findOne({ userId, id }); if (!row) throw failure("snapshot_not_found", 404); return row; }
  /** @param {string} userId @param {string} id */
  async remove(userId, id) {
    const row = await this.find(userId, id);
    if (!row.payload) await this.available().delete(userId, id);
    await this.metadata.deleteOne({ userId, id }); return { deleted: true };
  }
  /** @param {string} userId @param {string} id @param {unknown} label */
  async label(userId, id, label) {
    if (typeof label !== "string" || label.trim().length > 80 || /[\x00-\x1f]/.test(label)) throw failure("invalid_backup_label", 400);
    await this.find(userId, id); await this.metadata.updateOne({ userId, id }, { $set: { label: label.trim() } }); return { label: label.trim() };
  }
  /** @param {string} userId @param {string} id */
  async download(userId, id) { const row = await this.find(userId, id); if (row.payload) throw failure("backup_migration_required", 409); return this.available().download(userId, id); }
  /** One legacy document at a time; the original is retained until upload succeeds. @param {string} userId @param {string} id @param {()=>Promise<void>} assert */
  async migrateLegacy(userId, id, assert) {
    const row = await this.find(userId, id); if (!row.payload) return { migrated: false };
    await this.create(userId, { payload: row.payload, migrateId: id, createdAt: row.createdAt, type: row.type || "manual", label: row.label, assert });
    return { migrated: true };
  }
  /** @param {string} userId @param {string} id */
  async stage(userId, id) {
    const store = this.available(); await this.ensureIndexes(); const snapshot = await this.find(userId, id);
    if (snapshot.payload) throw failure("backup_migration_required", 409);
    const operationId = randomUUID(); const checksum = createHash("sha256");
    let header = false; let ended = false; let key = ""; let ordinal = 0;
    /** @type {Record<string,number>} */ const counts = {};
    /** @type {any[]} */ let batch = []; let batchBytes = 0;
    const flush = async () => { if (batch.length) { await this.staging.insertMany(batch, { ordered: true }); batch = []; batchBytes = 0; } };
    try {
      for await (const text of store.read(userId, id)) {
        if (ended) throw failure("backup_invalid", 422);
        const line = BSON.EJSON.parse(text, { relaxed: true });
        if (!header) {
          if (line.format !== "sc2tools-backup" || line.version !== 1 || line.userId !== userId || line.id !== id) throw failure("backup_invalid", 422);
          header = true;
        } else if (line.end === true) {
          if (line.sha256 !== checksum.digest("hex") || JSON.stringify(line.counts) !== JSON.stringify(counts)) throw failure("backup_invalid", 422);
          ended = true; continue;
        } else if (typeof line.collection === "string") {
          if (!RESTORABLE.some(([, name]) => name === line.collection) || Object.hasOwn(counts, line.collection)) throw failure("backup_invalid", 422);
          key = line.collection; counts[key] = 0;
        } else {
          if (!key || !line.row || typeof line.row !== "object" || Array.isArray(line.row) || line.row.userId !== userId) throw failure("backup_invalid", 422);
          const gameId = key === "games" ? line.row.gameId : undefined;
          if (key === "games" && (typeof gameId !== "string" || !gameId || gameId.length > 200)) throw failure("backup_invalid", 422);
          batch.push(stampVersion({ _id: gameId ? `${operationId}:${gameId}` : `${operationId}:${ordinal}`, operationId, userId, key, gameId, ordinal: ordinal++, data: line.row, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, STAGING));
          batchBytes += Buffer.byteLength(text); counts[key] += 1; if (batch.length >= BATCH || batchBytes >= 4 * 1024 * 1024) await flush();
        }
        checksum.update(`${text}\n`);
      }
      if (!header || !ended || RESTORABLE.some(([, name]) => !Object.hasOwn(counts, name))) throw failure("backup_invalid", 422);
      if (counts.preferences > 1 || counts.accountProfile > 1) throw failure("backup_invalid", 422);
      await flush();
      await protectDeletedSnapshotGames(this.db, this.staging, userId, operationId, counts);
      return { operationId, counts };
    } catch (error) { await this.staging.deleteMany({ operationId }); throw error; }
  }
  /** @param {string} userId @param {string} operationId */
  missingGames(userId, operationId) {
    return this.db.games.aggregate([
      { $match: liveBackupGamesMatch(userId) },
      { $lookup: { from: STAGING, let: { gameId: "$gameId" }, pipeline: [
        { $match: { operationId, key: "games", $expr: { $eq: ["$gameId", "$$gameId"] } } }, { $limit: 1 }, { $project: { _id: 1 } },
      ], as: "saved" } }, { $match: { saved: { $size: 0 } } }, { $project: { _id: 0, gameId: 1 } },
    ]).batchSize(BATCH);
  }
  /** @param {string} userId */
  async membershipRevision(userId) {
    const hash = createHash("sha256");
    for await (const row of this.db.games.find({ userId }, { projection: { _id: 0, gameId: 1, _deleted: 1, _deletionPending: 1, excluded: 1 } }).sort({ gameId: 1 }).batchSize(BATCH)) {
      hash.update(`${JSON.stringify([row.gameId, row._deleted === true, row._deletionPending === true, row.excluded === true])}\n`);
    }
    return hash.digest("hex").slice(0, 24);
  }
  /** @param {string} userId @param {string} id */
  async preview(userId, id) {
    // A preview creates temporary private rows. Register its archive read so
    // account erasure cannot purge staging and then race a late preview flush.
    const reader = await claimUserDataLease(this.db.users, userId);
    let staged;
    try { staged = await this.stage(userId, id); } finally { await reader.release(); }
    let fence;
    try {
      fence = await this.gdpr._acquireMutationFence(userId, "snapshot_preview");
      const removed = (await this.missingGames(userId, staged.operationId).group({ _id: null, count: { $sum: 1 } }).next())?.count || 0;
      const current = await this.db.games.countDocuments(liveBackupGamesMatch(userId)); const kept = current - removed;
      return { games: { kept, removed, added: staged.counts.games - kept }, customBuilds: staged.counts.customBuilds, opponentNotes: staged.counts.opponentNotes, overlayTokens: 0, currentRevision: await this.membershipRevision(userId) };
    } finally { if (fence) await this.gdpr._releaseMutationFence(userId, fence); await this.staging.deleteMany({ operationId: staged.operationId }); }
  }
  /** @param {string} userId @param {string} id @param {{assert:()=>Promise<void>,id?:string,owner?:import('./gameStatsWrites').GameStatsOwner|null}} fence @param {string|undefined} [expectedRevision] */
  async restore(userId, id, fence, expectedRevision) {
    const statsOwner = await this.gameStatsWrites.forFence(userId, fence);
    const staged = await this.stage(userId, id);
    let contributionChanged = false;
    try {
      if (expectedRevision && expectedRevision !== await this.membershipRevision(userId)) throw failure("backup_preview_changed", 409);
      // Validate every current replay marker before the first destructive write.
      // Only present-day markers may be restored; historical credentials/markers
      // in a downloaded file never grant access to an object.
      const currentCursor = this.staging.find({ operationId: staged.operationId, key: "games" }).batchSize(BATCH);
      /** @type {any[]} */ let page = [];
      const verify = async () => {
        await fence.assert();
        const currentRows = await this.db.games.find({ userId, gameId: { $in: page.map((row) => row.gameId) } }, { projection: { gameId: 1, replayFile: 1, playbackArtifact: 1 } }).toArray();
        const byId = new Map(currentRows.map((row) => [row.gameId, row]));
        await Promise.all(page.map(async (saved) => {
          const current = byId.get(saved.gameId); const data = cleanGame(saved.data);
          if (current?.replayFile && this.gdpr.replayFiles && await this.gdpr.replayFiles.verifyAvailableMarker(userId, saved.gameId, { ...current.replayFile, available: true }, { clearStale: false })) data.replayFile = current.replayFile;
          if (current?.playbackArtifact) data.playbackArtifact = current.playbackArtifact;
          await this.staging.updateOne({ _id: saved._id }, { $set: { data } });
        })); page = [];
      };
      for await (const saved of currentCursor) { page.push(saved); if (page.length >= 8) await verify(); }
      if (page.length) await verify();
      await this.gdpr._assertReplayCleanupAvailable({ userId });
      await this.create(userId, { type: "pre_action", label: "Before restore", assert: fence.assert });
      /** @type {string[]} */ let removed = [];
      const purge = async () => {
        await fence.assert();
        if (this.gdpr.replayFiles) await this.gdpr.replayFiles.deleteMany(userId, removed);
        if (this.gdpr.playbackArtifacts) await this.gdpr.playbackArtifacts.deleteMany(userId, removed);
        if (this.gdpr.gameDetails) { for (const gameId of removed) await this.gdpr.gameDetails.delete(userId, gameId); }
        else await this.db.gameDetails.deleteMany({ userId, gameId: { $in: removed } });
        removed = [];
      };
      for await (const row of this.missingGames(userId, staged.operationId)) { removed.push(row.gameId); if (removed.length >= BATCH) await purge(); }
      if (removed.length) await purge();
      await this.db.macroJobs.deleteMany({ userId });
      for (const [dbKey, key] of RESTORABLE) {
        await fence.assert(); const collection = /** @type {any} */ (this.db)[dbKey]; if (!collection) continue;
        // Keep the historical section readable for existing snapshot formats,
        // but credentials/lifecycle are current security state. Restoring an
        // older row must never revive a rotated leaked URL or erase its target.
        if (dbKey === "overlayTokens") continue;
        if (dbKey === "users") {
          await restoreUserSettings(this.db.users, userId, key, await this.staging.findOne({ operationId: staged.operationId, key }),
            this.gameStatsWrites.authority(statsOwner, { fenceId: fence.id }));
          continue;
        }
        if (dbKey === "games") contributionChanged = true;
        await gameWrite(dbKey === "games" ? this.userRevision : null, userId, async () => {
          if (dbKey === "games") await this.gameStatsWrites.deleteMany(statsOwner, liveBackupGamesMatch(userId), { fenceId: fence.id, assert: fence.assert });
          else await collection.deleteMany({ userId });
          if (dbKey === "games") this.gdpr.notifyGamesChanged?.(userId);
          /** @type {any[]} */ let rows = []; let bytes = 0;
          const flush = async () => {
            const batch = rows; rows = []; bytes = 0;
            await fence.assert();
            // The immutable staged batch can be retried by Mongo. No cursor,
            // notification, storage request or fence renewal is in callback.
            if (dbKey === "games") await this.gameStatsWrites.write(statsOwner,
              session => collection.insertMany(batch, session ? { session } : {}), { fenceId: fence.id });
            else await collection.insertMany(batch);
          };
          for await (const row of this.staging.find({ operationId: staged.operationId, key }).sort({ ordinal: 1 }).batchSize(BATCH)) {
            const data = { ...row.data, userId }; delete data._id; rows.push(data); bytes += BSON.calculateObjectSize(data);
            if (rows.length >= BATCH || bytes >= 4 * 1024 * 1024) await flush();
          }
          if (rows.length) await flush();
        });
      }
      if (this.gdpr.guideSamples) await this.gdpr.guideSamples.deleteForUser(userId);
      for await (const row of this.staging.find({ operationId: staged.operationId, key: "recountOpponent" }).batchSize(BATCH)) {
        await fence.assert(); await this.gdpr.recountOpponent(userId, String(row.gameId));
      }
      await this.gdpr._scrubUserGuideExamples(userId);
      return { restoredAt: new Date(), counts: { ...staged.counts, overlayTokens: 0 } };
    } finally {
      if (contributionChanged) this.gdpr.notifyGamesChanged?.(userId);
      await this.staging.deleteMany({ operationId: staged.operationId });
    }
  }
  /** Lazy, once-per-ISO-week CAS; a failed attempt leaves the next ingest able to retry. @param {string} userId @param {Date} [now] */
  weekly(userId, now = new Date()) {
    const task = this._weekly(userId, now); this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }
  /** @param {string} userId @param {Date} now */
  async _weekly(userId, now) {
    if (!this.store) return;
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); const week = day.toISOString().slice(0, 10);
    const claimed = await this.db.users.updateOne({ userId, "backups.week": { $ne: week }, $or: [{ "backups.leaseUntil": { $exists: false } }, { "backups.leaseUntil": { $lte: now } }] }, { $set: { "backups.leaseUntil": new Date(now.getTime() + 15 * 60 * 1000) } });
    if (!claimed.modifiedCount) return;
    try {
      // Auto creation is a reader: it must exclude erasure/restore, while
      // allowing the remaining batches of a desktop import to keep syncing.
      const lease = await claimUserDataLease(this.db.users, userId);
      try { await this.create(userId, { type: "auto", label: `Week of ${week}`, assert: lease.assert }); await this.db.users.updateOne({ userId }, { $set: { "backups.week": week }, $unset: { "backups.leaseUntil": "" } }); }
      finally { await lease.release(); }
    } catch (error) { await this.db.users.updateOne({ userId }, { $unset: { "backups.leaseUntil": "" } }); this.logger?.warn({ err: error, userId }, "weekly_backup_failed"); }
  }
}
module.exports = { UserBackupsService, RESTORABLE, STAGING, restoreUserSettings };
