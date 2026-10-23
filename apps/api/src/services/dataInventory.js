"use strict";

const { TOKEN_COLLECTIONS } = require("./gdprOwnedData");
const QUERY_OPTIONS = { maxTimeMS: 5000 };

/** Counts only: never return tokens, filenames, messages or another owner's IDs.
 * Counts are a live estimate, not a reservation; erasure repeats ownership reads.
 * @param {import('../db/connect').DbContext} db @param {string} userId */
async function dataInventory(db, userId) {
  /** @type {Record<string,number>} */ const removed = {};
  /** @type {Record<string,number>} */ const anonymized = {};
  const fields = {
    games: ["games", "userId"], opponents: ["opponents", "userId"], notes: ["opponentNotes", "userId"],
    builds: ["customBuilds", "userId"], devices: ["deviceTokens", "userId"], overlayTokens: ["overlayTokens", "userId"],
    snapshots: ["userBackups", "userId"], sounds: ["multichatSounds", "userId"],
    publishedBuilds: ["communityBuilds", "ownerUserId"], reports: ["communityReports", "reporterUserId"],
    connectedAccounts: ["platformConnections", "userId"], notifications: ["notifications", "userId"],
    reviewRequests: ["reviewRequests", "userId"], playerChannels: ["playerChannels", "ownerUserId"],
  };
  await Promise.all(Object.entries(fields).map(async ([label, [key, field]]) => {
    removed[label] = await /** @type {any} */ (db)[key].countDocuments({ [field]: userId }, QUERY_OPTIONS);
  }));
  removed.archivedReplays = await db.games.countDocuments({ userId, "replayFile.storedAt": { $exists: true } }, QUERY_OPTIONS);
  removed.streamRows = 0;
  /** @type {string[]} */ let tokens = [];
  const countTokens = async () => {
    for (const key of TOKEN_COLLECTIONS) {
      const filter = key === "multichatStudio" ? { $or: [{ token: { $in: tokens } }, { studioKey: { $in: tokens } }] } : { token: { $in: tokens } };
      removed.streamRows += await /** @type {any} */ (db)[key].countDocuments(filter, QUERY_OPTIONS);
    }
    tokens = [];
  };
  for await (const row of db.overlayTokens.find({ userId }, { projection: { token: 1 } }).batchSize(100)) {
    if (typeof row.token === "string") tokens.push(row.token);
    if (tokens.length === 100) await countTokens();
  }
  if (tokens.length) await countTokens();
  // Comments on the caller's own requests are deleted with their thread. Only
  // comments retained on someone else's thread become "[deleted user]".
  const ownThreads = db.reviewRequests.find({ userId }, { projection: { _id: 1 } }).batchSize(100);
  removed.reviewThreadComments = 0;
  /** @type {any[]} */ let ids = [];
  let ownAuthored = 0;
  const countThreads = async () => {
    removed.reviewThreadComments += await db.reviewComments.countDocuments({ requestId: { $in: ids } }, QUERY_OPTIONS);
    ownAuthored += await db.reviewComments.countDocuments({ requestId: { $in: ids }, authorId: userId }, QUERY_OPTIONS);
    ids = [];
  };
  for await (const row of ownThreads) { ids.push(row._id); if (ids.length === 100) await countThreads(); }
  if (ids.length) await countThreads();
  anonymized.reviewComments = Math.max(0, await db.reviewComments.countDocuments({ authorId: userId }, QUERY_OPTIONS) - ownAuthored);
  if (db.adminAudit) anonymized.auditRows = await db.adminAudit.countDocuments({ $or: [{ actorUserId: userId }, { target: userId }] }, QUERY_OPTIONS);
  anonymized.activityEvents = await db.adminEvents.countDocuments({ "payload.userId": userId }, QUERY_OPTIONS);
  return { removed, anonymized, countedAt: new Date().toISOString() };
}

/** Public subset of the existing cached provider policy. No cluster identifiers,
 * snapshot IDs, private backup counts or credentials cross this boundary.
 * @param {import('./backupStatus').BackupStatusService} backupStatus */
async function publicDataRetention(backupStatus) {
  const status = await backupStatus.atlasStatus();
  const retention = Array.isArray(status.retention) ? status.retention.flatMap((row) => {
    const unit = row.unit;
    const value = row.keep;
    return ["days", "weeks", "months", "years"].includes(unit) && Number.isSafeInteger(value) && value > 0
      ? [{ unit, value }] : [];
  }) : [];
  return { available: status.available === true && status.stale !== true && retention.length > 0, retention, checkedAt: status.checkedAt || null };
}

module.exports = { dataInventory, publicDataRetention };
