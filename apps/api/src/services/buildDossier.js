"use strict";

const Dna = require("./dnaTimings");
const TimingCatalog = require("./timingCatalog");

/** @typedef {import("./dnaTimings").TokenTimingRow} TokenTimingRow */

/**
 * Slim per-token timing row exposed on `medianTimings` /
 * `matchupTimings` (the non-legacy SPA consumers), projected from the
 * full {@link TokenTimingRow}.
 *
 * @typedef {{key: string, median: number|null, count: number}} ProjectedTimingRow
 */

/**
 * Snake_case row for the "last 5 games" widget — mirrors the legacy
 * SPA field names.
 *
 * @typedef {{
 *   id: string|null,
 *   date: string|null,
 *   result: string,
 *   map: string,
 *   opp_strategy: string|null,
 *   opp_race: string|null,
 *   my_build: string|null,
 *   game_length: number|null,
 *   macro_score: number|null,
 * }} Last5GameRow
 */

/**
 * Shared helper that derives the "dossier extras" (DNA-style fields,
 * strategy predictions, macro aggregates) from a list of game documents
 * already filtered to a single build. Mirrors the per-opponent helpers
 * in `OpponentsService.get` so the cloud frontend can render the same
 * widgets against either an opponent or a build.
 *
 * Input games must use the cloud schema:
 *   { gameId, date, result, map, myRace, myBuild, durationSec,
 *     macroScore, apm, spq, opponent: { displayName, race, strategy },
 *     buildLog, oppBuildLog }
 *
 * Newest-first is assumed for recency-weighted predictions and
 * "last 5 games" — caller should sort by date desc.
 *
 * @param {Array<any>} games
 * @returns {{
 *   topStrategies: Array<{strategy: string, wins: number, losses: number, count: number, winRate: number}>,
 *   predictedStrategies: Array<{strategy: string, probability: number}>,
 *   myRace: string,
 *   oppRaceModal: string,
 *   matchupLabel: string,
 *   matchupCounts: Record<string, number>,
 *   matchupTimings: Record<string, Record<string, ProjectedTimingRow>>,
 *   matchupTimingsLegacy: Record<string, {timings: Record<string, TokenTimingRow>, order: string[]}>,
 *   medianTimings: Record<string, ProjectedTimingRow>,
 *   medianTimingsLegacy: Record<string, TokenTimingRow>,
 *   medianTimingsOrder: string[],
 *   last5Games: Last5GameRow[],
 *   macro: {
 *     gamesWithScore: number,
 *     avgMacroScore: number|null,
 *     avgApm: number|null,
 *     avgSpq: number|null,
 *     avgDurationSec: number|null,
 *     scoreDistribution: { excellent: number, good: number, poor: number },
 *   },
 * }}
 */
function computeDossierExtras(games) {
  const list = Array.isArray(games) ? games : [];
  const myRace = Dna.resolveMyRace(list);
  const oppRaceModal = Dna.resolveModalOppRace(list);
  const matchupLabel = TimingCatalog.matchupLabel(myRace, oppRaceModal) || "";
  const medianTimingsLegacy = Dna.computeMatchupAwareMedianTimings(
    list,
    myRace,
  );
  const medianTimingsOrder = Object.keys(medianTimingsLegacy);

  /** @type {Record<string, number>} */
  const matchupCounts = {};
  if (myRace) {
    for (const g of list) {
      const r = Dna.gameOppRace(g);
      if (!r) continue;
      const ml = TimingCatalog.matchupLabel(myRace, r);
      if (!ml) continue;
      matchupCounts[ml] = (matchupCounts[ml] || 0) + 1;
    }
  }

  /** @type {Record<string, {timings: Record<string, TokenTimingRow>, order: string[]}>} */
  const matchupTimingsLegacy = {};
  if (myRace) {
    for (const ml of Object.keys(matchupCounts)) {
      const opp = ml.slice(-1);
      const t = Dna.computeMedianTimingsForMatchup(list, myRace, opp);
      matchupTimingsLegacy[ml] = { timings: t, order: Object.keys(t) };
    }
  }

  const byStrategy = aggregateByStrategy(list);
  const topStrategies = Dna.topStrategiesFromBy(byStrategy, 5);
  const predictedStrategies = Dna.recencyWeightedStrategies(list);
  const last5Games = list.slice(0, 5).map(serializeForLast5);

  return {
    topStrategies,
    predictedStrategies,
    myRace,
    oppRaceModal,
    matchupLabel,
    matchupCounts,
    matchupTimings: projectMatchupTimings(matchupTimingsLegacy),
    matchupTimingsLegacy,
    medianTimings: projectMedianTimings(medianTimingsLegacy),
    medianTimingsLegacy,
    medianTimingsOrder,
    last5Games,
    macro: aggregateMacro(list),
  };
}

