"use strict";

/**
 * practiceGrade — the server copy of web/lib/ghostGrade.ts ``gradeExecution``
 * plus the slim ``practice`` record the ingest stores on a game row.
 *
 * The two graders must agree on every input: both suites run the cases in
 * web/lib/__tests__/fixtures/ghost-grade-parity.json (practiceGrade.test.js
 * here, ghostGradeParity.test.ts in the web app), so a threshold or
 * alignment change that lands on one side only fails a suite.
 *
 * Alignment is greedy in-order name matching; drift is actual minus planned
 * seconds over matched steps; the first divergence is the earliest step that
 * was cut or is more than DIVERGENCE_DRIFT_SEC off. See ghostGrade.ts for the
 * full contract and the letter thresholds.
 */

const crypto = require("crypto");
const { gradeCheckpoints } = require("./practiceCheckpoints");

/** A matched step this far off counts as the point the build fell apart. */
const DIVERGENCE_DRIFT_SEC = 30;
const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;
const PRACTICE_RECORD_VERSION = 1;
/** Steps listed in ``worstSteps``. */
const WORST_STEP_LIMIT = 5;
/** A step within this many seconds is on time and never a "worst" step. */
const ON_TIME_SEC = 5;
/** Stored drifts are clamped to three digits. */
const MAX_STORED_DRIFT = 999;
/** ``practice.status`` of a game in the practised matchup with no build log. */
const NO_BUILD_LOG = "no_build_log";

/** Lowercase letters and digits only — ghostBuild.ts normalizeGhostName.
 * @param {unknown} input */
