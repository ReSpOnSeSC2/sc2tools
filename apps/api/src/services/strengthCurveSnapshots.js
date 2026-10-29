"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { isProxy } = require("node:util").types;
const { RULES, validatedAnchors } = require("./mmrExpectationMath");
const MAX_SNAPSHOT_BYTES = 4096;

/** @typedef {{keyPart:string,expiresAt:number,isCurrent:()=>boolean}} CurveDependency */
/** @typedef {{curve:import('./mmrExpectationMath').Calibration|null,expires:number,origin:object,id:object}} CurveMemo */
/** @typedef {{curve:import('./mmrExpectationMath').Calibration|null,dependency:CurveDependency|null}} CurveSnapshot */

/** Retention authority only. Baseline memo values and query policy stay intact. */
class StrengthCurveSnapshots {
  /** @param {()=>CurveMemo|null} selected @param {()=>number} now */
  constructor(selected, now) {
    this.selected = selected; this.now = now; this.epoch = {};
    /** @type {WeakMap<CurveMemo,CurveSnapshot>} */ this.snapshots = new WeakMap();
  }
  origin() { return this.epoch; }
  retire() { this.epoch = {}; }
  /** @param {import('./mmrExpectationMath').Calibration|null} curve @param {number} expires @param {object} origin @returns {CurveMemo} */
  memo(curve, expires, origin) { return { curve, expires, origin, id: {} }; }
  /** @param {object} id @param {object} origin @param {number} expires */
  current(id, origin, expires) {
    try { const now = this.now(); return Number.isFinite(now) && origin === this.epoch && id === this.selected()?.id && Number.isFinite(expires) && expires > now; }
    catch { return false; }
  }
  /** The returned proof retains only bounded effective fields, never the old raw document.
   * @param {CurveMemo} memo @returns {CurveSnapshot} */
  capture(memo) {
    const old = this.snapshots.get(memo);
    if (old) return old.dependency?.isCurrent() ? old : { curve: memo.curve, dependency: null };
    const effective = effectiveCurve(memo.curve);
    if (!effective || !this.current(memo.id, memo.origin, memo.expires)) return { curve: memo.curve, dependency: null };
    const snapshot = Object.freeze({ curve: effective.curve,
      dependency: dependency(this, memo.id, memo.origin, memo.expires, effective.encoded) });
    this.snapshots.set(memo, snapshot); return snapshot;
  }
}

/** This scope cannot retain the historical raw memo/document.
 * @param {StrengthCurveSnapshots} owner @param {object} id @param {object} origin @param {number} expiresAt @param {string} encoded */
function dependency(owner, id, origin, expiresAt, encoded) {
  const digest = createHash("sha256").update(encoded).digest("hex");
  return Object.freeze({ keyPart: `strength1:${randomUUID()}:${digest}`, expiresAt,
    isCurrent: () => owner.current(id, origin, expiresAt) });
}

/** @param {object} value @param {string} key */
function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("strength_curve_accessor");
  if (!descriptor && key in value) throw new Error("strength_curve_inherited");
  return descriptor?.value;
}

/** @param {unknown} value */
function plain(value) { return value !== null && typeof value === "object" && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype; }

/** @param {object} raw */
function evidence(raw) {
  const sampleGames = dataValue(raw, "sampleGames") || 0, supportedBins = dataValue(raw, "supportedBins") || 0;
  if (!Number.isSafeInteger(sampleGames) || sampleGames < 0 || !Number.isSafeInteger(supportedBins) || supportedBins < 0 || supportedBins > 48) return null;
  return { sampleGames, supportedBins };
}

/** @param {object} raw */
function copyAnchors(raw) {
  const source = dataValue(raw, "anchors");
  if (!Array.isArray(source) || isProxy(source) || source.length > 48) return null;
  const anchors = [];
  for (let i = 0; i < source.length; i++) {
    const row = dataValue(source, String(i));
    if (!plain(row)) return null;
    anchors.push(Object.freeze({ diff: dataValue(row, "diff"), probability: dataValue(row, "probability") }));
  }
  Object.freeze(anchors); return anchors;
}

/** Copy exactly the fields used by the pipeline, inverse lookup and public metadata.
 * Unsupported legacy metadata keeps its baseline response without retention.
 * @param {import('./mmrExpectationMath').Calibration|null} raw */
function effectiveCurve(raw) {
  try {
    /** @type {import('./mmrExpectationMath').Calibration|null} */ let curve = null;
    if (raw !== null) {
      if (!plain(raw)) return null;
      const anchors = copyAnchors(raw); if (!anchors) return null;
      const counts = evidence(raw); if (!counts) return null;
      curve = { anchors, ...counts, method: "calibrated" };
      if (!validatedAnchors(curve)) return null;
      Object.freeze(curve);
    }
    const encoded = JSON.stringify(["strength1", RULES, curve]);
    return Buffer.byteLength(encoded) <= MAX_SNAPSHOT_BYTES ? { curve, encoded } : null;
  } catch { return null; }
}

module.exports = { StrengthCurveSnapshots, MAX_SNAPSHOT_BYTES };
