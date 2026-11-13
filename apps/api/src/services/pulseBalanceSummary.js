"use strict";

const { round4, wilsonInterval } = require("../util/wilson");

const LEAGUES = /** @type {const} */ ([
  "bronze", "silver", "gold", "platinum", "diamond", "master", "grandmaster",
]);
const MATCHUPS = /** @type {const} */ (["PvT", "PvZ", "TvZ"]);

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label @returns {unknown[]} */
function list(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function count(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

/** @param {unknown} value */
function utcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("asOf must be a UTC calendar day (YYYY-MM-DD).");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError("asOf must be a valid calendar day.");
  }
  return value;
}

/** @param {typeof LEAGUES[number]} league @param {unknown} division */
function ladderDivision(league, division) {
  if (league === "grandmaster" && division === null) return null;
  if (league !== "grandmaster" && (division === 1 || division === 2 || division === 3)) {
    return division;
  }
  throw new TypeError("A tier needs division 1, 2 or 3, or null for grandmaster.");
}

function emptyCohorts() {
  return { sameTier: { wins: 0, games: 0 }, crossTier: { wins: 0, games: 0 } };
}

/** @param {{ wins: number, games: number }} counts */
function withUncertainty({ wins, games }) {
  return {
    games,
    wins,
    winRate: games > 0 ? round4(wins / games) : null,
    interval: wilsonInterval(wins, games),
  };
}

/** @param {ReturnType<typeof emptyCohorts>} cohorts @param {Record<string, unknown>} row */
function addCounts(cohorts, row) {
  if (typeof row.crossTier !== "boolean") throw new TypeError("crossTier must be a boolean.");
  const wins = count(row.wins, "wins");
  const games = count(row.games, "games");
  if (wins > games) throw new RangeError("wins cannot exceed games.");

  const totals = row.crossTier ? cohorts.crossTier : cohorts.sameTier;
  totals.games = count(totals.games + games, "pooled games");
  totals.wins += wins;
}

/** @param {unknown} input */
function summarizeTier(input) {
  const tier = record(input, "tier");
  const league = LEAGUES.find((name) => name === tier.league);
  if (!league) throw new TypeError("Unknown league.");
  const division = ladderDivision(league, tier.division);
  const totals = { PvT: emptyCohorts(), PvZ: emptyCohorts(), TvZ: emptyCohorts() };
  for (const inputRow of list(tier.rows, "rows")) {
    const row = record(inputRow, "row");
    const matchup = MATCHUPS.find((name) => name === row.matchup);
    if (!matchup) throw new TypeError("Use one canonical non-mirror matchup per row.");
    addCounts(totals[matchup], row);
  }

  return {
    league,
    division,
    matchups: MATCHUPS.map((matchup) => ({
      matchup,
      sameTier: withUncertainty(totals[matchup].sameTier),
      crossTier: withUncertainty(totals[matchup].crossTier),
    })),
  };
}

/**
 * Summarize disjoint, normalized counts. Wins always refer to the first race.
 * The source adapter owns deduplication and never passes reversed matchup rows.
 * Pool counts across source buckets before calculating an interval.
 * @param {unknown} input
 */
function summarizeBalance(input) {
  const snapshot = record(input, "snapshot");
  const season = count(snapshot.season, "season");
  if (season === 0) throw new RangeError("season must be positive.");
  const asOf = utcDay(snapshot.asOf);
  const tiers = list(snapshot.tiers, "tiers").map(summarizeTier);
  const tierKeys = new Set(tiers.map(({ league, division }) => `${league}/${division}`));
  if (tierKeys.size !== tiers.length) throw new TypeError("Duplicate league tier.");
  tiers.sort((left, right) =>
    LEAGUES.indexOf(right.league) - LEAGUES.indexOf(left.league)
    || (left.division ?? 0) - (right.division ?? 0)
  );
  return { season, asOf, tiers };
}

module.exports = { LEAGUES, MATCHUPS, summarizeBalance };
