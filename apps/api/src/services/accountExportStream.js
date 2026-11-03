"use strict";

const { accountExportRecords, checkExportSignal } = require("./accountExportData");
const { HEAVY_FIELDS } = require("./gameDetails");

// Explicit encoded-record budget, not a guarantee that every 16MiB BSON document
// fits after JSON escaping. Over-budget records terminate an incomplete export.
const MAX_RECORD_BYTES = 17 * 1024 * 1024;

/** @param {object} record */
function encodeRecord(record) {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") + 1 > MAX_RECORD_BYTES) throw new Error("export_record_too_large");
  return Buffer.from(json + "\n", "utf8");
}

/** One detail result retained at a time. Strict reads cannot silently skip R2
 * errors; a genuinely absent/deleted detail is an explicit missing record.
 * @param {import('./gameDetails').GameDetailsService|null} details
 * @param {string} userId @param {any} game @param {AbortSignal|undefined} signal
 */
async function detailRecord(details, userId, game, signal) {
  checkExportSignal(signal);
  if (!details || typeof game.gameId !== "string" || !game.gameId) throw new Error("export_details_unavailable");
  const rows = await details.findMany(userId, [game.gameId], { fields: [...HEAVY_FIELDS], concurrency: 1, strict: true, signal });
  checkExportSignal(signal);
  const row = rows.get(game.gameId);
  return { type: "record", collection: "gameDetails", row: row === undefined
    ? { gameId: game.gameId, status: "missing" }
    : { gameId: game.gameId, status: "available", details: row } };
}

/** Full account transport, never accepted as a restorable sc2tools-backup.
 * Completion is mandatory: EOF without a complete record means incomplete.
 * Only the authenticated entry-point owner is retained through asynchronous work.
 * @param {any} db @param {import('./gameDetails').GameDetailsService|null} details
 * @param {string} userId
 * @param {{details?:boolean,reviews?:boolean,signal?:AbortSignal}} [options]
 */
async function* accountExportStream(db, details, userId, options = {}) {
  const { signal } = options;
  checkExportSignal(signal);
  yield encodeRecord({ type: "metadata", format: "sc2tools-account-export", version: 1,
    userId, exportedAt: new Date().toISOString(), details: options.details === true });
  /** @type {Record<string,number>} */ const counts = {};
  if (options.details) { counts.gameDetails = 0; yield encodeRecord({ type: "collection", name: "gameDetails" }); }
  for await (const record of accountExportRecords(db, userId, options)) {
    checkExportSignal(signal);
    if (record.type === "collection") counts[record.name] = 0;
    if (record.type === "record") counts[record.collection] += 1;
    yield encodeRecord(record);
    checkExportSignal(signal);
    if (options.details && record.type === "record" && record.collection === "games") {
      const detail = await detailRecord(details, userId, record.row, signal);
      counts.gameDetails += 1;
      yield encodeRecord(detail);
    }
  }
  checkExportSignal(signal);
  yield encodeRecord({ type: "complete", counts });
}

module.exports = { accountExportStream };
