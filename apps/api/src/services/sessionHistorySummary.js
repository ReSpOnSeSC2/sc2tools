"use strict";

const { createHash } = require("node:crypto");
const { LIMITS } = require("../config/constants");
const { parseRaceLetter } = require("../util/parseQuery");
const { sessionize, ordered, outcome, codePoints, wellFormed } = require("./sessions");

const MAX_SUMMARY_GAMES = 5000;
const MAX_TOP_BUILDS = 10;
const QUEUED_RACES = new Map([["P", "P"], ["Protoss", "P"], ["T", "T"], ["Terran", "T"],
  ["Z", "Z"], ["Zerg", "Z"], ["R", "R"], ["Random", "R"]]);

/** @typedef {Record<string,unknown>} Game */
/** @typedef {{games:number,wins:number,losses:number,unknown:number}} Counts */
/** @typedef {"planned"|"detected"|"unavailable"} BuildProvenance */
/** @typedef {"1v1"|"team"|"ffa"|"other"|"unknown"} RatingFormat */
/** @typedef {"ranked"|"custom"|"unknown"} RatingKind */
/** @typedef {`${RatingKind}-${RatingFormat}`} RatingScope */
/** @typedef {{name:string|null,provenance:BuildProvenance,detectedName:string|null}} MemberBuild */
/** @typedef {{position:number,gameId:string|null,date:string,outcome:"W"|"L"|"U",myToonHandle:string|null,ladderRace:string|null,ratingScope:RatingScope,comparable:boolean,matchup:string,recordedEndGapSec:number|null,durationSec:number|null,macroScore:number|null,myMmr:number|null,myMmrSource:"replay"|"legacy"|null,build:MemberBuild}} Member */
/** @typedef {Counts & {name:string,plannedGames:number,detectedGames:number,provenanceUnavailableGames:number}} BuildCounts */
/** @typedef {{position:number,gameId:string|null,date:string,value:number|null,source:"replay"|"legacy"|null}} MmrStep */
/** @typedef {{myToonHandle:string,ladderRace:string|null,ratingScope:RatingScope,comparable:boolean,games:number,samples:number,missingGames:number,legacySamples:number,start:number|null,end:number|null,delta:number|null,peak:number|null,steps:MmrStep[]}} MmrTrack */
/** @typedef {{previousDecision:"W"|"L"|null,winsRun:number,lossesRun:number,longestWins:number,longestLosses:number,afterLossWins:number,afterLossLosses:number}} DecidedRuns */
/** @typedef {{total:Counts,members:Member[],matchups:Map<string,Counts & {matchup:string}>,builds:Map<string,BuildCounts>,tracks:Map<string,MmrTrack>,seconds:number,durationSamples:number,macroSum:number,macroSamples:number,buildMissingGames:number,mmrUnattributedGames:number,mmrUnattributedSamples:number,runs:DecidedRuns}} SummaryState */

/** @param {string} code */
function invalid(code) { return Object.assign(new TypeError(code), { code }); }

/** Inspect only the supported slim view, never notes/heavy/credential fields.
 * Oversized supported fields fail explicitly; membership is not truncated.
 * @param {unknown} value @returns {Game[]} */
function boundedRows(value) {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_GAMES) throw invalid("session_history_rows_invalid");
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("session_history_row_invalid");
    const opp = record(row.opponent);
    for (const [field, max] of [[row.gameId, LIMITS.GAME_ID_MAX_LENGTH], [row.date, 64], [row.result, 64],
      [row.myToonHandle, 64], [opp.toonHandle, 64], [row.myRace, 24], [row.myLadderRace, 24], [opp.race, 24],
      [row.myBuild, 200], [row.detectedBuild, 200], [row.matchFormat, 24]]) {
      // Each Unicode scalar can occupy two UTF-16 units. This cheap bound
      // precedes any Unicode walk and matches the existing ingest field caps.
      if (typeof field === "string" && (field.length > 2 * Number(max) || [...field].length > Number(max))) throw invalid("session_history_field_limit");
    }
  }
  return /** @type {Game[]} */ (value);
}

/** @param {unknown} value @returns {Game} */
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Game} */ (value) : {}; }

