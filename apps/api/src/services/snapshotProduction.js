"use strict";

/**
 * SnapshotProductionService — per-tick production-capacity counts.
 *
 * Production capacity is the single best predictor of "can I
 * reinforce after a fight?" in mid-game; two players with identical
 * army_value at 8:00 but different gateway / barracks counts
 * diverge fast. We surface it as a continuous metric with the
 * same percentile-band treatment the other macro metrics already
 * have (see ``snapshotCohort.aggregateBands``).
 *
 * Race-aware count formula:
 *
 *   Protoss:  Gateway + WarpGate + RoboticsFacility + Stargate
 *   Terran:   Barracks + Factory + Starport + 0.5 * Reactor_count
 *   Zerg:     Hatchery + Lair + Hive
 *
 * For Zerg this intentionally equals ``base_count`` — larva
 * production is 1:1 with hatcheries. The cohort comparison is
 * race-keyed (cohort filter pins my_race) so no cross-race
 * normalization is needed.
 *
 * The Terran reactor bonus is half-units because a reactor on a
 * barracks doubles its rax-equivalent output (one rax = two
 * marines per build cycle when reactored). Half a unit per reactor
 * keeps the metric continuous and avoids double-counting.
 *
 * Reads from ``unit_timeline`` frames the same way ``countBases``
 * does — the agent already emits per-tick unit/structure counts.
 */

const PRODUCTION_UNITS = Object.freeze({
  P: ["Gateway", "WarpGate", "RoboticsFacility", "Stargate"],
  T: ["Barracks", "Factory", "Starport"],
  Z: ["Hatchery", "Lair", "Hive"],
});

const REACTOR_NAMES = Object.freeze([
  "Reactor",
  "BarracksReactor",
  "FactoryReactor",
  "StarportReactor",
]);

const PRODUCTION_METRIC = "production_capacity";

/**
 * Count production capacity for one side at one tick. Returns null
 * for unknown / missing race so the cohort fold drops the value
 * cleanly rather than scoring a zero into the percentile bucket.
 *
 * @param {Record<string, unknown>|undefined} units unit_timeline.my or .opp entry
 * @param {string|null} race single-letter race code 'P'|'T'|'Z'
 * @returns {number|null}
 */
function countProduction(units, race) {
  if (!units || typeof units !== "object" || !race) return null;
  const names = PRODUCTION_UNITS[/** @type {'P'|'T'|'Z'} */ (race)];
  if (!names) return null;
  let total = 0;
  for (const n of names) {
    const v = Number(units[n]);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  if (race === "T") {
    for (const n of REACTOR_NAMES) {
      const v = Number(units[n]);
      if (Number.isFinite(v) && v > 0) total += v * 0.5;
    }
  }
  return total;
}

/**
 * For a single game's unit_timeline, project per-tick production
 * counts keyed by 30 s tick. Convenience for the compare/route
 * path that already has the timeline indexed.
 *
 * @param {Array<any>|undefined} timeline
 * @param {string|null} race
 * @returns {Map<number, number>}
 */
function projectProductionByTick(timeline, race) {
  /** @type {Map<number, number>} */
  const out = new Map();
  if (!Array.isArray(timeline) || !race) return out;
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t === null) continue;
    const v = countProduction(frame?.my, race);
    if (v !== null) out.set(t, v);
  }
  return out;
}

/**
 * Mirror of ``projectProductionByTick`` for the opponent side —
 * extracted as a separate function so callers can pick which side
 * without having to pass a discriminator everywhere.
 *
 * @param {Array<any>|undefined} timeline
 * @param {string|null} race
 * @returns {Map<number, number>}
 */
function projectOppProductionByTick(timeline, race) {
  /** @type {Map<number, number>} */
  const out = new Map();
  if (!Array.isArray(timeline) || !race) return out;
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t === null) continue;
    const v = countProduction(frame?.opp, race);
    if (v !== null) out.set(t, v);
  }
  return out;
}

/** @param {unknown} raw */
function roundToTick(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const t = Math.round(n / 30) * 30;
  if (t > 20 * 60) return null;
  return t;
}

module.exports = {
  PRODUCTION_METRIC,
  PRODUCTION_UNITS,
  REACTOR_NAMES,
  countProduction,
  projectProductionByTick,
  projectOppProductionByTick,
};
