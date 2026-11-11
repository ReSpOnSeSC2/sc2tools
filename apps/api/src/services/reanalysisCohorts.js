"use strict";

const crypto = require("crypto");
const rawMilestones = require("../config/analysisMilestones.json");
const { INGEST_PROVENANCE } = require("../config/constants");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { parseStrictSemver, compareStrictSemver, STRICT_SEMVER_PATTERN, STRICT_SEMVER_MAX_LENGTH } = require("../util/strictSemver");

/**
 * Re-analysis cohorts: which of an owner's games have older analysis.
 *
 * The catalog (config/analysisMilestones.json) lists engine releases that
 * changed labels or added replay data. `date` is the day the change entered the analysis engine source;
 * the agent installer that shipped it may be later, and dates never decide
 * membership: only the reported engine version on each game does.
 *
 * Counts and job batches share one projection (`cohortProjection`) so a
 * cohort count and the games a job later sends always agree on the rules:
 *   - engine version: strict SemVer from a known uploader, else unknown;
 *   - matchup: exact P/T/Z codes from the spawned races, Random/unknown never
 *     enters a milestone;
 *   - macro: a finite 0..100 macroScore, anything else is missing.
 * Counts overlap (one game can sit in several cohorts); they are not a
 * partition of history.
 */

const MATCHUPS = Object.freeze(["PvT", "TvP", "PvZ", "ZvP", "TvZ", "ZvT", "PvP", "TvT", "ZvZ"]);
const MAX_MILESTONES = 20;
const SUMMARY_MAX = 200;
const MAX_GROUPS = 5000;
const MAX_JOB_VERSIONS = 500;
const COUNT_MAX_TIME_MS = 10_000;
const COHORT_MISSING_MACRO = "missing-macro";
const COHORT_NO_ENGINE = "no-engine-stamp";
const ENGINE_PREFIX = "engine-before:";
const NUMBER_TYPES = ["double", "int", "long", "decimal"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{id: string, engine: string, date: string, summary: string, matchups: readonly string[]}} Milestone
 * @typedef {{revision: string, milestones: readonly Milestone[]}} MilestoneCatalog
 */

/** @param {string} message */
function invalid(message) {
  return new Error(`analysis_milestones_invalid: ${message}`);
}

/**
 * Validate the static catalog once at boot. Invalid rows fail loudly instead
 * of silently producing an empty list.
 * @param {unknown} raw
 * @returns {MilestoneCatalog}
 */
function loadMilestoneCatalog(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MILESTONES) throw invalid("rows");
  const seen = new Set();
  const milestones = raw.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid(`row ${index}`);
    const keys = Object.keys(row).sort().join(",");
    if (keys !== "date,engine,matchups,summary") throw invalid(`keys ${index}`);
    const { engine, date, summary, matchups } = /** @type {Record<string, any>} */ (row);
    if (!parseStrictSemver(engine) || seen.has(engine)) throw invalid(`engine ${index}`);
    seen.add(engine);
    if (typeof date !== "string" || !DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw invalid(`date ${index}`);
    if (typeof summary !== "string" || !summary.trim() || summary.length > SUMMARY_MAX) throw invalid(`summary ${index}`);
    if (!Array.isArray(matchups) || matchups.length === 0 || new Set(matchups).size !== matchups.length
      || matchups.some((matchup) => !MATCHUPS.includes(matchup))) throw invalid(`matchups ${index}`);
    return Object.freeze({ id: `${ENGINE_PREFIX}${engine}`, engine, date, summary, matchups: Object.freeze([...matchups]) });
  });
  milestones.sort((a, b) => /** @type {number} */ (compareStrictSemver(a.engine, b.engine)));
  const revision = crypto.createHash("sha256").update(JSON.stringify(milestones)).digest("hex").slice(0, 16);
  return Object.freeze({ revision, milestones: Object.freeze(milestones) });
}

const MILESTONE_CATALOG = loadMilestoneCatalog(rawMilestones);

