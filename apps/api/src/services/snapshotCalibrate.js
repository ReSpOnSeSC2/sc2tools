"use strict";

const {
  METRIC_KEYS,
  PHASE_NAMES,
  loadWeights,
  applyPresetDelta,
} = require("./snapshotWeights");

/**
 * SnapshotCalibrateService — empirically tune the snapshot scoring
 * weights via ridge regression + partial correlation.
 *
 * Inputs:
 *   * Per-game outcome (Victory=1, Defeat=0).
 *   * Per-game per-tick per-metric standardized score (the same
 *     -2..+2 buckets ``snapshotCompare.classifyPosition`` returns).
 *
 * For each phase, we:
 *   1. Stack rows from every (game, tick) pair where the tick
 *      falls inside the phase's range.
 *   2. Compute the X (features × N rows) matrix and the y vector.
 *   3. Fit ridge regression (α=1.0, features standardized) to get
 *      the linear coefficient per metric.
 *   4. Compute partial correlations: each feature's correlation
 *      with y, *controlling for every other feature*. Necessary
 *      because production_capacity, army_value, and supply move
 *      together — naïve correlations would over-weight the trio.
 *   5. Recommend weights = ridge coefficients clipped to [0, ∞)
 *      then normalized to sum to 1.0.
 *
 * Sanity gate: if any single weight would move more than ±0.10
 * from the current value in one calibration pass, the recommended
 * weights are NOT applied to ``snapshotWeights.json``; instead a
 * ``recommended.json`` sidecar is written so a human can review.
 * Prevents wild swings from one outlier-heavy cohort.
 */

const RIDGE_ALPHA = 1.0;
const MAX_DELTA = 0.1;

class SnapshotCalibrateService {
  constructor(opts = {}) {
    this.currentConfig = opts.currentConfig || loadWeights();
    this.alpha = opts.alpha ?? RIDGE_ALPHA;
    this.maxDelta = opts.maxDelta ?? MAX_DELTA;
  }

  /**
   * Run the full calibration pipeline. Returns a report ready to
   * either print + write or print + skip-write per the sanity gate.
   *
   * @param {Array<{
   *   result: 'Victory'|'Defeat'|'Tie'|string,
   *   tickScores: Array<{ t: number, my: { scores: Record<string, number> } }>,
   * }>} games
   */
  calibrate(games) {
    /** @type {Record<string, any>} */
    const perPhase = {};
    for (const phase of PHASE_NAMES) {
      const range = this.currentConfig.phases[phase].tickRange;
      const { X, y, included } = buildMatrix(games, range);
      if (X.length < METRIC_KEYS.length * 5) {
        perPhase[phase] = {
          skipped: true,
          reason: "insufficient_samples",
          sampleSize: X.length,
        };
        continue;
      }
      const coefficients = ridgeRegression(X, y, this.alpha);
      const partials = partialCorrelations(X, y);
      const r2 = computeR2(X, y, coefficients);
      const current = this.currentConfig.phases[phase].weights;
      const recommended = normalizeWeights(coefficients);
      const sanityGate = withinDelta(current, recommended, this.maxDelta);
      perPhase[phase] = {
        skipped: false,
        sampleSize: X.length,
        included,
        coefficients,
        partials,
        r2,
        currentWeights: current,
        recommendedWeights: recommended,
        sanityGate,
      };
    }
    return {
      perPhase,
      version: this.currentConfig.version,
      newVersion: this.currentConfig.version + 1,
    };
  }
}

/**
 * Stack per-(game, tick) score vectors into the feature matrix +
 * outcome vector. The outcome is the GAME's result (we duplicate
 * the same label across every tick the game contributes — ridge
 * still works because the score-row variance dominates).
 *
 * @param {Array<{ result: string, tickScores: Array<{ t: number, my: { scores: Record<string, number> } }> }>} games
 * @param {[number, number]} tickRange
 */
function buildMatrix(games, tickRange) {
  /** @type {number[][]} */
  const X = [];
  /** @type {number[]} */
  const y = [];
  let included = 0;
  for (const g of games) {
    const outcome = resultToBinary(g.result);
    if (outcome === null) continue;
    if (!Array.isArray(g.tickScores)) continue;
    let usedAny = false;
    for (const row of g.tickScores) {
      if (row.t < tickRange[0] || row.t >= tickRange[1]) continue;
      const scores = row.my?.scores || {};
      const featureRow = METRIC_KEYS.map((m) => Number(scores[m]) || 0);
      X.push(featureRow);
      y.push(outcome);
      usedAny = true;
    }
    if (usedAny) included += 1;
  }
  return { X, y, included };
}

/**
 * Closed-form ridge regression: β = (X^T X + αI)^(-1) X^T y.
 * Returns one coefficient per feature, aligned to METRIC_KEYS.
 *
 * @param {number[][]} X
 * @param {number[]} y
 * @param {number} alpha
 */
function ridgeRegression(X, y, alpha) {
  const p = X[0].length;
  const XtX = matMulTranspose(X, X);
  for (let i = 0; i < p; i += 1) XtX[i][i] += alpha;
  const Xty = matVecMulTranspose(X, y);
  const beta = solveLinearSystem(XtX, Xty);
  /** @type {Record<string, number>} */
  const out = {};
  for (let i = 0; i < METRIC_KEYS.length; i += 1) {
    out[METRIC_KEYS[i]] = beta[i] || 0;
  }
  return out;
}

