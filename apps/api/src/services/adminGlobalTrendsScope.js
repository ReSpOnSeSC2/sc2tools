"use strict";

const { parseFilters, parseFiniteInt, parseBool, parseRaceLetter } = require("../util/parseQuery");
const { raceLetterExpr, myLadderRaceExpr } = require("./trendsRegionExpr");

// Dedupe retains $$ROOT twice. Keep legacy detail blobs, signatures and
// unrelated metadata out of those blocking sorts and accumulator tables.
const GLOBAL_HISTORY_PROJECTION = Object.freeze({
  _id: 1, userId: 1, gameId: 1, date: 1, updatedAt: 1,
  myToonHandle: 1, myRace: 1, myLadderRace: 1, myMmr: 1, myMmrSource: 1,
  isLadderGame: 1, isResumedFromReplay: 1, playerCount: 1, matchFormat: 1,
  result: 1, durationSec: 1, map: 1, myBuild: 1, macroScore: 1,
  "top3Leaks.name": 1, "replayFile.sha256": 1,
  "opponent.race": 1, "opponent.mmr": 1, "opponent.strategy": 1,
  "opponent.displayName": 1, "opponent.pulseId": 1, "opponent.pulseCharacterId": 1,
  "opponent.toonHandle": 1, "opponent.region": 1,
});

const GLOBAL_ROSTER_PROJECTION = Object.freeze({
  _id: 1, userId: 1, gameId: 1, date: 1, updatedAt: 1,
  myToonHandle: 1, myRace: 1, myLadderRace: 1, myMmr: 1, myMmrSource: 1,
  isLadderGame: 1, playerCount: 1, "replayFile.sha256": 1,
});

/** @param {unknown} raw */
function csv(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values.flatMap((v) => typeof v === "string" ? v.split(",") : [])
    .map((v) => v.trim()).filter(Boolean))];
}

/** Admin-only additions; ordinary analytics never consume these controls.
 * @param {Record<string, unknown>} query */
function parseGlobalTrendsFilters(query) {
  let min = parseFiniteInt(query.player_mmr_min);
  let max = parseFiniteInt(query.player_mmr_max);
  if (min !== undefined) min = Math.max(0, Math.min(10000, min));
  if (max !== undefined) max = Math.max(0, Math.min(10000, max));
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  return {
    filters: parseFilters(query),
    excludedRaces: csv(query.excluded_races)
      .filter((race) => /^(?:P|T|Z|R|U|Protoss|Terran|Zerg|Random|Unknown)$/i.test(race))
      .map((race) => /^(?:U|Unknown)$/i.test(race) ? "U" : parseRaceLetter(race)).filter(Boolean),
    excludedPlayers: csv(query.excluded_players),
    includedPlayers: csv(query.included_players),
    selection: query.player_selection === "include" || query.included_players !== undefined ? "include" : "all",
    mmrMin: min,
    mmrMax: max,
    includeUnrated: query.include_unrated === undefined ? true : parseBool(query.include_unrated),
  };
}

/** @param {any} field */
function stringExpr(field) {
  return { $trim: { input: { $convert: { input: field, to: "string", onError: "", onNull: "" } } } };
}

function trustedReplayMmrExpr() {
  return { $and: [
    { $isNumber: "$myMmr" }, { $gt: ["$myMmr", 0] },
    { $eq: ["$myMmrSource", "replay"] },
    { $eq: ["$isLadderGame", true] }, { $eq: ["$playerCount", 2] },
    { $in: [myLadderRaceExpr(), ["P", "T", "Z", "R"]] },
  ] };
}

/** Keep one uploaded perspective per account/replay. Two opposing players
 * remain two observations. Legacy rows stay scoped to their uploader because
 * an account cannot safely be inferred from a name or another replay.
 * @param {Record<string, any>} [playerMatch]
 * @param {Record<string, number>} [projection]
 * @returns {Array<Record<string, any>>} */
function globalHistoryStages(playerMatch = {}, projection = GLOBAL_HISTORY_PROJECTION) {
  return [
    { $match: { isResumedFromReplay: { $ne: true }, date: { $type: "date" } } },
    { $project: projection },
    { $addFields: { _globalToon: stringExpr("$myToonHandle"), _globalTrustedMmr: trustedReplayMmrExpr() } },
    { $addFields: {
      _globalPlayerId: { $cond: [
        { $ne: ["$_globalToon", ""] }, "$_globalToon",
        { $concat: ["user:", stringExpr("$userId")] },
      ] },
      _globalPlayedRace: raceLetterExpr("$myRace"),
    } },
    // Cohort membership is constant over a player's history and can safely
    // precede deduplication and sequence windows, avoiding global sorts when
    // an administrator narrows the cohort to just a few accounts.
    ...(Object.keys(playerMatch).length ? [{ $match: { _globalPlayerId: playerMatch } }] : []),
    // Prefer trustworthy/newly computed metadata, with a deterministic tie.
    { $sort: { _globalTrustedMmr: -1, updatedAt: -1, _id: 1 } },
    { $group: {
      _id: { player: "$_globalPlayerId", replay: { $ifNull: ["$gameId", { $toString: "$_id" }] } },
      row: { $first: "$$ROOT" },
    } },
    { $replaceWith: "$row" },
    // A replay renamed between uploads can have a different legacy gameId.
    // Deduplicate exact file hashes as well, only within the same player.
    { $sort: { _globalTrustedMmr: -1, updatedAt: -1, _id: 1 } },
    { $group: {
      _id: { player: "$_globalPlayerId", replay: { $cond: [
        { $ne: [stringExpr("$replayFile.sha256"), ""] },
        { $concat: ["sha:", stringExpr("$replayFile.sha256")] },
        { $concat: ["id:", { $ifNull: ["$gameId", { $toString: "$_id" }] }] },
      ] } },
      row: { $first: "$$ROOT" },
    } },
    { $replaceWith: "$row" },
  ];
}

/** @typedef {ReturnType<typeof parseGlobalTrendsFilters>} Cohort */

/** @param {Record<string, any>} player @param {Cohort} cohort */
function playerIncluded(player, cohort) {
  if (cohort.excludedPlayers.includes(player.playerId)) return false;
  if (cohort.selection === "include" && !cohort.includedPlayers.includes(player.playerId)) return false;
  if (Array.isArray(player.races) && player.races.length && player.races.every((r) => cohort.excludedRaces.includes(r))) return false;
  if (player.currentMmr === null) return cohort.includeUnrated;
  if (cohort.mmrMin !== undefined && player.currentMmr < cohort.mmrMin) return false;
  return cohort.mmrMax === undefined || player.currentMmr <= cohort.mmrMax;
}

module.exports = {
  parseGlobalTrendsFilters, globalHistoryStages, playerIncluded,
  stringExpr, trustedReplayMmrExpr,
  GLOBAL_HISTORY_PROJECTION, GLOBAL_ROSTER_PROJECTION,
};
