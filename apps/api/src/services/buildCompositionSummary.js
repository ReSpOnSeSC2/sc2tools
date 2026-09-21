"use strict";

const MAX_UNITS = 64;
const MAX_SAMPLE_IDS = 25;

/** @typedef {{token: string, count: number, timeSec?: number}} UnitObservation */
/** @typedef {{gameId: unknown, units: UnitObservation[], sampleTimeSec?: number}} GameObservation */
/** @typedef {{metric?: 'peak_alive'|'snapshot_alive', compareGameId?: string, comparisonStatus?: import('./types').BuildUnitComparison['status']}} SummaryOptions */

/** Linear interpolation; callers supply sorted, nonempty samples.
 * @param {number[]} sorted @param {number} fraction */
function quantile(sorted, fraction) {
  const rank = fraction * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/** @param {number[]} sorted */
function typicalRange(sorted) {
  return { median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75) };
}

/** Keep representative evidence independent of the legacy 25-ID sample cap.
 * Stable input order resolves equal count/time ties, matching newest-first cohorts.
 * @param {GameObservation[]} games @param {string} token @param {number} median
 */
function selectExamples(games, token, median) {
  /** @type {{typical?: import('./types').BuildUnitExample, high?: import('./types').BuildUnitExample, absent?: import('./types').BuildUnitExample}} */
  const examples = {};
  for (const game of games) {
    if (!game.gameId) continue;
    const unit = game.units.find((row) => row.token === token);
    const count = unit?.count || 0;
    const timeSec = unit?.timeSec ?? game.sampleTimeSec;
    if (typeof timeSec !== "number" || !Number.isFinite(timeSec)) continue;
    const example = { gameId: String(game.gameId), count, timeSec };
    if (count > 0) {
      if (!examples.typical || Math.abs(count - median) < Math.abs(examples.typical.count - median)) {
        examples.typical = example;
      }
      if (!examples.high || count > examples.high.count) examples.high = example;
    } else if (!examples.absent) examples.absent = example;
  }
  return examples;
}

/** Main-cohort statistics always include observed absences as zeros.
 * Missing observations are never inferred from empty positive-unit lists.
 * @param {GameObservation[]} games @param {number} missingGames
 * @param {SummaryOptions} [options]
 * @returns {import('./types').BuildUnitSummary}
 */
function summarizeObservedUnits(games, missingGames, options = {}) {
  /** @type {Map<string, {counts: number[], sampleGameIds: string[]}>} */
  const byToken = new Map();
  for (const game of games) {
    for (const { token, count } of game.units) {
      if (!(count > 0)) continue;
      if (!byToken.has(token)) byToken.set(token, { counts: [], sampleGameIds: [] });
      const row = byToken.get(token);
      if (!row) continue;
      row.counts.push(count);
      if (game.gameId && row.sampleGameIds.length < MAX_SAMPLE_IDS) row.sampleGameIds.push(String(game.gameId));
    }
  }
  const observedGames = games.length;
  const units = [];
  for (const [token, row] of byToken) {
    const positive = row.counts.slice().sort((a, b) => a - b);
    const gamesPresent = positive.length;
    const sorted = [...Array(observedGames - gamesPresent).fill(0), ...positive];
    const whenPresent = typicalRange(positive);
    units.push({
      token,
      mean: positive.reduce((sum, count) => sum + count, 0) / observedGames,
      ...typicalRange(sorted),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      gamesPresent,
      sampleGameIds: row.sampleGameIds,
      whenPresent,
      examples: selectExamples(games, token, whenPresent.median),
    });
  }
  units.sort((a, b) => b.mean - a.mean || a.token.localeCompare(b.token));
  return {
    metric: options.metric || "peak_alive",
    source: "unit_timeline",
    observedGames,
    missingGames,
    emptyArmyGames: games.filter((game) => game.units.length === 0).length,
    units: units.slice(0, MAX_UNITS),
    ...(options.compareGameId ? { comparison: compareObservation(games, options) } : {}),
  };
}

/** Baseline excludes the selected replay before calculating every percentile.
 * Tokens seen only in the selected game still get real zero baselines when
 * other observed games exist. With no baseline, stats remain null.
 * @param {GameObservation[]} games @param {SummaryOptions} options
 * @returns {import('./types').BuildUnitComparison}
 */
function compareObservation(games, options) {
  const gameId = options.compareGameId || "";
  const selected = games.find((game) => String(game.gameId) === gameId);
  const baseline = games.filter((game) => String(game.gameId) !== gameId);
  const status = selected ? "observed" : options.comparisonStatus || "not_in_cohort";
  const result = { gameId, status, baselineGames: baseline.length, units: [] };
  if (!selected) return result;
  const selectedCounts = new Map(selected.units.map((row) => [row.token, row.count]));
  const baselineCounts = baseline.map((game) => new Map(game.units.map((row) => [row.token, row.count])));
  const tokens = new Set([...selectedCounts.keys(), ...baselineCounts.flatMap((counts) => [...counts.keys()])]);
  const units = [...tokens].map((token) => {
    const count = selectedCounts.get(token) || 0;
    const values = baselineCounts.map((counts) => counts.get(token) || 0).sort((a, b) => a - b);
    const range = values.length ? typicalRange(values) : { median: null, p25: null, p75: null };
    return { token, count, ...range, delta: range.median === null ? null : count - range.median };
  });
  units.sort((a, b) => Math.max(b.count, b.median || 0) - Math.max(a.count, a.median || 0)
    || a.token.localeCompare(b.token));
  return {
    ...result,
    ...(selected.sampleTimeSec === undefined ? {} : { sampleTimeSec: selected.sampleTimeSec }),
    units: units.slice(0, MAX_UNITS),
  };
}

module.exports = { summarizeObservedUnits };
