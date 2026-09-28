"use strict";

/**
 * Wilson score interval — the ranking and uncertainty primitive of the
 * public build guides (services/guideStats*.js).
 *
 * A raw win rate over a handful of games is noise ("3-0 = 100%"); the
 * lower bound of the 95% Wilson interval rewards both a high rate and
 * enough games to believe it, so guides rank by ``ci.low`` and never by
 * raw win rate. Fractions are rounded to 4 dp like every other rate the
 * guides emit.
 */

const { GUIDE_WILSON_Z } = require("../config/guides");

/** Decimal places kept on every emitted fraction. */
const FRACTION_DP = 4;
const FRACTION_SCALE = 10 ** FRACTION_DP;

/**
 * Round a fraction to 4 dp.
 *
 * Example: `round4(2 / 3)` → 0.6667.
 *
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * FRACTION_SCALE) / FRACTION_SCALE;
}

/**
 * 95% Wilson score interval for ``successes`` out of ``trials``.
 *
 * Example: `wilsonInterval(60, 100)` → `{ low: 0.502, high: 0.6906 }`.
 *
 * @param {number} successes wins (0 ≤ successes ≤ trials)
 * @param {number} trials    decided games (> 0)
 * @param {number} [z]       z-score (default GUIDE_WILSON_Z = 1.96)
 * @returns {{ low: number, high: number } | null} null when trials ≤ 0 or inputs are invalid
 */
function wilsonInterval(successes, trials, z = GUIDE_WILSON_Z) {
  if (!Number.isFinite(successes) || !Number.isFinite(trials)) return null;
  if (trials <= 0 || successes < 0 || successes > trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return {
    low: round4(Math.max(0, center - margin)),
    high: round4(Math.min(1, center + margin)),
  };
}

module.exports = { FRACTION_DP, round4, wilsonInterval };
