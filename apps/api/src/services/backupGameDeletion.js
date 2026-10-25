"use strict";
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");

/** Older snapshots cannot revive a permanent owner deletion. Walk existing
 * staging rows in bounded pages and use the already-unique owner/game index.
 * Recount markers are local to this disposable restore staging operation.
 * @param {import('../db/connect').DbContext} db
 * @param {import('mongodb').Collection} staging
 * @param {string} userId @param {string} operationId
 * @param {Record<string,number>} counts */
async function protectDeletedSnapshotGames(db, staging, userId, operationId, counts) {
  /** @type {any[]} */ let page = [];
  const flush = async () => {
    const ids = page.map(row => row.gameId);
    const blocked = await db.games.find({ userId, gameId: { $in: ids }, $or: [{ _deleted: true }, { _deletionPending: true }] }, {
      projection: { _id: 0, gameId: 1 },
    }).hint({ userId: 1, gameId: 1 }).toArray();
    const blockedIds = new Set(blocked.map(row => row.gameId));
    const removed = page.filter(row => blockedIds.has(row.gameId) || row.data?._deleted || row.data?._deletionPending);
    if (removed.length) {
      const result = await staging.deleteMany({ operationId, key: "games", gameId: { $in: removed.map(row => row.gameId) } });
      counts.games -= result.deletedCount;
      for (const pulseId of new Set(removed.map(row => row.data?.opponent?.pulseId).filter(value => typeof value === "string" && value))) {
        await staging.updateOne({ operationId, key: "recountOpponent", gameId: pulseId }, { $setOnInsert: stampVersion({
          operationId, key: "recountOpponent", userId, gameId: pulseId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }, COLLECTIONS.BACKUP_RESTORE_STAGING) }, { upsert: true });
      }
    }
    page = [];
  };
  for await (const row of staging.find({ operationId, key: "games" }, { projection: { gameId: 1, "data._deleted": 1, "data._deletionPending": 1, "data.opponent.pulseId": 1 } }).batchSize(100)) {
    page.push(row); if (page.length === 100) await flush();
  }
  if (page.length) await flush();
}

/** @param {string} userId */
function liveBackupGamesMatch(userId) { return { userId, ...LIVE_GAME_MATCH }; }
module.exports = { protectDeletedSnapshotGames, liveBackupGamesMatch };
