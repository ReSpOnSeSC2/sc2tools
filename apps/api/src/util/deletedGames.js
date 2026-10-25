"use strict";

/** Existing owner/game index, bounded ID membership only. Pending deletion is
 * already an irrevocable owner intent; it must fence delayed blob writers.
 * @param {import('mongodb').Collection} games @param {string} userId @param {string[]} gameIds */
async function deletedGameIds(games, userId, gameIds) {
  const ids = [...new Set(gameIds)].slice(0, 1000);
  if (!ids.length) return new Set();
  const rows = await games.find({ userId, gameId: { $in: ids }, $or: [{ _deleted: true }, { _deletionPending: true }] }, {
    projection: { _id: 0, gameId: 1 },
  }).hint({ userId: 1, gameId: 1 }).toArray();
  return new Set(rows.map(row => String(row.gameId)));
}

function gameDeletedError() { return Object.assign(new Error("game_deleted"), { status: 410, code: "game_deleted" }); }
module.exports = { deletedGameIds, gameDeletedError };
