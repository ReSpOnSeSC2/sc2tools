"use strict";
const catalog = require("./timingCatalog");
const { firstOccurrenceSeconds, percentileInclusive } = require("./dnaTimings");
const { eventToken } = require("./buildRulesEvaluator");
const TOWNHALL = Object.freeze({ P: "Nexus", T: "CommandCenter", Z: "Hatchery" });
const GAS = new Set(["Assimilator", "Refinery", "Extractor"]);
const MIN_SAMPLE = 3;

/** Natural-only scalar summaries from the already hydrated max25 sample.
 * All ordinary first-building baselines continue to use dossier DNA rows.
 * @param {Array<Record<string,any>>} games */
function naturalTimingBaselines(games) {
  /** @type {Record<string,number[]>} */ const groups = {};
  for (const game of games.slice(0, 25)) {
    const matchup = catalog.matchupLabel(game.myRace, game.opponent?.race || game.opp_race);
    const townhall = TOWNHALL[/** @type {keyof typeof TOWNHALL} */ (matchup[0])];
    if (!townhall || !Array.isArray(game.buildLog)) continue;
    const log = game.buildLog.filter((/** @type {unknown} */ line) => typeof line === "string" && /^\[(\d+):([0-5]\d)\]/.test(line)
      && Number(line.match(/^\[(\d+):/)?.[1]) * 60 + Number(line.match(/:([0-5]\d)\]/)?.[1]) > 10);
    const seconds = firstOccurrenceSeconds(log, townhall, game);
    if (seconds !== null) (groups[matchup] ||= []).push(seconds);
  }
  return Object.fromEntries(Object.entries(groups).map(([matchup, values]) => {
    values.sort((a, b) => a - b);
    return [matchup, { token: TOWNHALL[/** @type {keyof typeof TOWNHALL} */ (matchup[0])], sampleCount: values.length,
      medianSeconds: percentileInclusive(values, .5), p25Seconds: percentileInclusive(values, .25), p75Seconds: percentileInclusive(values, .75) }];
  }));
}

/** Exact start-normalized owner events and the single dossier's scalar rows.
 * No samples, game IDs or opponent evidence enter this compact response.
 * @param {Record<string,any>|null} dossier @param {string} matchup
 * @param {ReadonlyArray<import('./buildRulesEvaluator').ParsedEvent>} events */
function executionTimings(dossier, matchup, events) {
  const race = matchup[0], tokens = catalog.RACE_BUILDINGS[/** @type {'P'|'T'|'Z'} */ (race)] || [];
  const townhall = TOWNHALL[/** @type {keyof typeof TOWNHALL} */ (race)];
  const baseline = dossier?.matchupTimingsLegacy?.[matchup]?.timings || {};
  const natural = dossier?.naturalTimings?.[matchup];
  /** @type {Map<string,number>} */ const first = new Map();
  for (const event of events) {
    const token = (eventToken(event) || "").replace(/^Build/, ""), seconds = event.time;
    if (!event.is_building || !Number.isFinite(seconds) || seconds < 0 || token === townhall && seconds <= 10) continue;
    if ((first.get(token) ?? Infinity) > seconds) first.set(token, seconds);
  }
  const firstGas = [...first].filter(([token]) => GAS.has(token)).sort((a, b) => a[1] - b[1])[0]?.[0];
  const tech = new Set(tokens.filter(token => token.category === "tech" || token.tier >= 2 && token.category === "production").map(token => token.internalName));
  const firstTech = [...first].filter(([token]) => tech.has(token)).sort((a, b) => a[1] - b[1])[0]?.[0];
  return tokens.filter(token => first.has(token.internalName)).map(token => {
    const row = token.internalName === townhall ? natural : baseline[token.internalName];
    const n = Math.max(0, Number(row?.sampleCount) || 0), medianSec = n >= MIN_SAMPLE ? finite(row?.medianSeconds) : null;
    const thisGameSec = /** @type {number} */ (first.get(token.internalName));
    const kind = token.internalName === townhall ? "natural" : token.internalName === firstGas ? "first_gas" : token.internalName === firstTech ? "first_tech" : "building";
    return { token: token.internalName, displayName: token.displayName, kind, thisGameSec, medianSec,
      p25Sec: medianSec === null ? null : finite(row?.p25Seconds), p75Sec: medianSec === null ? null : finite(row?.p75Seconds),
      n, deltaSec: medianSec === null ? null : thisGameSec - medianSec };
  }).sort((a, b) => a.thisGameSec - b.thisGameSec);
}
/** @param {unknown} value */
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
module.exports = { naturalTimingBaselines, executionTimings, MIN_SAMPLE };