/** Games eligible for re-analysis: the owner's live rows, never resume markers. @param {string} userId */
function baseMatch(userId) {
  return { userId, ...LIVE_GAME_MATCH, isResumedFromReplay: { $ne: true } };
}

/**
 * Strict engine version from a known uploader, or removed (unknown). Nested
 * conditions because Mongo `$and` does not promise short-circuiting.
 */
const ENGINE_EXPR = { $cond: [
  { $in: ["$ingestSource", INGEST_PROVENANCE.SOURCES] },
  { $cond: [
    { $eq: [{ $type: "$engineVersion" }, "string"] },
    { $cond: [
      { $lte: [{ $strLenCP: "$engineVersion" }, STRICT_SEMVER_MAX_LENGTH] },
      { $cond: [{ $regexMatch: { input: "$engineVersion", regex: STRICT_SEMVER_PATTERN } }, "$engineVersion", "$$REMOVE"] },
      "$$REMOVE",
    ] },
    "$$REMOVE",
  ] },
  "$$REMOVE",
] };

/** @param {string} path */
function raceCode(path) {
  return { $let: {
    vars: { race: { $cond: [{ $eq: [{ $type: path }, "string"] }, { $toLower: path }, null] } },
    in: { $switch: {
      branches: [
        { case: { $in: ["$$race", ["p", "protoss"]] }, then: "P" },
        { case: { $in: ["$$race", ["t", "terran"]] }, then: "T" },
        { case: { $in: ["$$race", ["z", "zerg"]] }, then: "Z" },
      ],
      default: null,
    } },
  } };
}

const MATCHUP_EXPR = { $let: {
  vars: { mine: raceCode("$myRace"), theirs: raceCode("$opponent.race") },
  in: { $cond: [
    { $and: [{ $ne: ["$$mine", null] }, { $ne: ["$$theirs", null] }] },
    { $concat: ["$$mine", "v", "$$theirs"] },
    null,
  ] },
} };

const MACRO_EXPR = { $cond: [
  { $in: [{ $type: "$macroScore" }, NUMBER_TYPES] },
  { $cond: [{ $gte: ["$macroScore", 0] }, { $lte: ["$macroScore", 100] }, false] },
  false,
] };

/** The single shared classification stage for counts and job batches. */
const cohortProjection = Object.freeze({ v: ENGINE_EXPR, m: MATCHUP_EXPR, macro: MACRO_EXPR });

/**
 * @typedef {{id: string, kind: "engine"|"macro"|"engine-unknown", count: number, unknown?: number,
 *   engine?: string, date?: string, summary?: string, matchups?: string[], versions?: string[]}} Cohort
 */

/**
 * One bounded indexed pass over the owner's history, grouped by
 * (version, matchup, macro) — a few dozen rows, never game ids.
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {MilestoneCatalog} [catalog]
 * @returns {Promise<{catalogRevision: string, cohorts: Cohort[]}>}
 */
async function countCohorts(games, userId, catalog = MILESTONE_CATALOG) {
  const groups = await games.aggregate([
    { $match: baseMatch(userId) },
    { $project: { _id: 0, ...cohortProjection } },
    { $group: { _id: { v: "$v", m: "$m", macro: "$macro" }, n: { $sum: 1 } } },
    { $limit: MAX_GROUPS + 1 },
  ], { maxTimeMS: COUNT_MAX_TIME_MS }).toArray();
  if (groups.length > MAX_GROUPS) throw Object.assign(new Error("reanalysis_counts_unavailable"), { status: 503, code: "reanalysis_counts_unavailable" });
  const engine = catalog.milestones.map((milestone) => ({
    milestone, target: /** @type {import('../util/strictSemver').StrictSemver} */ (parseStrictSemver(milestone.engine)),
    count: 0, unknown: 0, versions: /** @type {Set<string>} */ (new Set()),
  }));
  let missingMacro = 0;
  let noEngine = 0;
  for (const group of groups) {
    const { v, m, macro } = group._id || {};
    const n = Number(group.n) || 0;
    const parsed = typeof v === "string" ? parseStrictSemver(v) : null;
    if (!parsed) noEngine += n;
    if (macro !== true) missingMacro += n;
    for (const bucket of engine) {
      if (!bucket.milestone.matchups.includes(m)) continue;
      if (!parsed) bucket.unknown += n;
      else if (compareStrictSemver(parsed, bucket.target) === -1) {
        bucket.count += n;
        bucket.versions.add(/** @type {string} */ (v));
      }
    }
  }
  /** @type {Cohort[]} */
  const cohorts = engine.map(({ milestone, count, unknown, versions }) => ({
    id: milestone.id, kind: "engine", engine: milestone.engine, date: milestone.date,
    summary: milestone.summary, matchups: [...milestone.matchups], count, unknown,
    versions: [...versions].sort(),
  }));
  cohorts.push({ id: COHORT_MISSING_MACRO, kind: "macro", count: missingMacro });
  cohorts.push({ id: COHORT_NO_ENGINE, kind: "engine-unknown", count: noEngine });
  return { catalogRevision: catalog.revision, cohorts };
}

