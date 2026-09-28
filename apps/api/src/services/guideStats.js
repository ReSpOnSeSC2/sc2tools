"use strict";

/**
 * guide_stats — the nightly cross-user aggregate behind the public SC2
 * Tools build guides (served by services/guides.js + routes/guides.js).
 *
 * One ``recompute()`` rebuilds every doc (see services/guideStatsDocs.js
 * for the kinds) from two sources, per matchup and sequentially so the
 * run never stacks concurrent scans on the shared cluster:
 *   - slim ``games`` rows (win rates, bands, maps, strategies, lengths,
 *     macro, leaks) — services/guideStatsPipelines.js;
 *   - pseudonymous ``guide_samples`` rows (milestone timings, army).
 * All grouping, user counting, per-user capping and quantiles run inside
 * Mongo; Node only shapes small floor-clearing rows. Docs are replaced by
 * ``key``; anything not rewritten this run is deleted afterwards, and a
 * single ``kind: "run"`` doc records the run for the admin page and the
 * job's freshness check.
 *
 * Week over week: build docs carry a ``baseline`` snapshot at least
 * GUIDE_BASELINE_MIN_AGE_MS old plus the ``baselineCandidate`` that will
 * replace it (services/guideStatsShape.js ``nextBaselines``), so reruns
 * inside the week — deploys, "Recompute now" — do not reset the trend
 * the way a per-run "previous" copy would.
 *
 * ``recompute()`` is single-flight per process (concurrent callers share
 * the in-flight run; one extra rerun is queued). Cross-replica exclusion
 * is the job's ``jobLocks`` lease (jobs/guideStatsRecomputeJob.js).
 */

const { COLLECTIONS } = require("../config/constants");
const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { MATCHUPS } = require("../config/guideSlugs");
const { stampVersion } = require("../db/schemaVersioning");
const {
  GUIDE_GAMES_INDEX_NAME,
  GUIDE_SAMPLES_INDEX_NAME,
  guideAggregateOptions,
  buildGamesPipeline,
} = require("./guideStatsPipelines");
const {
  buildSampleTotalsPipeline,
  buildSampleMilestonesPipeline,
  buildSampleArmyPipeline,
} = require("./guideStatsSamplePipelines");
const {
  canonicalMapNames,
  shapeBuildDocs,
  shapeCounterDocs,
  shapeMatchupDoc,
  shapeMapDocs,
} = require("./guideStatsDocs");
const { loadSharingUsers, examplesForMatchup } = require("./guideStatsExamples");

const RUN_KEY = "run";
const KIND_RUN = "run";
/** Replacements per bulkWrite round trip. */
const WRITE_CHUNK = 500;
const PRIOR_PROJECTION = Object.freeze({
  _id: 0, key: 1, published: 1, baseline: 1, baselineCandidate: 1, firstPublishedAt: 1,
});

/** @typedef {import('./guideStatsDocs').GuideStatsDoc} GuideStatsDoc */
/** @typedef {import('./guideStatsDocs').MatchupResult} MatchupResult */

/**
 * @typedef {object} GuideStatsRunCounts
 * @property {number} builds    current-era build docs with a floor-clearing overall cell
 * @property {number} published current-era published build pages
 * @property {number} counters  current-era published counter pages
 * @property {number} maps      current-era published map pages
 */

/**
 * @typedef {object} GuideStatsRun
 * @property {Date} computedAt
 * @property {number} durationMs
 * @property {GuideStatsRunCounts} counts
 */

/**
 * @typedef {object} RecomputeOptions
 * @property {() => Promise<void>} [onProgress] awaited after each matchup's
 *   aggregations (the job extends its lock lease here; a throw aborts the
 *   run before anything is written)
 */

/**
 * @param {GuideStatsDoc[]} docs
 * @returns {GuideStatsRunCounts}
 */