function normalizeGhostName(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The six race spellings SC2Tools emits; anything else is not a matchup side.
 * @param {unknown} input @returns {"P"|"T"|"Z"|null} */
function concreteRace(input) {
  if (typeof input !== "string") return null;
  switch (input.trim().toLowerCase()) {
    case "p": case "protoss": return "P";
    case "t": case "terran": return "T";
    case "z": case "zerg": return "Z";
    default: return null;
  }
}

/** Own-race-first matchup ("PvZ"), or null unless both races are concrete.
 * @param {unknown} myRace @param {unknown} opponentRace */
function ghostMatchupKey(myRace, opponentRace) {
  const mine = concreteRace(myRace);
  const theirs = concreteRace(opponentRace);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

/** @param {unknown} lines @returns {Array<{t: number, normalized: string}>} */
function parseExecutedLog(lines) {
  /** @type {Array<{t: number, normalized: string}>} */
  const events = [];
  if (!Array.isArray(lines)) return events;
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const m = BUILD_LOG_LINE_RE.exec(line);
    if (!m) continue;
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    const normalized = normalizeGhostName(m[3]);
    if (!normalized) continue;
    events.push({ t: minutes * 60 + seconds, normalized });
  }
  return events;
}

/** @param {number} n */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** @param {number} matchRate @param {boolean} allMatched @param {number} avg @param {number} max */
function letterFor(matchRate, allMatched, avg, max) {
  if (allMatched && avg <= 5 && max <= 15) return "S";
  if (matchRate >= 0.9 && avg <= 10 && max <= 30) return "A";
  if (matchRate >= 0.75 && avg <= 20) return "B";
  if (matchRate >= 0.5 && avg <= 40) return "C";
  return "D";
}

/**
 * Grade an executed ``[m:ss] Name`` build log against a Ghost target.
 *
 * @param {{steps: Array<{name: string, t: number, supply: number|null}>}} target
 * @param {unknown} executedLog
 */
function gradeExecution(target, executedLog) {
  const steps = target.steps;
  if (steps.length === 0) {
    return { grade: "S", targetSteps: 0, matchedSteps: 0, avgDriftSec: 0, maxDriftSec: 0, firstDivergence: null, perStep: [] };
  }
  const executed = parseExecutedLog(executedLog);
  /** @type {Array<{index: number, name: string, supply: number|null, expectedT: number, actualT: number|null, driftSec: number|null, matched: boolean}>} */
  const perStep = [];
  let cursor = 0;
  steps.forEach((step, index) => {
    const wanted = normalizeGhostName(step.name);
    let matchedAt = -1;
    for (let j = cursor; j < executed.length; j += 1) {
      if (executed[j].normalized === wanted) {
        matchedAt = j;
        break;
      }
    }
    const base = { index, name: step.name, supply: step.supply, expectedT: step.t };
    if (matchedAt < 0) {
      perStep.push({ ...base, actualT: null, driftSec: null, matched: false });
      return;
    }
    const actualT = executed[matchedAt].t;
    perStep.push({ ...base, actualT, driftSec: actualT - step.t, matched: true });
    cursor = matchedAt + 1;
  });
  const absDrifts = perStep.filter((s) => s.matched).map((s) => Math.abs(/** @type {number} */ (s.driftSec)));
  const avgDriftSec = absDrifts.length > 0 ? round1(absDrifts.reduce((a, b) => a + b, 0) / absDrifts.length) : 0;
  const maxDriftSec = absDrifts.length > 0 ? Math.max(...absDrifts) : 0;
  const diverged = perStep.find((s) => !s.matched || Math.abs(/** @type {number} */ (s.driftSec)) > DIVERGENCE_DRIFT_SEC);
  const firstDivergence = diverged
    ? { index: diverged.index, name: diverged.name, expectedT: diverged.expectedT, actualT: diverged.actualT }
    : null;
  return {
    grade: letterFor(absDrifts.length / steps.length, absDrifts.length === steps.length, avgDriftSec, maxDriftSec),
    targetSteps: steps.length,
    matchedSteps: absDrifts.length,
    avgDriftSec,
    maxDriftSec,
    firstDivergence,
    perStep,
  };
}

/**
 * Stable 16-hex identity of a target's content (name and steps). Re-arming
 * the same build keeps the hash, so its games group together.
 *
 * @param {{name: string, steps: Array<{name: string, t: number, supply: number|null}>}} target
 */
function targetHash(target) {
  const canonical = JSON.stringify([target.name, target.steps.map((s) => [s.t, s.name, s.supply ?? null])]);
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** @param {number} n */
function clampDrift(n) {
  return Math.max(-MAX_STORED_DRIFT, Math.min(MAX_STORED_DRIFT, Math.round(n)));
}

/**
 * The slim ``practice`` record of one graded game (a few hundred bytes):
 * ``drifts`` holds every step's signed drift, comma separated, with "x" for
 * a cut step, so per-step trends survive without the target's step list.
 *
 * @param {{
 *   target: {name: string, steps: Array<{name: string, t: number, supply: number|null}>},
 *   hash: string, matchup: string, buildLog: unknown,
 *   via: "ingest" | "request", gradedAt: Date,
 *   checkpoints?: import('./practiceCheckpoints').Checkpoint[],
 * }} input
 */
function practiceRecord({ target, hash, matchup, buildLog, via, gradedAt, checkpoints = [] }) {
  const base = { v: PRACTICE_RECORD_VERSION, targetHash: hash, targetName: target.name, matchup, via, gradedAt };
  if (parseExecutedLog(buildLog).length === 0) return { ...base, status: NO_BUILD_LOG };
  const result = gradeExecution(target, buildLog);
  const worstSteps = result.perStep
    .filter((s) => !s.matched || Math.abs(/** @type {number} */ (s.driftSec)) > ON_TIME_SEC)
    .sort((a, b) => severity(b) - severity(a) || a.index - b.index)
    .slice(0, WORST_STEP_LIMIT)
    .map((s) => ({ i: s.index, name: s.name, d: s.driftSec === null ? null : clampDrift(s.driftSec) }));
  const divergence = result.firstDivergence;
  return {
    ...base,
    grade: result.grade,
    matched: result.matchedSteps,
    total: result.targetSteps,
    avgDrift: result.avgDriftSec,
    maxDrift: clampDrift(result.maxDriftSec),
    firstDivergence: divergence
      ? { i: divergence.index, name: divergence.name, expectedT: divergence.expectedT, actualT: divergence.actualT }
      : null,
    worstSteps,
    ...(checkpoints.length ? { checkpoints: gradeCheckpoints(checkpoints, result.perStep) } : {}),
    drifts: result.perStep.map((s) => (s.driftSec === null ? "x" : String(clampDrift(s.driftSec)))).join(","),
  };
}

/** A cut step outranks any drift. @param {{driftSec: number|null}} step */
function severity(step) {
  return step.driftSec === null ? Number.POSITIVE_INFINITY : Math.abs(step.driftSec);
}

/** Per-step drifts back from a stored ``drifts`` string; null for a cut step.
 * @param {unknown} encoded @returns {Array<number|null>} */
function decodeDrifts(encoded) {
  if (typeof encoded !== "string" || !encoded) return [];
  return encoded.split(",").map((part) => {
    if (part === "x") return null;
    const n = Number(part);
    return Number.isFinite(n) ? n : null;
  });
}

module.exports = {
  DIVERGENCE_DRIFT_SEC,
  NO_BUILD_LOG,
  PRACTICE_RECORD_VERSION,
  concreteRace,
  decodeDrifts,
  ghostMatchupKey,
  gradeExecution,
  normalizeGhostName,
  practiceRecord,
  targetHash,
};
