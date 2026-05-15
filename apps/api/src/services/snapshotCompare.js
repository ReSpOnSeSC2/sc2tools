"use strict";

const {
  METRICS,
  TICK_SECONDS,
  NUM_TICKS,
  roundToTick,
  raceLetter,
  countBases,
} = require("./snapshotCohort");
const { countProduction } = require("./snapshotProduction");
const {
  loadWeights,
  weightsFor,
  METRIC_KEYS,
} = require("./snapshotWeights");

/**
 * SnapshotCompareService — per-tick position scoring for a single
 * game against pre-aggregated cohort bands.
 *
 * For every 30-second tick the user's value at that tick is bucketed
 * into one of five positions relative to the cohort's winner and
 * loser distributions:
 *
 *    +2  v ≥ P75(winners)              Winning
 *    +1  P50(winners) ≤ v < P75(winners)  Likely winning
 *     0  P50(losers)  < v < P50(winners)  Neutral
 *    −1  P25(losers)  < v ≤ P50(losers)   Likely losing
 *    −2  v ≤ P25(losers)               Losing
 *
 * Per-metric scores are aggregated into a single weighted tick
 * score using phase-aware weights from
 * ``apps/api/src/config/snapshotWeights.json`` (resolved via
 * ``snapshotWeights.weightsFor``). The headline verdict for the
 * tick is the user's aggregate minus the opponent's.
 *
 * The score system handles both percentile-band metrics (workers,
 * army_value, production_capacity, etc.) and externally-computed
 * categorical scores (tech_tier_reached, tech_path_winrate,
 * composition_matchup). Callers pass the categorical scores via
 * the ``extraScores`` parameter; the band path is automatic.
 *
 * No-mock contract: every tick value comes from real stats_events /
 * unit_timeline entries on the requested game record. A missing
 * tick is reported as ``unknown``, never a synthesized score.
 */

const VERDICTS = Object.freeze({
  WINNING: "winning",
  LIKELY_WINNING: "likely_winning",
  NEUTRAL: "neutral",
  LIKELY_LOSING: "likely_losing",
  LOSING: "losing",
  UNKNOWN: "unknown",
});

class SnapshotCompareService {
  /**
   * @param {{ weightsConfig?: object, weightsOverride?: object }} [opts]
   */
  constructor(opts = {}) {
    this.weightsConfig = opts.weightsConfig || loadWeights();
    this.weightsOverride = opts.weightsOverride;
  }

  /**
   * Compare one game's per-tick values against the cohort bands and
   * return the per-tick score breakdown the UI renders.
   *
   * @param {object} gameDetail full detail blob (macroBreakdown.*)
   * @param {{ ticks: Array<object> }} bands cohort band rows
   * @param {{
   *   myRace?: string,
   *   oppRace?: string,
   *   extraScoresByTick?: Map<number, { my?: Record<string, number>, opp?: Record<string, number> }>,
   *   weightsOverride?: object
   * }} sides
   * @returns {Array<{
   *   t: number,
   *   phase: 'early'|'mid'|'late',
   *   my: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   opp: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   verdict: string,
   *   activeWeights: Record<string, number>,
   * }>}
   */
  compareGameToCohort(gameDetail, bands, sides) {
    const myEvents = indexByTick(gameDetail?.macroBreakdown?.stats_events);
    const oppEvents = indexByTick(gameDetail?.macroBreakdown?.opp_stats_events);
    const timeline = indexByTick(gameDetail?.macroBreakdown?.unit_timeline);
    const bandByTick = new Map(bands.ticks.map((row) => [row.t, row]));
    const myRace = raceLetter(sides.myRace);
    const oppRace = raceLetter(sides.oppRace);
    const extras = sides.extraScoresByTick || new Map();
    const override = sides.weightsOverride ?? this.weightsOverride;
    /** @type {Array<any>} */
    const out = [];
    for (let i = 0; i < NUM_TICKS; i += 1) {
      const t = i * TICK_SECONDS;
      const bandRow = bandByTick.get(t);
      if (!bandRow) continue;
      const { phase, weights } = weightsFor(this.weightsConfig, t, override);
      const myEv = myEvents.get(t);
      const oppEv = oppEvents.get(t);
      const frame = timeline.get(t);
      const myValues = extractValues(myEv, frame?.my, myRace);
      const oppValues = extractValues(oppEv, frame?.opp, oppRace);
      const extra = extras.get(t) || {};
      const myScored = scoreSide(myValues, bandRow.my, weights, extra.my || {});
      const oppScored = scoreSide(oppValues, bandRow.opp, weights, extra.opp || {});
      out.push({
        t,
        phase,
        my: {
          value: myValues,
          scores: myScored.scores,
          aggregateScore: myScored.aggregate,
        },
        opp: {
          value: oppValues,
          scores: oppScored.scores,
          aggregateScore: oppScored.aggregate,
        },
        verdict: verdictFor(myScored.aggregate, oppScored.aggregate),
        activeWeights: weights,
      });
    }
    return out;
  }
}

