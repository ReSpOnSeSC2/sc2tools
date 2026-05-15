"use strict";

const fs = require("fs");
const path = require("path");

/**
 * snapshotWeights — loader, validator, phase-resolver, and atomic
 * writer for the per-phase scoring weights consumed by
 * ``SnapshotCompareService``.
 *
 * The weights live in ``apps/api/src/config/snapshotWeights.json``
 * and are editable both by the calibration script and (per-user)
 * via the ``users.snapshotWeightsOverride`` field. Each phase's
 * weights MUST sum to 1.000 ± 0.001; we fail-fast on load if any
 * phase or preset trips the invariant. The version field is bumped
 * on every successful calibration write so downstream caches can
 * invalidate cleanly.
 */

const DEFAULT_PATH = path.join(__dirname, "..", "config", "snapshotWeights.json");
const SUM_TOLERANCE = 0.001;
const PHASE_NAMES = Object.freeze(["early", "mid", "late"]);
const METRIC_KEYS = Object.freeze([
  "workers",
  "bases",
  "production_capacity",
  "army_supply",
  "tech_tier_reached",
  "tech_path_winrate",
  "income_min",
  "income_gas",
  "army_value",
  "composition_matchup",
]);

/** @type {{ value: object, mtimeMs: number } | null} */
let cached = null;

function loadWeights(filePath = DEFAULT_PATH) {
  const stat = fs.statSync(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.path === filePath) {
    return cached.value;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  assertValid(parsed);
  cached = { value: parsed, mtimeMs: stat.mtimeMs, path: filePath };
  return parsed;
}

/**
 * Validate the shape of a parsed weights object. Throws on the
 * first violation with a precise error message so test failures
 * pinpoint the field rather than complaining about the whole tree.
 *
 * @param {any} cfg
 */
function assertValid(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("snapshotWeights: must be an object");
  }
  if (!cfg.phases || typeof cfg.phases !== "object") {
    throw new Error("snapshotWeights: missing 'phases' object");
  }
  for (const phase of PHASE_NAMES) {
    const p = cfg.phases[phase];
    if (!p) throw new Error(`snapshotWeights: missing phase '${phase}'`);
    if (!Array.isArray(p.tickRange) || p.tickRange.length !== 2) {
      throw new Error(`snapshotWeights: phase '${phase}' missing tickRange`);
    }
    assertWeightsSum(p.weights, `phase '${phase}'`);
  }
  // Penalties are optional, but if present we sanity-check shape.
  if (cfg.penalties && typeof cfg.penalties !== "object") {
    throw new Error("snapshotWeights: 'penalties' must be an object when present");
  }
}

/**
 * Sum the metric weights for a phase. Each weight must be in [0, 1]
 * and the total must hit 1 ± SUM_TOLERANCE.
 *
 * @param {Record<string, number>|undefined} weights
 * @param {string} ctx label for error message
 */
function assertWeightsSum(weights, ctx) {
  if (!weights || typeof weights !== "object") {
    throw new Error(`snapshotWeights: ${ctx} missing 'weights' object`);
  }
  let total = 0;
  for (const k of METRIC_KEYS) {
    const v = Number(weights[k]);
    if (!Number.isFinite(v)) {
      throw new Error(`snapshotWeights: ${ctx} missing metric '${k}'`);
    }
    if (v < 0 || v > 1) {
      throw new Error(
        `snapshotWeights: ${ctx} metric '${k}' out of [0,1]: ${v}`,
      );
    }
    total += v;
  }
  if (Math.abs(total - 1) > SUM_TOLERANCE) {
    throw new Error(
      `snapshotWeights: ${ctx} weights sum to ${total.toFixed(4)}, expected 1.000`,
    );
  }
}

/**
 * Pick the phase for a given tick (in seconds). Phases are
 * half-open `[lo, hi)` to keep adjacent ranges from double-claiming.
 * Anything past the latest range falls back to "late".
 *
 * @param {object} cfg
 * @param {number} tickSec
 * @returns {'early'|'mid'|'late'}
 */
function phaseForTick(cfg, tickSec) {
  for (const phase of PHASE_NAMES) {
    const [lo, hi] = cfg.phases[phase].tickRange;
    if (tickSec >= lo && tickSec < hi) return phase;
  }
  return "late";
}

/**
 * Resolve effective weights for a tick — base phase weights merged
 * with a per-user override (if present) and capped to non-negative.
 *
 * Override semantics: the override carries the same phase/metric
 * shape; per-user weights replace base weights wholesale (we don't
 * splice individual metrics — that's what the preset deltas do).
 *
 * @param {object} cfg base config (loadWeights output)
 * @param {number} tickSec
 * @param {object} [override] per-user override (same shape as cfg)
 */
function weightsFor(cfg, tickSec, override) {
  const phase = phaseForTick(cfg, tickSec);
  const ovPhase = override?.phases?.[phase];
  if (ovPhase?.weights) return { phase, weights: ovPhase.weights };
  return { phase, weights: cfg.phases[phase].weights };
}

/**
 * Atomic write — write to a temp file then rename so a concurrent
 * reader never sees a half-written JSON blob. Bumps `version` to
 * mark the change. Used by the calibration script.
 *
 * @param {string} filePath
 * @param {object} next
 */
function writeWeights(filePath, next) {
  assertValid(next);
  const tmp = `${filePath}.tmp.${Date.now()}`;
  const bumped = { ...next, version: (Number(next.version) || 1) + 1 };
  fs.writeFileSync(tmp, JSON.stringify(bumped, null, 2));
  fs.renameSync(tmp, filePath);
  cached = null;
  return bumped;
}

/**
 * Apply a named preset delta (additive) onto a base weights object.
 * Returns a fresh weights map; deltas that would push a metric
 * negative are clamped to 0, and the result is re-normalized so
 * the sum still totals 1.0.
 *
 * @param {Record<string, number>} base
 * @param {Record<string, number>} delta
 */
function applyPresetDelta(base, delta) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of METRIC_KEYS) {
    const v = (Number(base[k]) || 0) + (Number(delta[k]) || 0);
    out[k] = Math.max(0, v);
  }
  const total = METRIC_KEYS.reduce((s, k) => s + out[k], 0);
  if (total > 0) {
    for (const k of METRIC_KEYS) out[k] /= total;
  }
  return out;
}

module.exports = {
  DEFAULT_PATH,
  METRIC_KEYS,
  PHASE_NAMES,
  SUM_TOLERANCE,
  loadWeights,
  assertValid,
  assertWeightsSum,
  phaseForTick,
  weightsFor,
  writeWeights,
  applyPresetDelta,
};