/** Exact text: no trimming, case folding, aliasing or account inference.
 * @param {unknown} value @param {number} max @returns {string|null} */
function text(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= 2 * max && wellFormed(value)
    && [...value].length <= max ? value : null;
}

/** Use the existing race parser only for actual string race fields.
 * @param {unknown} value @returns {string|null} */
function race(value) { return typeof value === "string" ? parseRaceLetter(value) : null; }

/** Positive queue-race proof uses supported actual names/codes, not the played
 * race or the permissive descriptive first-letter parser (e.g. "Potato").
 * @param {unknown} value @returns {string|null} */
function queuedRace(value) { return typeof value === "string" ? QUEUED_RACES.get(value) ?? null : null; }

/** Format is authoritative; only absent format may use the safe 2-player
 * fallback. Neither map-pool inference nor a spawned race proves a ladder.
 * Team/AT identity is unavailable even when format says ranked team.
 * @param {Game} row @param {string|null} ownToon @param {string|null} ladderRace
 * @returns {{ratingScope:RatingScope,comparable:boolean}} */
function ratingContext(row, ownToon, ladderRace) {
  /** @type {RatingFormat} */ let format = "unknown";
  if (row.matchFormat === "1v1" || row.matchFormat === "team" || row.matchFormat === "ffa" || row.matchFormat === "other") format = row.matchFormat;
  else if (row.matchFormat === undefined && row.playerCount === 2) format = "1v1";
  const kind = row.isLadderGame === true ? "ranked" : row.isLadderGame === false ? "custom" : "unknown";
  /** @type {RatingScope} */ const ratingScope = `${kind}-${format}`;
  return { ratingScope, comparable: ratingScope === "ranked-1v1" && ownToon !== null && ladderRace !== null };
}

/** @returns {Counts} */
function counts() { return { games: 0, wins: 0, losses: 0, unknown: 0 }; }

/** @param {Counts} value @param {"W"|"L"|"U"} result */
function count(value, result) {
  value.games++;
  if (result === "W") value.wins++;
  else if (result === "L") value.losses++;
  else value.unknown++;
}

/** Fields are the camel-case GamesService.list DTO after withOwnerBuildFlags.
 * Missing flags mean unavailable provenance, never an inferred detector label.
 * @param {Game} row @returns {MemberBuild} */
function build(row) {
  return {
    name: text(row.myBuild, 200),
    provenance: row.buildPlanned === true ? "planned" : row.buildPlanned === false ? "detected" : "unavailable",
    detectedName: row.buildPlanned === true ? text(row.detectedBuild, 200) : null,
  };
}

/** No numeric/string coercion or current/Pulse/opponent fallback.
 * @param {Game} row @returns {{value:number|null,source:"replay"|"legacy"|null}} */
function rating(row) {
  const value = row.myMmr;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 9999) return { value: null, source: null };
  if (row.myMmrSource === "replay") return { value, source: "replay" };
  if (row.myMmrSource === undefined) return { value, source: "legacy" };
  return { value: null, source: null };
}

/** Internal membership fingerprint only, NOT an HTTP ID/cursor, authorization,
 * content ETag, completeness proof or owner/policy/filter/anchor descriptor.
 * Reuses the core's returned canonical order keys, retaining duplicate counts.
 * Fields outside the core order key deliberately do not change this digest.
 * @param {unknown} games @returns {string} */
function canonicalMemberDigest(games) {
  const hash = createHash("sha256").update("sc2tools-natural-members:v1\n");
  for (const row of ordered(boundedRows(games))) {
    const encoded = JSON.stringify(row.key);
    hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
  }
  return hash.digest("hex");
}