/**
 * Partial correlation of each feature with y, controlling for all
 * other features. Implemented as: regress y on every other feature
 * (linear least-squares), regress x_i on every other feature, then
 * correlate the residuals. Avoids over-weighting redundant signals.
 *
 * @param {number[][]} X
 * @param {number[]} y
 */
function partialCorrelations(X, y) {
  const p = X[0].length;
  /** @type {Record<string, number>} */
  const out = {};
  for (let i = 0; i < p; i += 1) {
    const others = pickColumns(X, i);
    const yResid = residuals(others, y);
    const xResid = residuals(others, columnOf(X, i));
    out[METRIC_KEYS[i]] = pearson(yResid, xResid);
  }
  return out;
}

/**
 * R² of a fitted model. Standard formula: 1 - SS_res / SS_tot.
 */
function computeR2(X, y, coefficients) {
  const yHat = X.map((row) =>
    METRIC_KEYS.reduce((s, m, i) => s + row[i] * (coefficients[m] || 0), 0),
  );
  const yMean = mean(y);
  const ssRes = y.reduce((s, v, i) => s + (v - yHat[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  if (ssTot === 0) return 0;
  return 1 - ssRes / ssTot;
}

/**
 * Convert raw coefficients (which can be negative or unbounded)
 * into a normalized weights map summing to 1.0. Negatives clip
 * to 0 because a negative weight means "worse score = better
 * outcome", which is nonsensical for these signals — almost
 * always indicates a redundant correlation already covered by
 * another feature.
 *
 * @param {Record<string, number>} coefficients
 */
function normalizeWeights(coefficients) {
  const clipped = {};
  let total = 0;
  for (const k of METRIC_KEYS) {
    const c = Math.max(0, Number(coefficients[k]) || 0);
    clipped[k] = c;
    total += c;
  }
  if (total === 0) {
    // No useful signal — fall back to uniform.
    const w = 1 / METRIC_KEYS.length;
    return METRIC_KEYS.reduce((m, k) => ({ ...m, [k]: w }), {});
  }
  for (const k of METRIC_KEYS) clipped[k] /= total;
  return clipped;
}

/**
 * Sanity gate — reject if any metric's recommended weight is more
 * than ``maxDelta`` away from its current value. Returns
 * ``{ passed: true }`` on success, ``{ passed: false, violations }``
 * with the offending metrics on failure.
 *
 * @param {Record<string, number>} current
 * @param {Record<string, number>} next
 * @param {number} maxDelta
 */
function withinDelta(current, next, maxDelta) {
  const violations = [];
  for (const k of METRIC_KEYS) {
    const diff = Math.abs((Number(next[k]) || 0) - (Number(current[k]) || 0));
    if (diff > maxDelta + 1e-6) {
      violations.push({ metric: k, currentValue: current[k], nextValue: next[k], delta: diff });
    }
  }
  return violations.length === 0
    ? { passed: true }
    : { passed: false, violations };
}

/* ---- linear-algebra helpers (small matrices only) ---- */

function matMulTranspose(X, Y) {
  const p = X[0].length;
  /** @type {number[][]} */
  const out = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < p; j += 1) {
      let s = 0;
      for (let r = 0; r < X.length; r += 1) s += X[r][i] * Y[r][j];
      out[i][j] = s;
    }
  }
  return out;
}

function matVecMulTranspose(X, v) {
  const p = X[0].length;
  const out = new Array(p).fill(0);
  for (let i = 0; i < p; i += 1) {
    let s = 0;
    for (let r = 0; r < X.length; r += 1) s += X[r][i] * v[r];
    out[i] = s;
  }
  return out;
}

function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i += 1) {
    let maxRow = i;
    for (let k = i + 1; k < n; k += 1) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) continue;
    for (let k = i + 1; k < n; k += 1) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j += 1) M[k][j] -= factor * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j += 1) s -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) > 1e-12 ? s / M[i][i] : 0;
  }
  return x;
}

function pickColumns(X, skipIdx) {
  return X.map((row) => row.filter((_, i) => i !== skipIdx));
}

function columnOf(X, idx) {
  return X.map((row) => row[idx]);
}

/**
 * Residuals of y after OLS regression on X (with bias term).
 * Adds an intercept column inside so we don't pollute the caller.
 */
function residuals(X, y) {
  const Xb = X.map((row) => [1, ...row]);
  const XtX = matMulTranspose(Xb, Xb);
  const Xty = matVecMulTranspose(Xb, y);
  const beta = solveLinearSystem(XtX, Xty);
  return y.map((v, i) => {
    const yHat = beta.reduce((s, b, k) => s + b * Xb[i][k], 0);
    return v - yHat;
  });
}

function pearson(a, b) {
  if (a.length === 0) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    num += da * db;
    sa += da * da;
    sb += db * db;
  }
  if (sa === 0 || sb === 0) return 0;
  return num / Math.sqrt(sa * sb);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function resultToBinary(result) {
  const s = String(result || "").toLowerCase();
  if (s === "victory" || s === "win") return 1;
  if (s === "defeat" || s === "loss") return 0;
  return null;
}

module.exports = {
  SnapshotCalibrateService,
  buildMatrix,
  ridgeRegression,
  partialCorrelations,
  normalizeWeights,
  withinDelta,
  resultToBinary,
  pearson,
  RIDGE_ALPHA,
  MAX_DELTA,
};
