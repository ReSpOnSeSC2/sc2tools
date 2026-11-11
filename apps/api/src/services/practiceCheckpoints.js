"use strict";

/** @typedef {{i: number, toleranceSec: number}} Checkpoint */

/** Up to three distinct positions in the target's chronologically sorted steps.
 * @param {unknown} raw @param {number} stepCount @returns {Checkpoint[] | null} */
function normalizeCheckpoints(raw, stepCount) {
  if (!Array.isArray(raw) || raw.length > 3) return null;
  /** @type {Checkpoint[]} */ const checkpoints = [];
  const seen = new Set();
  for (const entry of raw) {
    const i = entry?.i;
    const toleranceSec = entry?.toleranceSec;
    if (!Number.isInteger(i) || i < 0 || i >= stepCount || seen.has(i)
      || !Number.isInteger(toleranceSec) || toleranceSec < 1 || toleranceSec > 180) return null;
    seen.add(i);
    checkpoints.push({ i, toleranceSec });
  }
  return checkpoints.sort((a, b) => a.i - b.i);
}

/** @param {Checkpoint[]} checkpoints @param {Array<{name:string,driftSec:number|null}>} steps */
function gradeCheckpoints(checkpoints, steps) {
  return checkpoints.map((point) => {
    const { name, driftSec } = steps[point.i];
    return { ...point, name, hit: driftSec !== null && Math.abs(driftSec) <= point.toleranceSec };
  });
}

/** Count only games graded with the same checkpoint step and tolerance.
 * @param {Array<{i:number,toleranceSec:number,name:string}>} checkpoints
 * @param {Array<{practice:{checkpoints?:Array<{i:number,toleranceSec:number,hit:boolean}>}}>} games */
function checkpointStats(checkpoints, games) {
  return checkpoints.map((point) => {
    let attempts = 0;
    let hits = 0;
    for (const game of games) {
      const result = game.practice.checkpoints?.find((row) => row.i === point.i && row.toleranceSec === point.toleranceSec);
      if (!result) continue;
      attempts += 1;
      if (result.hit) hits += 1;
    }
    return { i: point.i, toleranceSec: point.toleranceSec, name: point.name, attempts, hits };
  });
}

module.exports = { normalizeCheckpoints, gradeCheckpoints, checkpointStats };
