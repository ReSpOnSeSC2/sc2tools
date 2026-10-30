"use strict";

const { ownerBuildFlags } = require("./buildIntentReaders");
const { COLLECTIONS } = require("../config/constants");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { OPPONENT_RACES, OPPONENT_RACE_LETTER } = require("../util/opponentRaceHistory");
const SUMMARY_FIELDS = ["_listTotal", "_listDurationSum", "_listDurationSamples", "_listMacroSum", "_listMacroSamples", "_listLatest", "_listCandidates", "_listDetailRows"];
const LIST_DETAIL_QUERY_OPTIONS = Object.freeze({ maxTimeMS: 5000, timeoutMS: 5000 });
const MAX_DETAIL_CANDIDATES = 5000;
const MAX_OPPONENT_CANDIDATES = 25;

/** @param {string} field @param {number} max */
function validNumber(field, max) {
  return { $and: [{ $isNumber: field }, { $gte: [field, 0] }, { $lte: [field, max] }] };
}

/** Only used for the explicitly requested list summaries. No detail hydration.
 * @returns {Record<string, any>[]}
 */
function listDetailStages() {
  return [{ $set: {
    _opponentListDate: { $convert: { input: "$date", to: "date", onError: null, onNull: null } },
    _opponentListGameId: { $cond: [{ $eq: [{ $type: "$gameId" }, "string"] }, "$gameId", ""] },
    _opponentListDuration: { $cond: [validNumber("$durationSec", 86400), { $toDouble: "$durationSec" }, null] },
    _opponentListMacro: { $cond: [validNumber("$macroScore", 100), { $toDouble: "$macroScore" }, null] },
  } }, { $set: {
    _opponentListEligible: { $and: [
      { $ne: ["$_opponentListDate", null] },
      { $regexMatch: { input: "$_opponentListGameId", regex: "^[^\\x00-\\x1f\\x7f]{1,200}$" } },
      { $not: [{ $in: ["$_opponentListGameId", [".", ".."]] }] },
    ] },
  } }];
}

/** Explicit scalar output excludes notes, replay object keys and heavy logs.
 * @returns {Record<string, any>}
 */
function latestGameOutput() {
  /** @param {string} field @param {number} [limit] */
  const label = (field, limit = 200) => ({ $cond: [
    { $eq: [{ $type: field }, "string"] }, { $substrCP: [field, 0, limit] }, null,
  ] });
  return {
    gameId: "$_opponentListGameId", date: "$_opponentListDate",
    map: label("$map"), result: label("$result", 24), durationSec: "$_opponentListDuration",
    myBuild: label("$myBuild"), opponent: { strategy: label("$opponent.strategy") },
    macroScore: "$_opponentListMacro",
    top3Leaks: { $map: { input: { $slice: [{ $cond: [{ $isArray: "$top3Leaks" }, "$top3Leaks", []] }, 3] }, as: "leak", in: { $cond: [
      { $eq: [{ $type: "$$leak.name" }, "string"] }, { $substrCP: ["$$leak.name", 0, 120] }, null,
    ] } } },
    replayFile: {
      sizeBytes: { $cond: [validNumber("$replayFile.sizeBytes", Number.MAX_SAFE_INTEGER), "$replayFile.sizeBytes", null] },
      storedAt: { $convert: { input: "$replayFile.storedAt", to: "date", onError: null, onNull: null } },
    },
    buildIntent: {
      status: label("$buildIntent.status", 24), applied: { $eq: ["$buildIntent.applied", true] },
      build: { name: label("$buildIntent.build.name") }, detected: { name: label("$buildIntent.detected.name") },
      opponent: {
        status: label("$buildIntent.opponent.status", 24), applied: { $eq: ["$buildIntent.opponent.applied", true] },
        build: { name: label("$buildIntent.opponent.build.name") }, detected: { name: label("$buildIntent.opponent.detected.name") },
      },
    },
  };
}

/** Add to the existing per-pulse group; fixed memory per returned opponent.
 * @param {number} candidateCount
 * @returns {Record<string, any>}
 */
