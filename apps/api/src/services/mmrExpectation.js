"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");
const { RULES, BIN_COUNT, fitCalibration, validatedAnchors } = require("./mmrExpectationMath");

const COLLECTION_NAME = "mmr_expectation";
const DOCUMENT_ID = "corpus-1v1";
const RULE_VERSION = 1;
const CACHE_MS = 60_000;
const MAX_TIME_MS = 120_000;

/** Genuine replay-time ratings only. Numeric legacy/current Pulse fields
 * cannot establish the historical strength of an opponent.
 * @param {string} path */
function ratingExpression(path) {
  return { $and: [{ $isNumber: path }, { $gte: [path, 500] }, { $lte: [path, 9999] }, { $eq: [path, { $trunc: { $cond: [{ $isNumber: path }, path, 0] } }] }] };
}

/** Accept the same recognized race names/initials and case variants as the
 * analyzer, while keeping unknown strings and Computer out of the cohort.
 * @param {string} path */
function raceExpression(path) {
  return { $in: [{ $toLower: { $trim: { input: { $ifNull: [path, ""] } } } }, ["p", "protoss", "t", "terran", "z", "zerg", "r", "random"]] };
}

/** Both authoritative format and legacy player count are checked: an
 * explicit team format cannot become 1v1 through a stale count of two. */
function ladderExpression() {
  return { $and: [
    { $eq: ["$isLadderGame", true] },
    { $ne: ["$excluded", true] },
    { $ne: ["$isResumedFromReplay", true] },
    { $or: [{ $eq: ["$matchFormat", "1v1"] }, { $and: [{ $in: [{ $type: "$matchFormat" }, ["missing", "null"]] }, { $eq: ["$playerCount", 2] }] }] },
    { $or: [{ $in: [{ $type: "$playerCount" }, ["missing", "null"]] }, { $eq: ["$playerCount", 2] }] },
    raceExpression("$myRace"), raceExpression("$opponent.race"),
  ] };
}

function ratingsExpression() {
  return { $and: [{ $eq: ["$myMmrSource", "replay"] }, { $eq: ["$opponent.mmrSource", "replay"] }, ratingExpression("$myMmr"), ratingExpression("$opponent.mmr")] };
}

/** One time-bounded scan over SLIM rows. The only output is at most 48
 * counters; no identities, replay payloads, or detail-store reads.
 * @returns {import('mongodb').Document[]} */
function buildRecomputePipeline() {
  const outcome = { $toLower: { $ifNull: ["$result", ""] } };
  return [
    { $match: { $expr: { $and: [ladderExpression(), ratingsExpression(), { $in: [outcome, ["win", "loss", "victory", "defeat"]] }] } } },
    { $project: { _id: 0, diff: { $subtract: ["$opponent.mmr", "$myMmr"] }, win: { $cond: [{ $in: [outcome, ["win", "victory"]] }, 1, 0] } } },
    { $match: { diff: { $gte: RULES.minimumDelta, $lte: RULES.maximumDelta } } },
    { $group: { _id: { $min: [BIN_COUNT - 1, { $floor: { $divide: [{ $subtract: ["$diff", RULES.minimumDelta] }, RULES.binWidth] } }] }, n: { $sum: 1 }, wins: { $sum: "$win" } } },
    { $project: { _id: 0, bin: "$_id", n: 1, wins: 1 } },
    { $sort: { bin: 1 } },
  ];
}

class MmrExpectationService {
  /** @param {{games:import('mongodb').Collection,db:import('mongodb').Db}} db
   * @param {{now?:()=>number}} [opts] */
  constructor(db, opts = {}) {
    this.games = db.games;
    this.coll = db.db.collection(COLLECTION_NAME);
    this.now = opts.now || Date.now;
    /** @type {{expires:number,curve:import('./mmrExpectationMath').Calibration|null}|null} */
    this.cache = null;
    /** @type {Promise<import('./mmrExpectationMath').Calibration|null>|null} */
    this.loading = null;
  }

  /** Aggregate document only; a missing/unavailable calibration uses Elo.
   * No read ever launches a corpus rebuild. */
  async curve() {
    if (this.cache && this.cache.expires > this.now()) return this.cache.curve;
    if (this.loading) return this.loading;
    this.loading = this._loadCurve().finally(() => { this.loading = null; });
    return this.loading;
  }

  async _loadCurve() {
    let curve = null;
    try {
      const doc = /** @type {(import('./mmrExpectationMath').Calibration & {ruleVersion:number})|null} */ (/** @type {unknown} */ (await this.readRun()));
      if (doc?.ruleVersion === RULE_VERSION && validatedAnchors(doc)) curve = doc;
    } catch { /* Read failure preserves the documented deterministic Elo fallback. */ }
    this.cache = { expires: this.now() + CACHE_MS, curve };
    return curve;
  }

  async readRun() { return this.coll.findOne({ _id: /** @type {any} */ (DOCUMENT_ID) }); }

  /** Publish atomically after the scheduler verifies its lease. Failed or
   * lost-owner runs leave the previous complete curve intact.
   * @param {{beforePublish?:()=>Promise<void>}} [opts] */
  async recompute(opts = {}) {
    const rows = await this.games.aggregate(buildRecomputePipeline(), { maxTimeMS: MAX_TIME_MS }).toArray();
    const fitted = fitCalibration(rows);
    const updatedAt = new Date(this.now());
    const doc = { _id: DOCUMENT_ID, [VERSION_KEY]: 1, ruleVersion: RULE_VERSION, ...RULES, ...fitted, updatedAt };
    if (opts.beforePublish) await opts.beforePublish();
    await this.coll.replaceOne({ _id: /** @type {any} */ (DOCUMENT_ID) }, /** @type {any} */ (doc), { upsert: true });
    this.cache = { expires: this.now() + CACHE_MS, curve: fitted.method === "calibrated" ? fitted : null };
    return { updatedAt, sampleGames: fitted.sampleGames, supportedBins: fitted.supportedBins, method: fitted.method };
  }
}

module.exports = { MmrExpectationService, buildRecomputePipeline, ladderExpression, ratingsExpression, COLLECTION_NAME, DOCUMENT_ID, RULE_VERSION, MAX_TIME_MS };
