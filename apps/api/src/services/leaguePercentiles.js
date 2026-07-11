"use strict";

const { VERSION_KEY } = require("../db/schemaVersioning");

/**
 * League percentile benchmarks — corpus-wide, per-(league, matchup)
 * decile tables that let the SPA frame a player's per-game numbers as
 * "your macro score is 38th percentile for Diamond PvZ" instead of a
 * bare value.
 *
 * Data source — SLIM ``games`` rows only. Every benchmarked metric is
 * stamped onto the slim row at ingest (see services/games.js — heavy
 * fields are peeled into ``game_details``/R2 and are NOT queryable
 * here): ``macroScore``, ``apm``, ``spq``, ``durationSec``, ``myMmr``.
 * The nightly recompute therefore never touches the detail store.
 *
 * League banding — games rows carry NO "my league" field (verified
 * against validation/gameRecord.js and the ingest path in
 * routes/games.js); the only league signal on a slim row is
 * ``opponent.leagueId`` (SC2 league enum, stamped by the agent for
 * ladder games). We band by ``opponent.leagueId``: SC2 matchmaking
 * pairs near-equal ratings, so the opponent's league is a faithful
 * proxy for the bracket the game was played in.
 *
 * Matchup — derived from ``myRace`` + ``opponent.race`` first letters
 * ("Protoss" vs "Zerg" → "PvZ"). Games with a non-P/T/Z race on either
 * side (unresolved / AI / corrupted rows) and team games
 * (``playerCount`` present and != 2) are excluded.
 *
 * Percentile computation — ONE aggregation pipeline using the
 * ``$percentile`` $group accumulator (MongoDB 7.0+, method
 * "approximate"). mongodb-memory-server 10 pins mongod 7.0.14, and the
 * production cluster is newer, so the pipeline path is used
 * unconditionally — verified by __tests__/leaguePercentiles.test.js
 * running the real accumulator. The JS fallback the design allowed for
 * (projected cursor + in-process decile sort, hard 100 000-games-per-
 * band sample cap) was therefore not needed; the t-digest accumulator
 * is memory-bounded on the server regardless of band size.
 *
 * Privacy — output rows are aggregates only: no ``userId`` (or any
 * other per-user identifier) is ever projected into the pipeline
 * output or the ``league_percentiles`` collection. On top of that,
 * ``lookup`` refuses to serve a band with fewer than ``MIN_SAMPLE``
 * games (k-anonymity-style floor), and ``percentileOf`` applies the
 * same floor per metric.
 *
 * Schema versioning — rows carry the standard ``_schemaVersion`` key
 * (reusing schemaVersioning's VERSION_KEY). ``league_percentiles``
 * is not yet registered in config/constants COLLECTIONS / the
 * schemaVersioning REGISTRY (that registration is part of the later
 * wiring change, alongside app.js construction); until then the
 * version is stamped literally here so existing rows are already
 * correctly marked when the registry entry lands.
 */

/** Output collection. Accessed via ``db.db.collection(...)`` because it
 *  is not (yet) part of the DbContext handle set in db/connect.js. */
const COLLECTION_NAME = "league_percentiles";

/** k-anonymity-style floor: bands (and per-metric samples) below this
 *  count are never served. */
const MIN_SAMPLE = 50;

/** ``_schemaVersion`` stamped on every output row. */
const SCHEMA_VERSION = 1;

/** Decile probabilities, p10..p90. ``deciles[k]`` is p(10*(k+1)). */
const DECILE_PS = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);

/** Slim-row numeric metrics we benchmark. All live on the ``games``
 *  row itself — never on the ``game_details`` blob. */
const METRICS = Object.freeze([
  "macroScore",
  "apm",
  "spq",
  "durationSec",
  "myMmr",
]);

/** Race initials accepted on either side of the matchup. */
const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

/** SC2 league enum → display label. Ids outside the ladder enum fall
 *  back to a generic "League N" label rather than being dropped. */
const LEAGUE_NAMES = Object.freeze({
  0: "Bronze",
  1: "Silver",
  2: "Gold",
  3: "Platinum",
  4: "Diamond",
  5: "Master",
  6: "Grandmaster",
});

/**
 * @typedef {{ n: number, deciles: number[] | null }} MetricTable
 *
 * @typedef {{
 *   leagueId: number,
 *   league: string,
 *   matchup: string,
 *   n: number,
 *   metrics: Record<string, MetricTable>,
 *   updatedAt: Date,
 * }} PercentileRow
 */

