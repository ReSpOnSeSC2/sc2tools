"use strict";

const RULES = Object.freeze(require("../config/mmrExpectation.json"));
const BIN_COUNT = (RULES.maximumDelta - RULES.minimumDelta) / RULES.binWidth;
const LOG_ODDS_SCALE = Math.LN10 / RULES.eloScale;
const EPSILON = 1e-12;

/** @typedef {{diff:number, probability:number}} CurveAnchor */
/** @typedef {{anchors:CurveAnchor[], sampleGames:number, supportedBins:number, method:"calibrated"|"elo"}} Calibration */
/** @typedef {{diff:number, success:number, weight:number}} WeightedPoint */

const finite = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value);
const logOdds = (/** @type {number} */ probability) => Math.log(probability) - Math.log1p(-probability);

/** Delta is OPPONENT minus PLAYER replay MMR. Larger delta means a lower
 * expected player win rate. Tails never get counted in calibration edge bins.
 * @param {number} difference */
function binForDifference(difference) {
  if (!finite(difference) || difference < RULES.minimumDelta || difference > RULES.maximumDelta) return null;
  const index = difference === RULES.maximumDelta ? BIN_COUNT - 1 : Math.floor((difference - RULES.minimumDelta) / RULES.binWidth);
  const minimum = RULES.minimumDelta + index * RULES.binWidth;
  return { index, minimum, maximum: minimum + RULES.binWidth, center: minimum + RULES.binWidth / 2 };
}

/** Stable for either sign of the log odds. @param {number} value */
function sigmoid(value) {
  const e = Math.exp(-Math.abs(value));
  return value >= 0 ? 1 / (1 + e) : e / (1 + e);
}

/** Weighted PAV for a NONINCREASING win-rate curve. The block estimate is
 * pooled successes / pooled weight, rather than an unweighted mean of bins.
 * @param {WeightedPoint[]} points @returns {CurveAnchor[]} */
function decreasingPav(points) {
  /** @type {Array<{first:number,last:number,success:number,weight:number}>} */
  const blocks = [];
  points.forEach((point, index) => {
    blocks.push({ first: index, last: index, success: point.success, weight: point.weight });
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1], left = blocks[blocks.length - 2];
      if (left.success / left.weight >= right.success / right.weight) break;
      blocks.splice(-2, 2, { first: left.first, last: right.last, success: left.success + right.success, weight: left.weight + right.weight });
    }
  });
  const anchors = points.map(point => ({ diff: point.diff, probability: .5 }));
  for (const block of blocks) for (let i = block.first; i <= block.last; i++) anchors[i].probability = block.success / block.weight;
  return anchors;
}

/** Symmetric half-win/half-loss regularization avoids certainty from finite
 * corpus samples. Mirrored fit constraints enforce rating-swap symmetry;
 * they are not observations and never increase reported sample counts.
 * Only original bins with at least 200 games enter the fit.
 * @param {unknown} rows @returns {Calibration} */
function fitCalibration(rows) {
  /** @type {Map<number,{n:number,wins:number}>} */
  const raw = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Number.isInteger(row.bin) || row.bin < 0 || row.bin >= BIN_COUNT || !Number.isSafeInteger(row.n) || row.n <= 0 || !Number.isSafeInteger(row.wins) || row.wins < 0 || row.wins > row.n) continue;
    const old = raw.get(row.bin) || { n: 0, wins: 0 };
    if (Number.isSafeInteger(old.n + row.n)) raw.set(row.bin, { n: old.n + row.n, wins: old.wins + row.wins });
  }
  /** @type {Map<number,WeightedPoint>} */
  const combined = new Map();
  let sampleGames = 0, supportedBins = 0;
  const add = (/** @type {number} */ diff, /** @type {number} */ success, /** @type {number} */ weight) => {
    const old = combined.get(diff);
    combined.set(diff, { diff, success: (old?.success || 0) + success, weight: (old?.weight || 0) + weight });
  };
  for (const [index, row] of raw) {
    if (row.n < RULES.minimumBinGames) continue;
    const center = RULES.minimumDelta + (index + .5) * RULES.binWidth;
    const weight = row.n + 2 * RULES.binPrior, success = row.wins + RULES.binPrior;
    add(center, success, weight); add(-center, weight - success, weight);
    sampleGames += row.n; supportedBins++;
  }
  const anchors = decreasingPav([...combined.values()].sort((a, b) => a.diff - b.diff));
  return { anchors, sampleGames, supportedBins, method: anchors.length ? "calibrated" : "elo" };
}