function runCounts(docs) {
  const current = docs.filter((doc) => doc.era === GUIDE_CURRENT_ERA);
  const count = (/** @type {string} */ kind, /** @type {(d: GuideStatsDoc) => boolean} */ pred) =>
    current.filter((doc) => doc.kind === kind && pred(doc)).length;
  return {
    builds: count("build", (doc) => Boolean(doc.overall)),
    published: count("build", (doc) => doc.published === true),
    counters: count("counter", (doc) => doc.published === true),
    maps: count("map", (doc) => doc.published === true),
  };
}

/**
 * Replace every doc by key (upsert), in chunks.
 *
 * @param {import('mongodb').Collection} coll
 * @param {GuideStatsDoc[]} docs
 */
async function writeDocs(coll, docs) {
  for (let i = 0; i < docs.length; i += WRITE_CHUNK) {
    const ops = docs.slice(i, i + WRITE_CHUNK).map((doc) => ({
      replaceOne: {
        filter: { key: doc.key },
        replacement: stampVersion({ ...doc }, COLLECTIONS.GUIDE_STATS),
        upsert: true,
      },
    }));
    await coll.bulkWrite(ops, { ordered: false });
  }
}

class GuideStatsService {
  /**
   * @param {import('../db/connect').DbContext} db uses ``games``, ``guideSamples``, ``guideStats``, ``users``
   * @param {{ logger?: import('pino').Logger | null, now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.coll = db.guideStats;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
    /** @type {Promise<GuideStatsRun>|null} */
    this.recomputeInFlight = null;
    this.recomputeQueued = false;
    this.lastComputedMs = 0;
  }

  /**
   * Rebuild every guide_stats doc. Concurrent calls coalesce onto the
   * in-flight run (plus at most one queued rerun).
   *
   * Example: `const { counts } = await guideStats.recompute();`
   *
   * @param {RecomputeOptions} [opts]
   * @returns {Promise<GuideStatsRun>}
   */
  async recompute(opts = {}) {
    if (this.recomputeInFlight) {
      this.recomputeQueued = true;
      return this.recomputeInFlight;
    }
    this.recomputeInFlight = (async () => {
      /** @type {GuideStatsRun} */
      let result;
      do {
        this.recomputeQueued = false;
        result = await this._recomputeOnce(opts);
      } while (this.recomputeQueued);
      return result;
    })();
    try {
      return await this.recomputeInFlight;
    } finally {
      this.recomputeInFlight = null;
    }
  }

  /**
   * The last completed run, or null before the first one.
   *
   * Example: `(await guideStats.readRun())?.computedAt`.
   *
   * @returns {Promise<GuideStatsRun|null>}
   */
  async readRun() {
    const doc = await this.coll.findOne(
      { kind: KIND_RUN, key: RUN_KEY },
      { projection: { _id: 0, computedAt: 1, durationMs: 1, counts: 1 } },
    );
    if (!doc || !(doc.computedAt instanceof Date)) return null;
    return { computedAt: doc.computedAt, durationMs: doc.durationMs, counts: doc.counts };
  }

  /**
   * @param {RecomputeOptions} opts
   * @returns {Promise<GuideStatsRun>}
   */
  async _recomputeOnce(opts) {
    const startedMs = this.now();
    const computedAt = await this._nextStamp(startedMs);
    const priors = await this._readPriors();
    /** @type {MatchupResult[]} */
    const results = [];
    for (const matchup of MATCHUPS) {
      results.push(await this._aggregateMatchup(matchup));
      if (opts.onProgress) await opts.onProgress();
    }
    const docs = await this._shapeDocs(results, priors, computedAt);
    await writeDocs(this.coll, docs);
    await this.coll.deleteMany({ computedAt: { $lt: computedAt }, kind: { $ne: KIND_RUN } });
    /** @type {GuideStatsRun} */
    const run = { computedAt, durationMs: Math.max(0, this.now() - startedMs), counts: runCounts(docs) };
    await this.coll.replaceOne(
      { key: RUN_KEY },
      stampVersion({ kind: KIND_RUN, key: RUN_KEY, ...run }, COLLECTIONS.GUIDE_STATS),
      { upsert: true },
    );
    if (this.logger) {
      this.logger.info({ durationMs: run.durationMs, counts: run.counts, docs: docs.length }, "guide_stats_recomputed");
    }
    return run;
  }

  /**
   * Strictly increasing run stamp (also across restarts, via the run doc),
   * so the stale sweep ``computedAt < this run`` can never hit a doc this
   * run wrote.
   *
   * @param {number} nowMs
   * @returns {Promise<Date>}
   */
  async _nextStamp(nowMs) {
    const last = await this.readRun();
    const floor = Math.max(this.lastComputedMs, last ? last.computedAt.getTime() : 0) + 1;
    this.lastComputedMs = Math.max(nowMs, floor);
    return new Date(this.lastComputedMs);
  }

  /** @returns {Promise<Map<string, Record<string, any>>>} previous build docs by key */
  async _readPriors() {
    const rows = await this.coll.find({ kind: "build" }, { projection: PRIOR_PROJECTION }).toArray();
    return new Map(rows.map((row) => [row.key, row]));
  }

  /**
   * All aggregations of one matchup, one after another.
   *
   * @param {string} matchup
   * @returns {Promise<MatchupResult>}
   */
  async _aggregateMatchup(matchup) {
    const gamesOptions = guideAggregateOptions(GUIDE_GAMES_INDEX_NAME);
    const samplesOptions = guideAggregateOptions(GUIDE_SAMPLES_INDEX_NAME);
    const [facet] = await this.db.games.aggregate(buildGamesPipeline(matchup), gamesOptions).toArray();
    const samples = this.db.guideSamples;
    const [totals] = await samples.aggregate(buildSampleTotalsPipeline(matchup), samplesOptions).toArray();
    const milestones = await samples.aggregate(buildSampleMilestonesPipeline(matchup), samplesOptions).toArray();
    const army = await samples.aggregate(buildSampleArmyPipeline(matchup), samplesOptions).toArray();
    return {
      matchup,
      facet: facet || {},
      sampleBuilds: (totals && totals.builds) || [],
      sampleCheckpoints: (totals && totals.checkpoints) || [],
      milestones,
      army,
    };
  }

  /**
   * @param {MatchupResult[]} results
   * @param {Map<string, Record<string, any>>} priors
   * @param {Date} computedAt
   * @returns {Promise<GuideStatsDoc[]>}
   */
  async _shapeDocs(results, priors, computedAt) {
    const canonicalMaps = canonicalMapNames(results);
    const context = { computedAt, priors, canonicalMaps };
    /** @type {GuideStatsDoc[]} */
    const docs = [];
    /** @type {GuideStatsDoc[]} */
    const allBuilds = [];
    for (const result of results) {
      const builds = shapeBuildDocs(result, context);
      const counters = shapeCounterDocs(result, computedAt);
      allBuilds.push(...builds);
      docs.push(...builds, ...counters);
      for (const era of new Set(builds.map((doc) => doc.era))) {
        docs.push(shapeMatchupDoc(result, era, {
          builds: builds.filter((doc) => doc.era === era),
          counters: counters.filter((doc) => doc.era === era),
          computedAt,
        }));
      }
    }
    await this._attachExamples(allBuilds);
    docs.push(...shapeMapDocs(results, canonicalMaps, computedAt));
    return docs;
  }

  /**
   * Example replays for published current-era build docs (mutates them).
   *
   * @param {GuideStatsDoc[]} buildDocs
   */
  async _attachExamples(buildDocs) {
    const published = buildDocs.filter((doc) => doc.published && doc.era === GUIDE_CURRENT_ERA);
    if (published.length === 0) return;
    const profiles = await loadSharingUsers(this.db.users);
    if (profiles.size === 0) return;
    for (const matchup of new Set(published.map((doc) => doc.matchup))) {
      const docs = published.filter((doc) => doc.matchup === matchup);
      const examples = await examplesForMatchup(this.db.games, matchup, docs.map((doc) => doc.buildKey), profiles);
      for (const doc of docs) doc.examples = examples.get(doc.buildKey) || [];
    }
  }
}

module.exports = { GuideStatsService, RUN_KEY };