class LeaguePercentilesService {
  /**
   * @param {{ games: import('mongodb').Collection, db: import('mongodb').Db }} db
   *        DbContext from db/connect.js (only ``games`` and the raw
   *        ``db`` handle are used).
   * @param {{
   *   logger?: { info: (obj: Record<string, unknown>, msg: string) => void } | null,
   *   now?: () => number,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.games = db.games;
    this.coll = db.db.collection(COLLECTION_NAME);
    this.logger = opts.logger || null;
    this.now = opts.now || (() => Date.now());
  }

  /**
   * Full rebuild of the benchmark tables. One aggregation over the
   * whole ``games`` corpus grouped by (leagueBand, matchup), computing
   * per-metric decile vectors with the $percentile accumulator, then
   * upserted into ``league_percentiles`` keyed on (leagueId, matchup).
   * Bands that no longer exist in the corpus are removed, so repeated
   * runs are idempotent.
   *
   * @returns {Promise<{ bands: number, updatedAt: Date }>}
   */
  async recompute() {
    const updatedAt = new Date(this.now());
    // Idempotent — Mongo skips indexes that already exist. Keyed the
    // same way ``lookup`` queries.
    await this.coll.createIndex({ leagueId: 1, matchup: 1 }, { unique: true });

    const rows = /** @type {any[]} */ (
      await this.games
        .aggregate(buildRecomputePipeline(), { allowDiskUse: true })
        .toArray()
    );
    const docs = rows.map((row) => shapeBandRow(row, updatedAt));

    if (docs.length > 0) {
      await this.coll.bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: { leagueId: doc.leagueId, matchup: doc.matchup },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    // Every fresh row carries the same ``updatedAt`` stamp, so anything
    // older is a band the corpus no longer produces — drop it.
    await this.coll.deleteMany({ updatedAt: { $lt: updatedAt } });

    if (this.logger) {
      this.logger.info(
        { bands: docs.length, collection: COLLECTION_NAME },
        "league_percentiles_recomputed",
      );
    }
    return { bands: docs.length, updatedAt };
  }

  /**
   * Fetch one benchmark row. Returns ``null`` when the band is unknown
   * OR its sample is below the ``MIN_SAMPLE`` k-anonymity floor — the
   * caller can't tell the difference, by design.
   *
   * @param {{ leagueId: number, matchup: string }} args
   *        ``matchup`` is case-insensitive ("pvz" and "PvZ" both work).
   * @returns {Promise<PercentileRow | null>}
   */
  async lookup({ leagueId, matchup }) {
    if (typeof leagueId !== "number" || !Number.isFinite(leagueId)) {
      return null;
    }
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;
    const row = /** @type {any} */ (
      await this.coll.findOne(
        { leagueId, matchup: mu },
        { projection: { _id: 0 } },
      )
    );
    if (!row || typeof row.n !== "number" || row.n < MIN_SAMPLE) return null;
    return /** @type {PercentileRow} */ (row);
  }

  /**
   * Static-ish helper (kept on the instance for the service contract;
   * also exported as a module function): place ``value`` on a band's
   * decile ladder for ``metric``.
   *
   * @param {PercentileRow | null | undefined} table row from lookup()
   * @param {string} metric one of METRICS
   * @param {number} value the player's per-game value
   * @returns {number | null} integer percentile 1–99, or null when the
   *          metric is missing / below the MIN_SAMPLE floor
   */
  percentileOf(table, metric, value) {
    return percentileOf(table, metric, value);
  }
}

// ---------------- pipeline ----------------

/**
 * The single recompute aggregation:
 *   1. keep rows that carry a numeric ``opponent.leagueId`` (the only
 *      league signal on slim games rows) and string races, and are not
 *      team games;
 *   2. derive the matchup letters;
 *   3. $group per (leagueId, matchup) with a $percentile accumulator +
 *      numeric-sample counter per metric. $percentile ignores
 *      non-numeric input, so rows missing e.g. ``spq`` simply don't
 *      contribute to that metric's table.
 *
 * @returns {Array<Record<string, any>>}
 */
function buildRecomputePipeline() {
  /** @type {Record<string, any>} */
  const group = {
    _id: {
      leagueId: "$opponent.leagueId",
      matchup: { $concat: ["$_my", "v", "$_opp"] },
    },
    n: { $sum: 1 },
  };
  for (const metric of METRICS) {
    const path = `$${metric}`;
    group[`${metric}_n`] = {
      $sum: { $cond: [{ $isNumber: path }, 1, 0] },
    };
    group[`${metric}_deciles`] = {
      $percentile: { input: path, p: [...DECILE_PS], method: "approximate" },
    };
  }
  return [
    {
      $match: {
        "opponent.leagueId": { $type: "number" },
        myRace: { $type: "string" },
        "opponent.race": { $type: "string" },
        // 1v1 only. ``playerCount`` is optional (older agents), so a
        // missing count is trusted — the opponent.leagueId requirement
        // above already filters most non-ladder rows.
        $or: [{ playerCount: { $exists: false } }, { playerCount: 2 }],
      },
    },
    {
      $addFields: {
        _my: { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
        _opp: { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
      },
    },
    {
      $match: {
        _my: { $in: [...RACE_LETTERS] },
        _opp: { $in: [...RACE_LETTERS] },
      },
    },
    { $group: group },
  ];
}

/**
 * Shape one $group row into the stored band document. Aggregates only —
 * no per-user field exists at this point in the pipeline, so nothing
 * user-identifying can leak into the output collection.
 *
 * @param {any} row raw $group output
 * @param {Date} updatedAt shared recompute stamp
 * @returns {Record<string, any>}
 */
function shapeBandRow(row, updatedAt) {
  const leagueId = /** @type {number} */ (row._id.leagueId);
  /** @type {Record<string, MetricTable>} */
  const metrics = {};
  for (const metric of METRICS) {
    const n = typeof row[`${metric}_n`] === "number" ? row[`${metric}_n`] : 0;
    metrics[metric] = {
      n,
      deciles: n > 0 ? sanitizeDeciles(row[`${metric}_deciles`]) : null,
    };
  }
  return {
    leagueId,
    league: leagueLabel(leagueId),
    matchup: String(row._id.matchup),
    n: typeof row.n === "number" ? row.n : 0,
    metrics,
    updatedAt,
    [VERSION_KEY]: SCHEMA_VERSION,
  };
}

/**
 * Validate + round a raw $percentile result. Returns null unless it is
 * a full-length vector of finite numbers; enforces monotonicity (the
 * approximate t-digest can jitter adjacent quantiles on tiny samples).
 *
 * @param {unknown} raw
 * @returns {number[] | null}
 */
function sanitizeDeciles(raw) {
  if (!Array.isArray(raw) || raw.length !== DECILE_PS.length) return null;
  /** @type {number[]} */
  const out = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(Math.round(v * 100) / 100);
  }
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] < out[i - 1]) out[i] = out[i - 1];
  }
  return out;
}