/** @param {Game} row @param {number} position @param {number} time @param {number|null} previous @returns {Member} */
function member(row, position, time, previous) {
  const ownRace = race(row.myRace), oppRace = race(record(row.opponent).race);
  const mmr = rating(row), duration = row.durationSec, macro = row.macroScore;
  const ownToon = text(row.myToonHandle, 64), ladderRace = queuedRace(row.myLadderRace);
  const context = ratingContext(row, ownToon, ladderRace);
  return {
    position, gameId: text(row.gameId, LIMITS.GAME_ID_MAX_LENGTH), date: new Date(time).toISOString(), outcome: outcome(row.result),
    myToonHandle: ownToon, ladderRace, ratingScope: context.ratingScope, comparable: context.comparable,
    matchup: `${ownRace ?? "?"}v${oppRace ?? "?"}`,
    recordedEndGapSec: previous === null ? null : (time - previous) / 1000,
    durationSec: typeof duration === "number" && Number.isInteger(duration) && duration >= 0 && duration <= 86400 ? duration : null,
    macroScore: typeof macro === "number" && Number.isFinite(macro) && macro >= 0 && macro <= 100 ? macro : null,
    myMmr: mmr.value, myMmrSource: mmr.source, build: build(row),
  };
}

/** @param {Map<string,MmrTrack>} tracks @param {Member} value */
function addRating(tracks, value) {
  if (value.myToonHandle === null) return;
  // Exact account, positively known queue race (or null), and rating scope.
  // Unknown queued race never merges into the same account's known P/T/Z/R.
  const key = JSON.stringify([value.myToonHandle, value.ladderRace, value.ratingScope]);
  let track = tracks.get(key);
  if (!track) {
    track = { myToonHandle: value.myToonHandle, ladderRace: value.ladderRace, ratingScope: value.ratingScope,
      comparable: value.comparable, games: 0, samples: 0, missingGames: 0,
      legacySamples: 0, start: null, end: null, delta: null, peak: null, steps: [] };
    tracks.set(key, track);
  }
  track.games++;
  track.steps.push({ position: value.position, gameId: value.gameId, date: value.date, value: value.myMmr, source: value.myMmrSource });
  if (value.myMmr === null) { track.missingGames++; return; }
  track.samples++;
  if (value.myMmrSource === "legacy") track.legacySamples++;
  if (track.start === null) track.start = value.myMmr;
  track.end = value.myMmr;
  track.peak = track.peak === null ? value.myMmr : Math.max(track.peak, value.myMmr);
  // Preserve all observations. Only a positively identified ranked1v1 ladder
  // with two observations can support a change or a connected rating curve.
  track.delta = track.comparable && track.samples >= 2 ? track.end - track.start : null;
}

/** @returns {SummaryState} */
function summaryState() {
  return {
    total: counts(), members: [], matchups: new Map(), builds: new Map(), tracks: new Map(),
    seconds: 0, durationSamples: 0, macroSum: 0, macroSamples: 0, buildMissingGames: 0,
    mmrUnattributedGames: 0, mmrUnattributedSamples: 0,
    runs: { previousDecision: null, winsRun: 0, lossesRun: 0, longestWins: 0, longestLosses: 0, afterLossWins: 0, afterLossLosses: 0 },
  };
}

/** @param {SummaryState} state @param {Member} value */
function addBuild(state, value) {
  if (value.build.name === null) { state.buildMissingGames++; return; }
  const entry = state.builds.get(value.build.name)
    ?? { name: value.build.name, ...counts(), plannedGames: 0, detectedGames: 0, provenanceUnavailableGames: 0 };
  count(entry, value.outcome);
  if (value.build.provenance === "planned") entry.plannedGames++;
  else if (value.build.provenance === "detected") entry.detectedGames++;
  else entry.provenanceUnavailableGames++;
  state.builds.set(value.build.name, entry);
}

/** Unknown members already bridged membership; only decided outcomes advance.
 * @param {DecidedRuns} runs @param {"W"|"L"|"U"} result */
function addDecision(runs, result) {
  if (result === "U") return;
  if (runs.previousDecision === "L") {
    if (result === "W") runs.afterLossWins++;
    else runs.afterLossLosses++;
  }
  if (result === "W") {
    runs.winsRun++; runs.lossesRun = 0; runs.longestWins = Math.max(runs.longestWins, runs.winsRun);
  } else {
    runs.lossesRun++; runs.winsRun = 0; runs.longestLosses = Math.max(runs.longestLosses, runs.lossesRun);
  }
  runs.previousDecision = result;
}

