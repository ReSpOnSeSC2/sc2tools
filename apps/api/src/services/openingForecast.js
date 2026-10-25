"use strict";

const { opponentOverrideActive, TOO_SHORT_SECONDS, TOO_SHORT_LABEL_RE } = require("./buildIntentShape");

const FORECAST_LIMIT = 50;
const HALF_LIFE_GAMES = 8;
const MAP_WEIGHT = 1.5;
const PRIOR_GAMES = 3;
const UNKNOWN = "";
const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;
const text = (/** @type {unknown} */ value) => typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : "";

/** @param {unknown} value */
function race(value) {
  const raw = text(value).toLowerCase();
  return ({ p: "P", protoss: "P", prot: "P", t: "T", terran: "T", terr: "T", z: "Z", zerg: "Z", r: "R", random: "R", rand: "R" })[raw] || null;
}

/** The effective personal label, with unlabelled games retained in the denominator. @param {any} row */
function strategy(row) {
  return text(opponentOverrideActive(row) ? row.buildIntent.opponent.build.name : row?.opponent?.strategy);
}

/** @param {number} n */
function confidence(n) { return n < 3 ? "Low" : n < 8 ? "Medium" : "High"; }

/** Shared eligible metadata window for the posterior and replay-observed rating. @param {any[]} rows @param {{myRace?:unknown,oppRace?:unknown}} context */
function matchingForecastRows(rows, context) {
  const myRace = race(context.myRace), oppRace = race(context.oppRace);
  if (!myRace || !oppRace || myRace === "R" || oppRace === "R") return [];
  return (Array.isArray(rows) ? rows : []).slice(0, 1000).filter(row => {
    const label = strategy(row), duration = Number(row?.durationSec);
    return row && row.excluded !== true && row._deleted !== true && row._deletionPending !== true
      && row.isResumedFromReplay !== true && race(row.myRace) === myRace && race(row.opponent?.race) === oppRace
      && !(Number.isFinite(duration) && duration > 0 && duration < TOO_SHORT_SECONDS) && !TOO_SHORT_LABEL_RE.test(label);
  }).slice(0, FORECAST_LIMIT);
}

/** @param {any} prior @param {string|null} matchup */
function priorDistribution(prior, matchup) {
  if (!prior || prior.matchup !== matchup || !Number.isFinite(prior.n) || prior.n < 50 || !Array.isArray(prior.openers) || prior.openers.length > 12) return null;
  const counts = new Map();
  for (const row of prior.openers) {
    const name = text(row?.build), share = row?.frequency;
    if (!name || !Number.isFinite(share) || share <= 0 || share > 1) continue;
    counts.set(name, (counts.get(name) || 0) + share);
  }
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  if (sum <= 0 || sum > 1.002) return null; // Stored frequencies round to four decimals.
  const denominator = Math.max(1, sum);
  for (const [name, share] of counts) counts.set(name, share / denominator);
  counts.set(UNKNOWN, Math.max(0, 1 - sum));
  return { counts, bandLabel: text(prior.bandLabel), n: prior.n };
}

/**
 * Pure deterministic posterior over newest-first personal replay metadata.
 * Age is measured in matching eligible games, including unlabelled games.
 * The top three retain their probability across ALL openings; omitted/unknown
 * mass is explicit rather than renormalising a small displayed subset to 100%.
 * The cached prior is viewed from the opponent's side of the matchup, at the
 * streamer's rating band. Its three pseudo-games never raise personal confidence.
 *
 * @param {any[]} rows newest first, bounded metadata only
 * @param {{myRace?:unknown,oppRace?:unknown,map?:unknown,prior?:any}} [context]
 */
function openingForecast(rows, context = {}) {
  const myRace = race(context.myRace), oppRace = race(context.oppRace), map = text(context.map);
  const matchup = myRace && oppRace && myRace !== "R" && oppRace !== "R" ? `${myRace}v${oppRace}` : null;
  const personal = matchingForecastRows(rows, context);
  const prior = priorDistribution(context.prior, matchup ? `${oppRace}v${myRace}` : null);
  const weighted = new Map(), plain = new Map(), last5 = new Map(), byMap = new Map();
  let effectiveN = 0, onMap = 0;
  personal.forEach((row, index) => {
    const name = strategy(row), sameMap = !!map && text(row.map) === map;
    const weight = Math.pow(2, -index / HALF_LIFE_GAMES) * (sameMap ? MAP_WEIGHT : 1);
    effectiveN += weight;
    weighted.set(name, (weighted.get(name) || 0) + weight);
    plain.set(name, (plain.get(name) || 0) + 1);
    if (index < 5) last5.set(name, (last5.get(name) || 0) + 1);
    if (sameMap) { onMap += 1; byMap.set(name, (byMap.get(name) || 0) + 1); }
  });
  if (prior) for (const [name, share] of prior.counts) weighted.set(name, (weighted.get(name) || 0) + PRIOR_GAMES * share);
  const total = effectiveN + (prior ? PRIOR_GAMES : 0), label = confidence(effectiveN);
  const top = [...weighted].filter(([name, weight]) => name && weight > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3)
    .map(([name, weight]) => {
      const why = [];
      if (personal.length) why.push(`${last5.get(name) || 0} of last ${Math.min(5, personal.length)} vs you`);
      if (map && onMap) why.push(`${byMap.get(name) || 0} of ${onMap} on ${map}`);
      const priorShare = prior?.counts.get(name) || 0;
      if (prior && priorShare > 0) why.push(`Ladder vs ${prior.bandLabel || "this rating band"}: ${Math.round(priorShare * 100)}%`);
      return { name, probability: round(weight / total), samples: plain.get(name) || 0, of: personal.length, why };
    });
  return {
    top, effectiveN: round(effectiveN), confidence: label, sampleSize: personal.length,
    matchup, map: map || null, limit: FORECAST_LIMIT,
    otherProbability: total > 0 ? round(Math.max(0, 1 - top.reduce((sum, row) => sum + row.probability, 0))) : 0,
    prior: prior ? { pseudoGames: PRIOR_GAMES, n: prior.n, bandLabel: prior.bandLabel, matchup: `${oppRace}v${myRace}` } : null,
  };
}

module.exports = { openingForecast, matchingForecastRows, FORECAST_LIMIT, HALF_LIFE_GAMES, MAP_WEIGHT, PRIOR_GAMES };