/** @param {number} leagueId */
function leagueLabel(leagueId) {
  const name = /** @type {Record<number, string>} */ (LEAGUE_NAMES)[leagueId];
  return name || `League ${leagueId}`;
}

/**
 * Canonicalize a matchup string: "pvz" / "P v Z" / "PvZ" → "PvZ".
 * Returns null for anything that isn't two P/T/Z letters around a v.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  if (!m) return null;
  return `${m[1].toUpperCase()}v${m[2].toUpperCase()}`;
}

/**
 * Integer percentile (1–99) of ``value`` on a band's decile ladder for
 * ``metric``, by linear interpolation between adjacent deciles.
 *
 * Edges: below p10 extrapolates along the p10→p20 slope but is clamped
 * into 1..10; above p90 extrapolates along the p80→p90 slope clamped
 * into 90..99 — so an extreme value still reads as "bottom/top decile"
 * without pretending we know the exact tail shape.
 *
 * Returns null when the metric's sample is below MIN_SAMPLE (same
 * k-anonymity floor as ``lookup``) or the table/value is unusable.
 *
 * @param {PercentileRow | null | undefined} table
 * @param {string} metric
 * @param {number} value
 * @returns {number | null}
 */
function percentileOf(table, metric, value) {
  if (!table || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const m = table.metrics ? table.metrics[metric] : undefined;
  if (!m || typeof m.n !== "number" || m.n < MIN_SAMPLE) return null;
  const d = m.deciles;
  if (!Array.isArray(d) || d.length !== DECILE_PS.length) return null;

  let pct;
  if (value <= d[0]) {
    const width = d[1] - d[0];
    pct = width > 0 ? 10 - (10 * (d[0] - value)) / width : 10;
  } else if (value >= d[8]) {
    const width = d[8] - d[7];
    pct = width > 0 ? 90 + (10 * (value - d[8])) / width : 90;
  } else {
    let i = 0;
    while (i < 7 && value > d[i + 1]) i += 1;
    const width = d[i + 1] - d[i];
    pct =
      width > 0
        ? 10 * (i + 1) + (10 * (value - d[i])) / width
        : 10 * (i + 1) + 5; // flat segment: split the difference
  }
  return Math.max(1, Math.min(99, Math.round(pct)));
}

module.exports = {
  LeaguePercentilesService,
  percentileOf,
  COLLECTION_NAME,
  MIN_SAMPLE,
  METRICS,
  DECILE_PS,
};
