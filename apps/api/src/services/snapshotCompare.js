"use strict";

const {
  METRICS,
  TICK_SECONDS,
  NUM_TICKS,
  roundToTick,
  raceLetter,
  countBases,
} = require("./snapshotCohort");

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
 * score; the headline verdict for the tick is the user's aggregate
 * minus the opponent's. Same scoring runs on both sides, against
 * its own side's cohort bands, so a "winning" verdict means "your
 * macro is better than the opponent's macro at this tick versus a
 * comparable cohort" rather than "your macro is good in absolute
 * terms".
 *
 * No-mock contract: every tick value comes from real stats_events /
 * unit_timeline entries on the requested game record. A missing
 * tick is reported as ``unknown``, never a synthesized score.
 */

const SCORE_WEIGHTS = Object.freeze({
  army_value: 0.35,
  army_supply: 0.2,
  workers: 0.2,
  bases: 0.15,
  income_min: 0.05,
  income_gas: 0.05,
});

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
   * Compare one game's per-tick values against the cohort bands and
   * return the per-tick score breakdown the UI renders.
   *
   * @param {object} gameDetail full detail blob (macroBreakdown.*)
   * @param {{ ticks: Array<object> }} bands cohort band rows
   * @param {{ myRace?: string, oppRace?: string }} sides
   * @returns {Array<{
   *   t: number,
   *   my: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   opp: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   verdict: string,
   * }>}
   */
  compareGameToCohort(gameDetail, bands, sides) {
    const myEvents = indexByTick(gameDetail?.macroBreakdown?.stats_events);
    const oppEvents = indexByTick(gameDetail?.macroBreakdown?.opp_stats_events);
    const timeline = indexByTick(gameDetail?.macroBreakdown?.unit_timeline);
    const bandByTick = new Map(bands.ticks.map((row) => [row.t, row]));
    const myRace = raceLetter(sides.myRace);
    const oppRace = raceLetter(sides.oppRace);
    /** @type {Array<any>} */
    const out = [];
    for (let i = 0; i < NUM_TICKS; i += 1) {
      const t = i * TICK_SECONDS;
      const bandRow = bandByTick.get(t);
      if (!bandRow) continue;
      const myEv = myEvents.get(t);
      const oppEv = oppEvents.get(t);
      const frame = timeline.get(t);
      const myValues = extractValues(myEv, frame?.my, myRace);
      const oppValues = extractValues(oppEv, frame?.opp, oppRace);
      const myScored = scoreSide(myValues, bandRow.my);
      const oppScored = scoreSide(oppValues, bandRow.opp);
      out.push({
        t,
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
    income_min: numOrNull(ev?.minerals_collection_rate),
    income_gas: numOrNull(ev?.gas_collection_rate),
  };
}

/**
 * Score one side's values against the matching cohort band row.
 * Missing values contribute 0 weight (and 0 score) so a partial
 * tick still produces a meaningful aggregate — but a totally empty
 * tick scores zero, which classifies as Neutral. The UI treats
 * zero-weight ticks as ``unknown`` upstream via the value map.
 *
 * @param {Record<string, number|null>} values
 * @param {Record<string, any>|undefined} bands the my or opp side of bandRow
 */
function scoreSide(values, bands) {
  /** @type {Record<string, number>} */
  const scores = {};
  let weighted = 0;
  let weightTotal = 0;
  for (const m of METRICS) {
    const v = values[m];
    const band = bands?.[m];
    if (v === null || !band) continue;
    const s = classifyPosition(v, band);
    scores[m] = s;
    const w = SCORE_WEIGHTS[m] || 0;
    weighted += s * w;
    weightTotal += w;
  }
  const aggregate = weightTotal > 0 ? weighted / weightTotal : 0;
  return { scores, aggregate };
}

/**
 * Bucket a value into the five-position score relative to a band
 * row's winner / loser percentiles. The bands carry both winner
 * (p25w..p90w) and loser (p25l..p75l) percentiles; ties at a
 * boundary fall to the higher score (the "≥" / "≤" mix in the
 * thresholds is deliberate so adjacent buckets don't both claim
 * the same value).
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
 * Map (my_score - opp_score) to a verdict label. Thresholds match
 * the per-metric position buckets so a "winning" verdict requires
 * the user's macro to be roughly a full score-position better than
 * the opponent's — anything tighter is neutral, anything wider is
 * decisively winning / losing.
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

module.exports = {
  SnapshotCompareService,
  classifyPosition,
  verdictFor,
  scoreSide,
  extractValues,
  SCORE_WEIGHTS,
  VERDICTS,
};