/** @param {SummaryState} state @param {Member} value */
function accumulate(state, value) {
  state.members.push(value); count(state.total, value.outcome);
  if (value.durationSec !== null) { state.seconds += value.durationSec; state.durationSamples++; }
  if (value.macroScore !== null) { state.macroSum += value.macroScore; state.macroSamples++; }
  const matchup = state.matchups.get(value.matchup) ?? { matchup: value.matchup, ...counts() };
  count(matchup, value.outcome); state.matchups.set(value.matchup, matchup);
  addBuild(state, value); addRating(state.tracks, value);
  if (value.myToonHandle === null) {
    state.mmrUnattributedGames++;
    if (value.myMmr !== null) state.mmrUnattributedSamples++;
  }
  addDecision(state.runs, value.outcome);
}

/** @param {{start:number,end:number}} group @param {SummaryState} state @param {number} topLimit */
function shapeSummary(group, state, topLimit) {
  const topBuilds = [...state.builds.values()].sort((a, b) => b.games - a.games || codePoints(a.name, b.name)).slice(0, topLimit);
  const { total, runs } = state, afterLossGames = runs.afterLossWins + runs.afterLossLosses;
  return {
    start: new Date(group.start).toISOString(), end: new Date(group.end).toISOString(), ...total,
    results: state.members.map(value => value.outcome).join(""),
    playedMin: state.durationSamples ? state.seconds / 60 : null,
    durationSamples: state.durationSamples, durationMissingGames: total.games - state.durationSamples,
    avgMacro: state.macroSamples ? state.macroSum / state.macroSamples : null,
    macroSamples: state.macroSamples, macroMissingGames: total.games - state.macroSamples,
    matchups: [...state.matchups.values()].sort((a, b) => codePoints(a.matchup, b.matchup)), topBuilds,
    topBuildsOtherGames: total.games - state.buildMissingGames - topBuilds.reduce((sum, value) => sum + value.games, 0),
    buildMissingGames: state.buildMissingGames,
    longestDecidedStreak: { wins: runs.longestWins, losses: runs.longestLosses },
    afterLoss: { wins: runs.afterLossWins, losses: runs.afterLossLosses, decidedGames: afterLossGames,
      winRate: afterLossGames ? runs.afterLossWins / afterLossGames : null,
      lossWithoutFollowingDecision: runs.previousDecision === "L" ? 1 : 0 },
    mmr: [...state.tracks.values()].sort((a, b) => codePoints(a.myToonHandle, b.myToonHandle)
      || codePoints(a.ladderRace ?? "", b.ladderRace ?? "") || codePoints(a.ratingScope, b.ratingScope)),
    mmrUnattributedGames: state.mmrUnattributedGames, mmrUnattributedSamples: state.mmrUnattributedSamples,
  };
}

/** Input is one complete session returned by the existing core kernel.
 * @param {{games:Game[],start:number,end:number}} group @param {number} topLimit */
function summarize(group, topLimit) {
  const state = summaryState();
  /** @type {number|null} */ let previousEnd = null;
  for (const { game, time } of ordered(group.games)) {
    accumulate(state, member(game, state.members.length + 1, time, previousEnd)); previousEnd = time;
  }
  return {
    // Internal wrapper: route identity/completeness/scope remain future work.
    memberDigest: canonicalMemberDigest(group.games), summary: shapeSummary(group, state, topLimit), members: state.members,
  };
}

/** Complete, already owner/visibility/filter-scoped slim input only. This helper
 * neither queries nor chooses a window, manual anchor, active session or policy.
 * It does not certify completeness. Output is chronological internal candidates,
 * not a finalized HTTP list/detail DTO; callers must not publish it verbatim.
 * @param {unknown} games @param {{gapMinutes:number,tz?:string,topBuildsLimit?:number}} opts */
function historySummaryCandidates(games, opts) {
  const rows = boundedRows(games), topLimit = opts.topBuildsLimit ?? 3;
  if (!Number.isInteger(topLimit) || topLimit < 1 || topLimit > MAX_TOP_BUILDS) throw invalid("session_history_top_builds_invalid");
  return sessionize(rows, opts).map(group => summarize(group, topLimit));
}

module.exports = { historySummaryCandidates, canonicalMemberDigest, MAX_SUMMARY_GAMES };
