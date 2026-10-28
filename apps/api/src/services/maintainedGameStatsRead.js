"use strict";

const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { PROTOCOL_VERSION, MAX_STATS_BYTES } = require("./gameStatsMaintenance");

// Fresh maintenance2 is a source-version boundary. Its use requires the
// qualified approved-writer cutover and causally bounded bootstrap contract.
const REQUIRED_MAINTENANCE_VERSION = 2;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const OWNER_STATS_PROJECTION = Object.freeze({
  _id: 1, userId: 1, _gdprMutation: 1, gameStatsProtocolVersion: 1,
  gameStatsWriterStatus: 1, gameStatsRevision: 1, gameStatsMutationEpoch: 1,
  gameStatsMaintenance: 1, "gameStats.total": 1, "gameStats.latest": 1,
});

/** @param {any} value */
function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
/** @param {unknown} value */
function isUuid(value) { return typeof value === "string" && UUID.test(value); }
/** @param {any} record @param {string[]} fields */
function hasFields(record, fields) { return isRecord(record) && fields.every(key => Object.hasOwn(record, key)); }
/** @param {any} left @param {any} right */
function sameBson(left, right) {
  return isDeepStrictEqual(BSON.serialize({ value: left }), BSON.serialize({ value: right }));
}
/** @param {any} row @param {string} userId */
function ownerMatches(row, userId) {
  return hasFields(row, ["_id", "userId"]) && row._id !== null && row._id !== undefined
    && row.userId === userId && !Object.hasOwn(row, "_gdprMutation");
}
/** Missing, explicit null and malformed epochs cannot be conflated.
 * @param {any} row @param {any} meta */
function epochMatches(row, meta) {
  if (!Object.hasOwn(row, "gameStatsMutationEpoch")) return !Object.hasOwn(meta, "epoch");
  return isUuid(row.gameStatsMutationEpoch) && Object.hasOwn(meta, "epoch") && meta.epoch === row.gameStatsMutationEpoch;
}
/** @param {any} row */
function writerMatches(row) {
  return row.gameStatsProtocolVersion === PROTOCOL_VERSION && row.gameStatsWriterStatus === "transactional";
}
/** @param {any} row @param {any} meta */
function maintenanceMatches(row, meta) {
  return hasFields(meta, ["version", "status", "ownerId", "revision"])
    && meta.version === REQUIRED_MAINTENANCE_VERSION && meta.status === "ready"
    && isUuid(row.gameStatsRevision) && meta.revision === row.gameStatsRevision
    && sameBson(meta.ownerId, row._id) && epochMatches(row, meta);
}
/** @param {any} stats */
function readyShape(stats) {
  if (!hasFields(stats, ["total", "latest"])) return false;
  if (!Number.isSafeInteger(stats.total) || stats.total < 0) return false;
  if (stats.latest !== null && !(stats.latest instanceof Date && Number.isFinite(stats.latest.getTime()))) return false;
  return (stats.total !== 0 || stats.latest === null) && BSON.calculateObjectSize(stats) <= MAX_STATS_BYTES;
}

/** A fresh same-command owner row only; never an auth DTO or retained promise.
 * Unknown/unsupported state returns null so the caller must invoke the
 * ORIGINAL authoritative stats. No query, repair, activation or write occurs.
 * @param {any} row @param {string} userId @param {boolean|undefined} transactionCapable
 * @returns {{total:number,latest:Date|null}|null} */
function readyStatsFromOwnerRow(row, userId, transactionCapable) {
  try {
    if (transactionCapable !== true || typeof userId !== "string" || !userId) return null;
    if (!ownerMatches(row, userId) || !writerMatches(row)) return null;
    if (!maintenanceMatches(row, row.gameStatsMaintenance) || !readyShape(row.gameStats)) return null;
    return { total: row.gameStats.total, latest: row.gameStats.latest === null ? null : new Date(row.gameStats.latest.getTime()) };
  } catch {
    // Malformed BSON/proof is a miss. Real Mongo errors occur outside this pure
    // helper and must retain their original query/route failure semantics.
    return null;
  }
}

module.exports = { readyStatsFromOwnerRow, OWNER_STATS_PROJECTION, REQUIRED_MAINTENANCE_VERSION };