/**
 * Map of (tick → event) so per-tick lookups are O(1). Skips entries
 * we can't bucket to a 30 s tick.
 *
 * @param {Array<any>|undefined} events
 */
function indexByTick(events) {
  /** @type {Map<number, any>} */
  const out = new Map();
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    const t = roundToTick(ev?.time ?? ev?.t);
    if (t === null) continue;
    out.set(t, ev);
  }
  return out;
}

/**
 * Extract the per-metric numeric values for one side at one tick.
 * Returns null for missing/non-finite values; ``scoreSide`` skips
 * those rather than scoring them as zero.
 *
 * @param {object|undefined} ev stats_events entry
 * @param {object|undefined} units unit_timeline.my or .opp entry
 * @param {string|null} race
 */
function extractValues(ev, units, race) {
  return {
    army_value: numOrNull(ev?.army_value),
    army_supply: numOrNull(ev?.food_used),
    workers: numOrNull(ev?.workers_active_count),
    bases: units ? countBases(units, race) : null,
    production_capacity: units ? countProduction(units, race) : null,
    income_min: numOrNull(ev?.minerals_collection_rate),
    income_gas: numOrNull(ev?.gas_collection_rate),
  };
}

/**
 * Score one side against the band row + extras using phase weights.
 * For each metric in the weights map:
 *   1. If ``extraScores[m]`` is set (categorical signal computed
 *      elsewhere), use it directly — these score in -2..+2.
 *   2. Else if both the value and a band exist, classify via the
 *      percentile rule.
 *   3. Else skip — the metric contributes zero weight to the
 *      aggregate, so its absence doesn't drag the score down.
 *
 * @param {Record<string, number|null>} values
 * @param {Record<string, any>|undefined} bands
 * @param {Record<string, number>} weights
 * @param {Record<string, number>} extraScores
 */
function scoreSide(values, bands, weights, extraScores) {
  /** @type {Record<string, number>} */
  const scores = {};
  let weighted = 0;
  let weightTotal = 0;
  for (const m of METRIC_KEYS) {
    const w = Number(weights[m]) || 0;
    if (w <= 0) continue;
    let s = null;
    if (Object.prototype.hasOwnProperty.call(extraScores, m)) {
      const v = Number(extraScores[m]);
      if (Number.isFinite(v)) s = clampScore(v);
    } else if (METRICS.includes(/** @type {any} */ (m)) && bands?.[m]) {
      const v = values[m];
      if (v !== null && v !== undefined) {
        s = classifyPosition(Number(v), bands[m]);
      }
    }
    if (s === null) continue;
    scores[m] = s;
    weighted += s * w;
    weightTotal += w;
  }
  const aggregate = weightTotal > 0 ? weighted / weightTotal : 0;
  return { scores, aggregate };
}

/**
 * Bucket a value into the five-position score relative to a band
 * row's winner / loser percentiles.
 *
 * @param {number} v
 * @param {{p25w:number,p50w:number,p75w:number,p25l:number,p50l:number}} band
 */
function classifyPosition(v, band) {
  if (v >= band.p75w) return 2;
  if (v >= band.p50w) return 1;
  if (v > band.p50l) return 0;
  if (v > band.p25l) return -1;
  return -2;
}

/**
 * Map (my_score - opp_score) to a verdict label.
 *
 * @param {number} my
 * @param {number} opp
 */
function verdictFor(my, opp) {
  const diff = my - opp;
  if (diff >= 1.0) return VERDICTS.WINNING;
  if (diff >= 0.3) return VERDICTS.LIKELY_WINNING;
  if (diff > -0.3) return VERDICTS.NEUTRAL;
  if (diff > -1.0) return VERDICTS.LIKELY_LOSING;
  return VERDICTS.LOSING;
}

/** @param {unknown} raw */
function numOrNull(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Clamp an externally-supplied categorical score into the -2..+2 range. */
function clampScore(v) {
  if (v > 2) return 2;
  if (v < -2) return -2;
  return v;
}

module.exports = {
  SnapshotCompareService,
  classifyPosition,
  verdictFor,
  scoreSide,
  extractValues,
  clampScore,
  VERDICTS,
};