function listDetailGroup(candidateCount) {
  return {
    _listTotal: { $sum: 1 },
    _listDurationSum: { $sum: "$_opponentListDuration" },
    _listDurationSamples: { $sum: { $cond: [{ $ne: ["$_opponentListDuration", null] }, 1, 0] } },
    _listMacroSum: { $sum: "$_opponentListMacro" },
    _listMacroSamples: { $sum: { $cond: [{ $ne: ["$_opponentListMacro", null] }, 1, 0] } },
    _listLatest: { $top: {
      sortBy: { _opponentListEligible: -1, _opponentListDate: -1, _opponentListGameId: 1 },
      output: { $cond: ["$_opponentListEligible", latestGameOutput(), null] },
    } },
    _listCandidates: { $topN: {
      sortBy: { _opponentListEligible: -1, _opponentListDate: -1, _opponentListGameId: 1 },
      n: candidateCount,
      output: { $cond: ["$_opponentListEligible", {
        gameId: "$_opponentListGameId", date: "$_opponentListDate",
      }, null] },
    } },
  };
}

/** @param {unknown} value @param {number} [limit] */
function text(value, limit = 200) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return Array.from(value.trim()).slice(0, limit).join("");
}

/** @param {unknown} value */
function dateString(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

/** Same eligibility as Mongo; IDs are opaque and must never be label-trimmed.
 * @param {unknown} value @returns {string|null}
 */
function gameIdentifier(value) {
  if (typeof value !== "string" || value === "." || value === "..") return null;
  const length = Array.from(value).length;
  return length >= 1 && length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/** @param {any} row */
function datedGame(row) {
  const gameId = gameIdentifier(row?.gameId);
  const date = dateString(row?.date);
  return gameId && date ? { gameId, date } : null;
}

/** @param {any} row */
function serializeLatestGame(row) {
  const identity = datedGame(row);
  if (!identity) return null;
  const replaySize = typeof row.replayFile?.sizeBytes === "number"
    && Number.isSafeInteger(row.replayFile.sizeBytes) && row.replayFile.sizeBytes > 0
    ? row.replayFile.sizeBytes : null;
  const flags = ownerBuildFlags(row);
  return {
    ...identity, map: text(row.map), result: text(row.result, 24),
    durationSec: row.durationSec ?? null, myBuild: text(row.myBuild), oppStrategy: text(row.opponent?.strategy),
    ...flags, detectedBuild: text(flags.detectedBuild), detectedOppStrategy: text(flags.detectedOppStrategy),
    macroScore: row.macroScore ?? null,
    top3Leaks: (row.top3Leaks || []).map((/** @type {unknown} */ name) => text(name, 120)).filter(Boolean).slice(0, 3),
    replayAvailable: replaySize !== null && dateString(row.replayFile?.storedAt) !== null,
    replaySizeBytes: replaySize,
  };
}

/** Remove all intermediate fields, including on empty/no-game fast-path rows.
 * @param {Record<string, any>} row @param {boolean} confirmedMongo
 */
function applyListDetails(row, confirmedMongo) {
  const durationSum = row._listDurationSum || 0;
  const durationSamples = row._listDurationSamples || 0;
  const macroSum = row._listMacroSum || 0;
  const macroSamples = row._listMacroSamples || 0;
  Object.assign(row, {
    latestGame: serializeLatestGame(row._listLatest),
    duration: { sumSec: durationSum, samples: durationSamples, averageSec: durationSamples ? durationSum / durationSamples : null },
    macro: { sum: macroSum, samples: macroSamples, average: macroSamples ? macroSum / macroSamples : null },
    ...indexedBuildOrder(row, confirmedMongo),
  });
  for (const key of SUMMARY_FIELDS) delete row[key];
}

/** R2 metadata describes the last indexed object, not guaranteed current state
 * after a later PUT's metadata acknowledgement fails. Never infer absence.
 * Even a row without storedIn can be obsolete after a first R2 PUT whose
 * initial metadata update failed. Require the active backend to prove Mongo.
 * @param {Record<string, any>} row @param {boolean} confirmedMongo
 */
function indexedBuildOrder(row, confirmedMongo) {
  const metadata = new Map((row._listDetailRows || []).map((/** @type {any} */ item) => [item.gameId, item]));
  const candidates = (row._listCandidates || []).filter((/** @type {any} */ item) => datedGame(item));
  let latest = null;
  let complete = confirmedMongo === true && row._listTotal > 0 && candidates.length === row._listTotal;
  for (const candidate of candidates) {
    const detail = /** @type {any} */ (metadata.get(candidate.gameId));
    const stamp = detail?.opponentListDetail?.opponentBuildOrder;
    const valid = detail?.opponentListDetail?.v === 1 && stamp?.v === 1 && typeof stamp.available === "boolean";
    if (!valid || detail.storedIn === "r2") complete = false;
    if (valid && stamp.available === true && latest === null) latest = datedGame(candidate);
  }
  return { latestOppBuildOrder: latest, opponentBuildOrderAvailability: complete ? "known" : "unknown" };
}

/** Exactly one narrow indexed join for each page-scoped candidate group.
 * @param {string} userId
 */
function listDetailLookup(userId) {
  return { $lookup: {
    from: COLLECTIONS.GAME_DETAILS,
    localField: "_listCandidates.gameId", foreignField: "gameId",
    pipeline: [{ $match: { userId } }, { $project: {
      _id: 0, gameId: 1, storedIn: 1, "opponentListDetail.v": 1,
      "opponentListDetail.opponentBuildOrder.v": 1,
      "opponentListDetail.opponentBuildOrder.available": 1,
    } }],
    as: "_listDetailRows",
  } };
}

/** Build only after page selection: bounded groups and <=5000 total candidates.
 * Facets are unwound before return, avoiding a single page-sized BSON document.
 * @param {string} userId @param {Record<string, any>} match @param {string[]} pulseIds
 * @returns {Record<string, any>[]}
 */
function listDetailsPipeline(userId, match, pulseIds) {
  const candidateCount = Math.min(MAX_OPPONENT_CANDIDATES, Math.floor(MAX_DETAIL_CANDIDATES / pulseIds.length));
  return [
    { $match: { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true }, "opponent.pulseId": { $in: pulseIds } } },
    { $facet: {
      names: [
        { $match: { "opponent.displayName": { $type: "string", $ne: "" } } },
        { $group: { _id: "$opponent.pulseId", _listName: { $top: {
          sortBy: { date: -1 }, output: { $substrCP: ["$opponent.displayName", 0, 200] },
        } } } },
      ],
      details: [
        { $match: match }, ...listDetailStages(),
        { $group: {
          _id: "$opponent.pulseId", latestDate: { $max: "$date" },
          latestRace: { $top: { sortBy: { date: -1, gameId: 1 }, output: OPPONENT_RACE_LETTER } },
          races: { $addToSet: OPPONENT_RACE_LETTER },
          ...listDetailGroup(candidateCount),
        } },
        listDetailLookup(userId),
      ],
    } },
    { $project: { rows: { $concatArrays: ["$names", "$details"] } } },
    { $unwind: "$rows" }, { $replaceRoot: { newRoot: "$rows" } },
  ];
}

/** Replaces the existing latest-name batch (and unfiltered latest-seen batch).
 * Never reads R2 or adds a request per opponent.
 * @param {import('mongodb').Collection} games @param {string} userId
 * @param {Record<string, any>} match @param {any[]} rows @param {boolean} [confirmedMongo]
 */
async function overlayListDetails(games, userId, match, rows, confirmedMongo = false) {
  if (!rows.length) return;
  const pulseIds = [...new Set(rows.map((row) => row.pulseId).filter((id) => typeof id === "string" && id.length > 0))];
  if (!pulseIds.length) return;
  if (pulseIds.length > MAX_DETAIL_CANDIDATES) throw new Error("opponent_list_detail_page_limit");
  const summaries = await games.aggregate(listDetailsPipeline(userId, match, pulseIds), LIST_DETAIL_QUERY_OPTIONS).toArray();
  const byId = new Map(summaries.filter((summary) => summary._listTotal !== undefined).map((summary) => [summary._id, summary]));
  const names = new Map(summaries.filter((summary) => typeof summary._listName === "string").map((summary) => [summary._id, summary._listName]));
  for (const row of rows) {
    const latestName = names.get(row.pulseId);
    if (latestName) row.displayNameSample = latestName;
    const summary = byId.get(row.pulseId);
    if (summary) {
      for (const key of SUMMARY_FIELDS) row[key] = summary[key];
      row.races = OPPONENT_RACES.filter(race => summary.races.includes(race));
      if (summary.latestRace) row.race = summary.latestRace;
      if (summary.latestDate instanceof Date && summary.latestDate > (row.lastSeen || new Date(0))) row.lastPlayed = summary.latestDate;
    }
    applyListDetails(row, confirmedMongo);
  }
}

module.exports = { listDetailsPipeline, overlayListDetails, LIST_DETAIL_QUERY_OPTIONS, MAX_DETAIL_CANDIDATES, MAX_OPPONENT_CANDIDATES };
