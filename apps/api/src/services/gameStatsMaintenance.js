"use strict";
const { BSON } = require("mongodb");
const { randomUUID } = require("crypto");
const { isDeepStrictEqual } = require("util");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");

const PROTOCOL_VERSION = 2;
// Version2 is minted only after an acknowledged causal floor; version1 cannot
// supply its bootstrap delta base, even though the transaction protocol agrees.
const MAINTENANCE_VERSION = 2;
const MAX_SELECTION = 100;
const MAX_STATS_BYTES = 16 * 1024;
/** @typedef {{gameIds?:ReadonlyArray<string>,ids?:ReadonlyArray<any>}} StatsSelection */

/** Copy bounded selectors before any await. Values are server-prepared IDs,
 * never a caller-controlled query. No JS approximation of Mongo eligibility.
 * @param {StatsSelection|undefined} selection */
function immutableSelection(selection) {
  if (!selection || (Array.isArray(selection.gameIds) === Array.isArray(selection.ids))) throw failure("game_stats_selection_required");
  const key = Array.isArray(selection.gameIds) ? "gameId" : "_id";
  const values = key === "gameId" ? selection.gameIds : selection.ids;
  if (!values || values.length > MAX_SELECTION || (key === "gameId" && values.some(value => typeof value !== "string"))) throw failure("game_stats_selection_invalid");
  // BSON copy protects ObjectIds as well as arrays from external mutation.
  const copied = BSON.deserialize(BSON.serialize({ values })).values;
  return Object.freeze({ [key]: Object.freeze({ $in: Object.freeze(copied) }) });
}

/** @param {string} userId */
function statsMatch(userId) { return { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true } }; }
/** @param {any} left @param {any} right */
function sameBson(left, right) {
  try { return isDeepStrictEqual(BSON.serialize({ value: left }), BSON.serialize({ value: right })); }
  catch { return false; }
}
/** Prior state comes ONLY from the first atomic owner write's preimage.
 * Missing epoch and explicit null are distinct. dataRev is never consulted.
 * @param {any} before @param {import('./gameStatsWrites').GameStatsOwner} owner */
function qualifiedTotal(before, owner) {
  const meta = before?.gameStatsMaintenance, stats = before?.gameStats;
  if (!meta || !stats || before.gameStatsProtocolVersion !== PROTOCOL_VERSION
    || before.gameStatsWriterStatus !== "transactional" || meta.version !== MAINTENANCE_VERSION
    || !["ready", "unsupported_latest"].includes(meta.status)
    || typeof before.gameStatsRevision !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(before.gameStatsRevision) || meta.revision !== before.gameStatsRevision
    || !sameBson(meta.ownerId, owner.id) || !sameBson(before._id, owner.id)
    || !Object.hasOwn(stats, "latest") || !Number.isSafeInteger(stats.total) || stats.total < 0
    || (stats.latest !== null && !stats.latest) || (stats.total === 0 && stats.latest !== null)
    || meta.status !== latestStatus(stats.latest)) return null;
  if (!canRetain(stats)) return null;
  if (owner.epoch === undefined ? Object.hasOwn(meta, "epoch") || Object.hasOwn(before, "gameStatsMutationEpoch")
    : meta.epoch !== owner.epoch || before.gameStatsMutationEpoch !== owner.epoch) return null;
  return stats.total;
}

/** The ORIGINAL sorted query: array sort keys and truthy legacy BSON values
 * cannot be replaced by $max, JavaScript comparison, coercion or a tie breaker.
 * @param {import('mongodb').Collection} games @param {Record<string,any>} match
 * @param {import('mongodb').ClientSession} session */
async function latestValue(games, match, session) {
  const rows = await games.find(match, { projection: { date: 1, _id: 0 }, session }).sort({ date: -1 }).limit(1).toArray();
  return rows[0]?.date || null;
}

/** @param {any} latest */
function latestStatus(latest) {
  return latest === null || (latest instanceof Date && Number.isFinite(latest.getTime())) ? "ready" : "unsupported_latest";
}

/** Unsupported BSON may not round-trip through a JS driver value (notably
 * out-of-range BSON Date -> Invalid Date). Never persist a normalized value.
 * @param {{total:number,latest:any}} stats */
function canRetain(stats) {
  try {
    if (BSON.calculateObjectSize(stats) > MAX_STATS_BYTES) return false;
    if (latestStatus(stats.latest) === "ready") return true;
    return isDeepStrictEqual(stats.latest, BSON.deserialize(BSON.serialize({ value: stats.latest })).value);
  } catch { return false; }
}

/** All commands use the existing transaction. Work is prepared Mongo-only
 * mutation; external effects/cursors/notifications stay outside retries.
 * @template T @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Record<string,any>} authority @param {Readonly<Record<string,any>>} selection
 * @param {(session:import('mongodb').ClientSession)=>Promise<T>} work
 * @param {import('mongodb').ClientSession} session @returns {Promise<T>} */
async function maintainGameStats(db, owner, authority, selection, work, session) {
  const revision = randomUUID();
  const before = await db.users.findOneAndUpdate(authority, {
    $set: { gameStatsProtocolVersion: PROTOCOL_VERSION, gameStatsRevision: revision, gameStatsWriterStatus: "transactional" },
    $unset: { gameStats: "", gameStatsMaintenance: "" },
  }, { session, upsert: false, returnDocument: "before", includeResultMetadata: false,
    projection: { _id: 1, gameStats: 1, gameStatsRevision: 1, gameStatsProtocolVersion: 1, gameStatsWriterStatus: 1, gameStatsMutationEpoch: 1, gameStatsMaintenance: 1 } });
  if (!before) throw failure("game_stats_authority_changed");
  const match = statsMatch(owner.userId), subset = { $and: [match, selection] };
  const previous = qualifiedTotal(before, owner);
  const beforeCount = previous === null ? null : await db.games.countDocuments(subset, { session });
  const result = await work(session);
  let total = previous === null ? await db.games.countDocuments(match, { session })
    : previous + await db.games.countDocuments(subset, { session }) - /** @type {number} */ (beforeCount);
  if (!Number.isSafeInteger(total) || total < 0) total = await db.games.countDocuments(match, { session });
  const latest = await latestValue(db.games, match, session);
  if (total === 0 && latest !== null) total = await db.games.countDocuments(match, { session });
  const metadata = { version: MAINTENANCE_VERSION, ownerId: owner.id, revision,
    ...(owner.epoch === undefined ? {} : { epoch: owner.epoch }), status: latestStatus(latest) };
  const stats = { total, latest };
  const retain = Number.isSafeInteger(total) && total >= 0 && canRetain(stats);
  // Unsupported raw latest stays raw. Its status cannot qualify a future reader.
  // Oversize/unserializable data retires retention; authoritative reads still
  // return their exact old answer, never a normalized placeholder.
  const update = retain ? { $set: { gameStats: stats, gameStatsMaintenance: metadata } }
    : { $set: { gameStatsMaintenance: { ...metadata, status: "unretained" } }, $unset: { gameStats: "" } };
  const saved = await db.users.updateOne({ ...authority, gameStatsRevision: revision, gameStatsProtocolVersion: PROTOCOL_VERSION }, update, { session, upsert: false });
  if (saved.matchedCount !== 1) throw failure("game_stats_authority_changed");
  return result;
}
/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { maintainGameStats, immutableSelection, statsMatch, qualifiedTotal, latestValue,
  PROTOCOL_VERSION, MAINTENANCE_VERSION, MAX_SELECTION, MAX_STATS_BYTES };