/** Fail back to Elo if a stored curve is malformed, increasing, asymmetric,
 * unbounded or claims exact certainty. @param {{anchors?:CurveAnchor[]}|null|undefined} curve */
function validatedAnchors(curve) {
  const anchors = curve?.anchors;
  if (!Array.isArray(anchors) || anchors.length < 2 || anchors.length > BIN_COUNT) return null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i], previous = anchors[i - 1], opposite = anchors[anchors.length - 1 - i];
    if (!a || !finite(a.diff) || a.diff < RULES.minimumDelta || a.diff > RULES.maximumDelta || !finite(a.probability) || a.probability <= 0 || a.probability >= 1) return null;
    if (previous && (previous.diff >= a.diff || previous.probability < a.probability)) return null;
    if (!opposite || Math.abs(a.diff + opposite.diff) > EPSILON || Math.abs(a.probability + opposite.probability - 1) > EPSILON) return null;
  }
  return anchors;
}

/** @param {number} difference @param {{anchors?:CurveAnchor[]}|null} [curve] @returns {number|null} */
function expectedWin(difference, curve = null) {
  if (!finite(difference)) return null;
  const anchors = validatedAnchors(curve);
  if (!anchors) return sigmoid(-difference * LOG_ODDS_SCALE);
  const first = anchors[0], last = anchors[anchors.length - 1];
  // Elo-shaped tails meet the calibrated endpoint continuously. Their
  // observations were excluded from fitting, not clamped into an edge bin.
  if (difference < first.diff) return sigmoid(logOdds(first.probability) - (difference - first.diff) * LOG_ODDS_SCALE);
  if (difference > last.diff) return sigmoid(logOdds(last.probability) - (difference - last.diff) * LOG_ODDS_SCALE);
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (difference <= b.diff) return a.probability + (b.probability - a.probability) * (difference - a.diff) / (b.diff - a.diff);
  }
  return last.probability;
}

/** Opponent-minus-player rating offset at a measured rate. A flat isotonic
 * interval has no unique inverse: use its midpoint, preserving swap symmetry.
 * @param {number} rate @param {{anchors?:CurveAnchor[]}|null} [curve] @returns {number|null} */
function inverseExpected(rate, curve = null) {
  if (!finite(rate) || rate <= 0 || rate >= 1) return null;
  const anchors = validatedAnchors(curve);
  if (!anchors) return -logOdds(rate) / LOG_ODDS_SCALE;
  const same = anchors.filter(row => Math.abs(row.probability - rate) <= EPSILON);
  if (same.length) return (same[0].diff + same[same.length - 1].diff) / 2;
  const first = anchors[0], last = anchors[anchors.length - 1];
  if (rate > first.probability) return first.diff - (logOdds(rate) - logOdds(first.probability)) / LOG_ODDS_SCALE;
  if (rate < last.probability) return last.diff - (logOdds(rate) - logOdds(last.probability)) / LOG_ODDS_SCALE;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (a.probability > rate && b.probability < rate) return a.diff + (b.diff - a.diff) * (a.probability - rate) / (a.probability - b.probability);
  }
  return null;
}

/** An all-win/all-loss sample has no finite performance point estimate.
 * @param {number} opponentAverage @param {number} wins @param {number} games
 * @param {{anchors?:CurveAnchor[]}|null} [curve] @returns {number|null} */
function performanceRating(opponentAverage, wins, games, curve = null) {
  if (!finite(opponentAverage) || opponentAverage < 500 || opponentAverage > 9999 || !Number.isSafeInteger(games) || games <= 0 || !Number.isSafeInteger(wins) || wins <= 0 || wins >= games) return null;
  const difference = inverseExpected(wins / games, curve);
  return difference === null ? null : opponentAverage - difference;
}

module.exports = { RULES, BIN_COUNT, binForDifference, decreasingPav, fitCalibration, validatedAnchors, expectedWin, inverseExpected, performanceRating };