/**
 * The `$match` a job applies after `cohortProjection`. Engine cohorts use the
 * older versions observed when the job started (bounded, stored on the job).
 * @param {{cohortId: string, matchups?: string[], versions?: string[]}} job
 */
function cohortMatch(job) {
  if (job.cohortId === COHORT_MISSING_MACRO) return { macro: false };
  if (job.cohortId === COHORT_NO_ENGINE) return { v: null };
  return { m: { $in: job.matchups || [] }, v: { $in: job.versions || [] } };
}

/**
 * Next page of at most `limit` games for a job, in gameId order after the
 * stored cursor (the unique {userId, gameId} index serves the range).
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {{cohortId: string, matchups?: string[], versions?: string[], cursor?: string|null}} job
 * @param {number} limit
 * @returns {Promise<Array<{gameId: string, original: {sizeBytes: number, sha256: string}|null}>>}
 */
async function selectCohortPage(games, userId, job, limit) {
  const match = baseMatch(userId);
  /** @type {Record<string, any>} */
  const range = typeof job.cursor === "string" ? { gameId: { $gt: job.cursor } } : {};
  const rows = await games.aggregate([
    { $match: { ...match, ...range } },
    { $sort: { gameId: 1 } },
    { $project: { _id: 0, gameId: 1, replayFile: 1, ...cohortProjection } },
    { $match: cohortMatch(job) },
    { $limit: limit },
    { $project: { gameId: 1, "replayFile.storedAt": 1, "replayFile.sizeBytes": 1, "replayFile.sha256": 1 } },
  ], { maxTimeMS: COUNT_MAX_TIME_MS }).toArray();
  return rows
    .filter((row) => typeof row.gameId === "string" && row.gameId.length > 0 && row.gameId.length <= 200)
    .map((row) => ({ gameId: row.gameId, original: archivedOriginal(row.replayFile) }));
}

/** @param {any} marker */
function archivedOriginal(marker) {
  if (!marker || !marker.storedAt) return null;
  const sizeBytes = Number(marker.sizeBytes);
  const sha256 = typeof marker.sha256 === "string" ? marker.sha256.toLowerCase() : "";
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 4 || sizeBytes > 5 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { sizeBytes, sha256 };
}

/** @param {unknown} id @param {MilestoneCatalog} [catalog] */
function isKnownCohort(id, catalog = MILESTONE_CATALOG) {
  return id === COHORT_MISSING_MACRO || id === COHORT_NO_ENGINE
    || (typeof id === "string" && catalog.milestones.some((milestone) => milestone.id === id));
}

module.exports = {
  MILESTONE_CATALOG,
  MAX_JOB_VERSIONS,
  COHORT_MISSING_MACRO,
  COHORT_NO_ENGINE,
  cohortProjection,
  loadMilestoneCatalog,
  countCohorts,
  selectCohortPage,
  isKnownCohort,
  baseMatch,
};
