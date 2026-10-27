"use strict";

const { MAX_DATE_MS } = require("./sessions");
const { gamesMatchStage } = require("../util/parseQuery");
const { BUILD_INTENT_LABEL_PROJECTION } = require("./buildIntentShape");
const { withOwnerBuildFlags } = require("./buildIntentReaders");
const { historyError } = require("./sessionHistoryDescriptor");
const MAX_ROWS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const MONGO_MS = 2000;
const HISTORY_PROJECTION = Object.freeze({ _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, myLadderRace: 1,
  myBuild: 1, myToonHandle: 1, myMmr: 1, myMmrSource: 1, durationSec: 1, macroScore: 1, map: 1,
  gameVersion: 1, gameBuild: 1, matchFormat: 1, playerCount: 1, isLadderGame: 1,
  "replayFile.storedAt": 1, "replayFile.sizeBytes": 1,
  "opponent.displayName": 1, "opponent.race": 1, "opponent.toonHandle": 1, "opponent.mmr": 1,
  ...BUILD_INTENT_LABEL_PROJECTION });

/** @param {object} match @param {import('./sessionHistoryTypes').HistorySpan} span */
function buildHistoryPipeline(match, span) {
  return [ { $match: { ...match, date: { $gte: new Date(span.scanFrom), $lte: new Date(span.scanTo) } } },
    { $match: { $expr: { $eq: [{ $type: "$date" }, "date"] } } },
    { $sort: { date: -1, _id: -1 } }, { $limit: MAX_ROWS + 1 }, { $project: HISTORY_PROJECTION } ];
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value @param {number} cap @returns {string|null} */
function text(value, cap) {
  if (typeof value !== "string") return null;
  if (value.length > cap * 2 || [...value].length > cap) throw historyError("session_history_field_limit", 422);
  return value;
}
/** Canonical bounded table inputs, never spread a stored row into a DTO.
 * @param {Record<string,unknown>} row */
function tableMetadata(row) {
  const opponent = object(row.opponent);
  return { ...replayState(row), map: text(row.map, 200), myRace: text(row.myRace, 24),
    opponent: { displayName: text(opponent.displayName, 200), race: text(opponent.race, 24), toonHandle: text(opponent.toonHandle, 64), mmr: number(opponent.mmr, 0, 9999) },
    gameVersion: text(row.gameVersion, 64), gameBuild: number(row.gameBuild, 0, Number.MAX_SAFE_INTEGER),
    matchFormat: text(row.matchFormat, 24), playerCount: number(row.playerCount, 0, 16), isLadderGame: typeof row.isLadderGame === "boolean" ? row.isLadderGame : null,
    buildPlanned: row.buildPlanned === true, detectedBuild: text(row.detectedBuild, 200) };
}
/** Only archive availability/size leave the service, never file keys or URLs.
 * @param {Record<string,unknown>} row */
function replayState(row) {
  const file = object(row.replayFile), raw = file.storedAt;
  const at = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  const size = typeof file.sizeBytes === "number" && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 ? file.sizeBytes : null;
  return { replayAvailable: size !== null && Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS, replaySizeBytes: size };
}
/** @param {unknown} value @param {number} min @param {number} max */
function number(value, min, max) { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null; }
/** @param {unknown} value @param {number} cap @returns {unknown} */
function scalar(value, cap) {
  if (typeof value === "string") { text(value, cap); return value; }
  if (value === undefined || value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  return {}; // bounded unsupported-rank sentinel; never traverse a legacy object.
}
/** Retain only the helper's supported inputs; raw private buildIntent disappears
 * through the existing reader before byte accounting, hashing or serialization.
 * @param {Record<string,unknown>} raw */
function normalizedRow(raw) {
  const row = /** @type {Record<string,unknown>} */ (withOwnerBuildFlags(raw));
  const opponent = object(row.opponent);
  return { gameId: scalar(row.gameId, 200), date: row.date, result: scalar(row.result, 64), myRace: scalar(row.myRace, 24), myLadderRace: scalar(row.myLadderRace, 24),
    matchFormat: scalar(row.matchFormat, 24), playerCount: scalar(row.playerCount, 64), isLadderGame: scalar(row.isLadderGame, 64),
    myToonHandle: scalar(row.myToonHandle, 64), myMmr: scalar(row.myMmr, 64), myMmrSource: scalar(row.myMmrSource, 64), durationSec: scalar(row.durationSec, 64),
    macroScore: scalar(row.macroScore, 64), myBuild: scalar(row.myBuild, 200), buildPlanned: row.buildPlanned, detectedBuild: scalar(row.detectedBuild, 200),
    opponent: { toonHandle: scalar(opponent.toonHandle, 64), race: scalar(opponent.race, 24) }, table: tableMetadata(row) };
}
/** Narrow stream adapter consumed from the actual aggregate cursor. No cursor
 * implementation is replaced in product code.
 * @typedef {{next:()=>Promise<Record<string,unknown>|null>,close:()=>Promise<void>}} HistoryCursor */

/** Read one normalized row at a time. Account for [] and every comma exactly;
 * row5001 is a read sentinel, never a member or a silently clipped session.
 * @param {HistoryCursor} cursor @param {()=>void} check */
async function readHistoryCursor(cursor, check) {
  /** @type {Array<ReturnType<typeof normalizedRow>>} */ const rows = [];
  let bytes = 2;
  for (;;) {
    check();
    const raw = await cursor.next();
    check();
    if (raw === null) return { overflow: false, rows };
    if (rows.length === MAX_ROWS) return { overflow: true, rows: [] };
    const row = normalizedRow(raw);
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (rows.length ? 1 : 0);
    if (bytes > MAX_BYTES) return { overflow: true, rows: [] };
    rows.push(row);
  }
}
/** @param {Pick<import('../db/connect').DbContext,'games'>} db @param {string} owner
 * @param {import('./sessionHistoryTypes').HistoryContext} context @param {()=>void} check */
async function queryHistoryRows(db, owner, context, check) {
  check();
  if (context.span.scanFrom > context.span.scanTo) return { overflow: false, rows: [] };
  const match = gamesMatchStage(owner, context.filters);
  const cursor = db.games.aggregate(buildHistoryPipeline(match, context.span),
    { maxTimeMS: MONGO_MS, allowDiskUse: false, batchSize: 32, collation: { locale: "simple" } });
  let failed = false;
  try { return await readHistoryCursor(cursor, check); }
  catch (error) {
    failed = true;
    if (error && typeof error === "object" && "code" in error && error.code === 50) throw historyError("session_history_unavailable", 503);
    throw error;
  } finally {
    // The gate owns this work until cleanup settles, even after the caller's
    // deadline. A cleanup failure must never replace an existing read/guard error.
    try { await cursor.close(); } catch (error) { if (!failed) throw error; }
  }
}
module.exports = { HISTORY_PROJECTION, MAX_ROWS, MAX_BYTES, MONGO_MS, buildHistoryPipeline, queryHistoryRows, tableMetadata };