/**
 * Aggregate W/L by `opponent.strategy` from cloud-shaped game docs.
 * Mirrors `aggregateByMapAndStrategy` in the opponents service but only
 * needs the byStrategy half.
 *
 * @param {Array<any>} games
 * @returns {Record<string, {wins: number, losses: number}>}
 */
function aggregateByStrategy(games) {
  /** @type {Record<string, {wins: number, losses: number}>} */
  const out = {};
  for (const g of games) {
    const strat =
      (g && g.opponent && g.opponent.strategy) ||
      g.opp_strategy ||
      "";
    if (!strat) continue;
    if (!out[strat]) out[strat] = { wins: 0, losses: 0 };
    if (Dna.isWonResult(g.result)) out[strat].wins += 1;
    else if (isLossResult(g.result)) out[strat].losses += 1;
  }
  return out;
}

/** @param {unknown} r @returns {boolean} */
function isLossResult(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "loss" || s === "defeat";
}

/**
 * @param {Array<any>} games
 * @returns {{
 *   gamesWithScore: number,
 *   avgMacroScore: number|null,
 *   avgApm: number|null,
 *   avgSpq: number|null,
 *   avgDurationSec: number|null,
 *   scoreDistribution: { excellent: number, good: number, poor: number },
 * }}
 */
function aggregateMacro(games) {
  let scoreSum = 0;
  let scoreCount = 0;
  let apmSum = 0;
  let apmCount = 0;
  let spqSum = 0;
  let spqCount = 0;
  let durSum = 0;
  let durCount = 0;
  let excellent = 0;
  let good = 0;
  let poor = 0;
  for (const g of games) {
    if (typeof g.macroScore === "number") {
      scoreSum += g.macroScore;
      scoreCount += 1;
      if (g.macroScore >= 75) excellent += 1;
      else if (g.macroScore >= 50) good += 1;
      else poor += 1;
    }
    if (typeof g.apm === "number") {
      apmSum += g.apm;
      apmCount += 1;
    }
    if (typeof g.spq === "number") {
      spqSum += g.spq;
      spqCount += 1;
    }
    if (typeof g.durationSec === "number") {
      durSum += g.durationSec;
      durCount += 1;
    }
  }
  return {
    gamesWithScore: scoreCount,
    avgMacroScore: scoreCount > 0 ? scoreSum / scoreCount : null,
    avgApm: apmCount > 0 ? apmSum / apmCount : null,
    avgSpq: spqCount > 0 ? spqSum / spqCount : null,
    avgDurationSec: durCount > 0 ? durSum / durCount : null,
    scoreDistribution: { excellent, good, poor },
  };
}

/** @param {any} g @returns {Last5GameRow} */
function serializeForLast5(g) {
  const opp = g.opponent || {};
  return {
    id: g.gameId || null,
    date: g.date instanceof Date ? g.date.toISOString() : g.date || null,
    result: g.result || "",
    map: g.map || "",
    opp_strategy: opp.strategy || g.opp_strategy || null,
    opp_race: opp.race || g.oppRace || null,
    my_build: g.myBuild || g.my_build || null,
    game_length: typeof g.durationSec === "number" ? g.durationSec : null,
    macro_score: typeof g.macroScore === "number" ? g.macroScore : null,
  };
}

/**
 * @param {Record<string, TokenTimingRow>} legacy
 * @returns {Record<string, ProjectedTimingRow>}
 */
function projectMedianTimings(legacy) {
  /** @type {Record<string, ProjectedTimingRow>} */
  const out = {};
  for (const k of Object.keys(legacy || {})) {
    /** @type {Partial<TokenTimingRow>} */
    const v = legacy[k] || {};
    out[k] = {
      key: k,
      median: typeof v.medianSeconds === "number" ? v.medianSeconds : null,
      count: v.sampleCount || 0,
    };
  }
  return out;
}

/**
 * @param {Record<string, {timings: Record<string, TokenTimingRow>, order: string[]}>} legacy
 * @returns {Record<string, Record<string, ProjectedTimingRow>>}
 */
function projectMatchupTimings(legacy) {
  /** @type {Record<string, Record<string, ProjectedTimingRow>>} */
  const out = {};
  for (const ml of Object.keys(legacy || {})) {
    out[ml] = projectMedianTimings(legacy[ml] && legacy[ml].timings);
  }
  return out;
}

module.exports = { computeDossierExtras };
