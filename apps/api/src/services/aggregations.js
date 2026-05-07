"use strict";

const { LIMITS } = require("../config/constants");
const { gamesMatchStage } = require("../util/parseQuery");
const trendsAgg = require("./trendsAggregations");
const {
  attachRecentByMap,
  attachRecentByMatchup,
} = require("./recentResults");

const RACES_PLAYED = ["Protoss", "Terran", "Zerg"];
const RACE_LETTER_TO_NAME = { P: "Protoss", T: "Terran", Z: "Zerg" };
const RACE_NAME_TO_LETTER = { Protoss: "P", Terran: "T", Zerg: "Z" };
const RANDOM_SUMMARY_MIN_DECIDED = 5;

const RESULT_BUCKET_BRANCHES = [
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "victory"] }, then: "win" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "win"] }, then: "win" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "defeat"] }, then: "loss" },
  { case: { $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "loss"] }, then: "loss" },
];

/**
 * AggregationsService — replaces the in-memory aggregations baked into
 * `stream-overlay-backend/analyzer.js`. Every aggregator runs as a
 * single Mongo pipeline scoped to one user, so the cost scales with
 * that user's history rather than the whole cloud.
 *
 * Public surface mirrors the legacy /summary, /maps, /matchups,
 * /build-vs-strategy, /random-summary, and /timeseries endpoints.
 */
class AggregationsService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Top-of-app overview: totals, byMatchup, byMap, last 20 games.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async summary(userId, filters) {
    return applyRaceGrouping(filters, (f) => this._summaryOnce(userId, f));
  }

  /**
   * @private
   * @param {string} userId
   * @param {object} filters
   */
  async _summaryOnce(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const cursor = this.db.games.aggregate([
      { $match: match },
      { $addFields: { _bucket: bucketSwitch() } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
                },
                total: { $sum: 1 },
              },
            },
          ],
          byMatchup: matchupFacet(),
          byMap: mapFacet(),
          recent: [
            { $sort: { date: -1 } },
            { $limit: 20 },
            {
              $project: {
                _id: 0,
                gameId: 1,
                date: 1,
                map: 1,
                opponent: { $ifNull: ["$opponent.displayName", ""] },
                opp_race: { $ifNull: ["$opponent.race", ""] },
                opp_strategy: { $ifNull: ["$opponent.strategy", null] },
                result: 1,
                build: { $ifNull: ["$myBuild", ""] },
              },
            },
          ],
        },
      },
    ]);
    const [doc] = await cursor.toArray();
    const totals = doc?.totals?.[0] || { wins: 0, losses: 0, total: 0 };
    const winRate = totals.total ? totals.wins / totals.total : 0;
    return {
      totals: { ...totals, winRate },
      byMatchup: rowsToObject(doc?.byMatchup || []),
      byMap: rowsToObject(doc?.byMap || []),
      recent: doc?.recent || [],
    };
  }

  /**
   * Matchup breakdown (vs P / T / Z / R / Unknown). Returns sorted
   * rows with wins/losses/total/winRate.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async matchups(userId, filters) {
    return applyRaceGrouping(filters, (f) => this._matchupsOnce(userId, f));
  }

  /**
   * @private
   * @param {string} userId
   * @param {object} filters
   */
  async _matchupsOnce(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        ...matchupFacet().map(stripFacetWrappers).flat(),
      ])
      .toArray();
    return finalizeRows(
      await attachRecentByMatchup(this.db, userId, filters, rows),
    );
  }

  /**
   * Diagnostic: every distinct value of the `map` field on the user's
   * games, with counts and date range. Helps surface data-quality
   * issues (e.g. an agent that uploads the same map name for every
   * replay) without exposing raw replay docs.
   *
   * @param {string} userId
   * @returns {Promise<Array<{
   *   map: string,
   *   count: number,
   *   firstSeen: Date|null,
   *   lastSeen: Date|null,
   * }>>}
   */
  async distinctMaps(userId) {
    const rows = await this.db.games
      .aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: { $ifNull: ["$map", "Unknown"] },
            count: { $sum: 1 },
            firstSeen: { $min: "$date" },
            lastSeen: { $max: "$date" },
          },
        },
        {
          $project: {
            _id: 0,
            map: "$_id",
            count: 1,
            firstSeen: 1,
            lastSeen: 1,
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();
    return rows;
  }

  /**
   * Per-map W/L breakdown. Same shape as matchups() but keyed by map.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async maps(userId, filters) {
    return applyRaceGrouping(filters, (f) => this._mapsOnce(userId, f));
  }

  /**
   * @private
   * @param {string} userId
   * @param {object} filters
   */
  async _mapsOnce(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        ...mapFacet().map(stripFacetWrappers).flat(),
      ])
      .toArray();
    return finalizeRows(
      await attachRecentByMap(this.db, userId, filters, rows),
    );
  }

  /**
   * Cross-tab of (myBuild, opponent.strategy). Sorted by total desc.
   *
   * @param {string} userId
   * @param {object} filters
   */
  async buildVsStrategy(userId, filters) {
    return applyRaceGrouping(filters, (f) =>
      this._buildVsStrategyOnce(userId, f),
    );
  }

  /**
   * @private
   * @param {string} userId
   * @param {object} filters
   */
  async _buildVsStrategyOnce(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: {
              build: { $ifNull: ["$myBuild", "Unknown"] },
              strat: { $ifNull: ["$opponent.strategy", "Unknown"] },
            },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
            total: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            my_build: "$_id.build",
            opp_strat: "$_id.strat",
            wins: 1,
            losses: 1,
            total: 1,
          },
        },
        { $sort: { total: -1 } },
      ])
      .toArray();
    return rows.map(addWinRate);
  }

  /**
   * Random-race tracker. Always returns the cross-race breakdown
   * regardless of `filters.race` (matches legacy semantics).
   *
   * @param {string} userId
   * @param {object} filters
   */
  async randomSummary(userId, filters) {
    /** @type {Record<string, any>} */
    const f = { ...(filters || {}) };
    delete f.race;
    delete f.groupByRacePlayed;
    const match = gamesMatchStage(userId, f);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $addFields: {
            _race: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, "P"] }, then: "Protoss" },
                  { case: { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, "T"] }, then: "Terran" },
                  { case: { $eq: [{ $toUpper: { $substrCP: ["$myRace", 0, 1] } }, "Z"] }, then: "Zerg" },
                ],
                default: null,
              },
            },
          },
        },
        { $match: { _race: { $ne: null } } },
        {
          $group: {
            _id: "$_race",
            games: { $sum: 1 },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    /** @type {Record<string, number>} */
    const counts = { Protoss: 0, Terran: 0, Zerg: 0 };
    /** @type {Record<string, number>} */
    const wins = { Protoss: 0, Terran: 0, Zerg: 0 };
    /** @type {Record<string, number>} */
    const losses = { Protoss: 0, Terran: 0, Zerg: 0 };
    let total = 0;
    for (const r of rows) {
      const race = String(r._id);
      if (!RACES_PLAYED.includes(race)) continue;
      counts[race] = r.games;
      wins[race] = r.wins;
      losses[race] = r.losses;
      total += r.games;
    }
    /** @type {Record<string, {games: number, wins: number, losses: number, winRate: number, share: number}>} */
    const perRace = {};
    for (const r of RACES_PLAYED) {
      const decided = wins[r] + losses[r];
      perRace[r] = {
        games: counts[r],
        wins: wins[r],
        losses: losses[r],
        winRate: decided ? wins[r] / decided : 0,
        share: total ? counts[r] / total : 0,
      };
    }
    const eligible = RACES_PLAYED.filter(
      (r) => wins[r] + losses[r] >= RANDOM_SUMMARY_MIN_DECIDED,
    );
    /** @type {string | null} */
    let best = null;
    /** @type {string | null} */
    let worst = null;
    if (eligible.length) {
      best = eligible.reduce((a, b) =>
        perRace[a].winRate >= perRace[b].winRate ? a : b,
      );
      worst = eligible.reduce((a, b) =>
        perRace[a].winRate <= perRace[b].winRate ? a : b,
      );
    }
    return {
      total,
      perRace,
      best,
      worst,
      minDecidedForBest: RANDOM_SUMMARY_MIN_DECIDED,
    };
  }

  /**
   * Daily / weekly / monthly W-L timeseries for the trends chart.
   *
   * @param {string} userId
   * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
   * @param {object} filters
   */
  async timeseries(userId, opts, filters) {
    return applyRaceGrouping(filters, (f) =>
      this._timeseriesOnce(userId, opts, f),
    );
  }

  /**
   * @private
   * @param {string} userId
   * @param {{interval?: 'day'|'week'|'month', tz?: string} | undefined} opts
   * @param {object} filters
   */
  async _timeseriesOnce(userId, opts, filters) {
    const interval = pickInterval(opts && opts.interval);
    const timezone = pickTimezone(opts && opts.tz);
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        { $addFields: { _bucket: bucketSwitch() } },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: "$date",
                unit: interval,
                timezone,
              },
            },
            wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
            total: { $sum: 1 },
          },
        },
        // Keep the most recent N buckets (not the oldest). Users with
        // multi-year histories were silently losing today's bucket
        // because `sort asc + limit` truncated the tail.
        { $sort: { _id: -1 } },
        { $limit: LIMITS.TIMESERIES_MAX_BUCKETS },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0,
            bucket: "$_id",
            wins: 1,
            losses: 1,
            total: 1,
          },
        },
      ])
      .toArray();
    return {
      interval,
      points: rows.map((r) => ({
        ...r,
        winRate: r.total ? r.wins / r.total : 0,
      })),
    };
  }

  // ---------------- v0.5+ Trends-tab aggregations ----------------
  // Implementations live in ``./trendsAggregations.js`` so this file
  // stays under the per-file size budget. Each method passes the same
  // helper bundle every pipeline needs (gamesMatchStage / bucketSwitch /
  // pickInterval / pickTimezone) so the helper module never needs to
  // know about the singleton service.

  /** @see ./trendsAggregations.js */
  async matchupTimeseries(userId, opts, filters) {
    return trendsAgg.matchupTimeseries(this._trendsDeps(), userId, opts, filters);
  }

  /** @see ./trendsAggregations.js */
  async dayHourHeatmap(userId, opts, filters) {
    return trendsAgg.dayHourHeatmap(this._trendsDeps(), userId, opts, filters);
  }

  /** @see ./trendsAggregations.js */
  async lengthBuckets(userId, filters) {
    return trendsAgg.lengthBuckets(this._trendsDeps(), userId, filters);
  }

  /** @see ./trendsAggregations.js */
  async activityCalendar(userId, opts, filters) {
    return trendsAgg.activityCalendar(this._trendsDeps(), userId, opts, filters);
  }

  /** @private */
  _trendsDeps() {
    return {
      games: this.db.games,
      gamesMatchStage,
      bucketSwitch,
      pickInterval,
      pickTimezone,
    };
  }

  /**
   * Full openable replay list, used by the Map Intel selector.
   *
   * Server-side filters (search/sort/limit/offset) match the legacy
   * route exactly so the SPA's existing query strings keep working.
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{
   *   search?: string,
   *   sort?: string,
   *   limit?: number,
   *   offset?: number,
   *   resultBucket?: 'win' | 'loss',
   * }} [opts]
   */
  async gamesList(userId, filters, opts = {}) {
    const match = gamesMatchStage(userId, filters);
    const search = (opts.search || "").toString().trim().toLowerCase();
    const offset = Math.max(0, Number.parseInt(String(opts.offset || 0), 10) || 0);
    const requestedLimit = Number.parseInt(String(opts.limit || LIMITS.GAMES_LIST_DEFAULT), 10);
    const limit = Math.max(
      0,
      Math.min(LIMITS.GAMES_LIST_MAX, Number.isFinite(requestedLimit) ? requestedLimit : LIMITS.GAMES_LIST_DEFAULT),
    );
    const sort = pickSort(opts.sort);
    /** @type {Array<Record<string, any>>} */
    const pipeline = [
      { $match: match },
      { $addFields: { _bucket: bucketSwitch() } },
    ];
    if (opts.resultBucket === "win" || opts.resultBucket === "loss") {
      pipeline.push({ $match: { _bucket: opts.resultBucket } });
    }
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { "opponent.displayName": { $regex: escapeRegex(search), $options: "i" } },
            { map: { $regex: escapeRegex(search), $options: "i" } },
            { myBuild: { $regex: escapeRegex(search), $options: "i" } },
            { "opponent.strategy": { $regex: escapeRegex(search), $options: "i" } },
          ],
        },
      });
    }
    pipeline.push({
      $project: {
        _id: 0,
        id: "$gameId",
        date: 1,
        map: { $ifNull: ["$map", ""] },
        opponent: { $ifNull: ["$opponent.displayName", ""] },
        opp_race: { $ifNull: ["$opponent.race", ""] },
        opp_strategy: { $ifNull: ["$opponent.strategy", null] },
        result: { $ifNull: ["$result", ""] },
        build: { $ifNull: ["$myBuild", ""] },
        game_length: { $ifNull: ["$durationSec", 0] },
        macro_score: { $ifNull: ["$macroScore", null] },
        my_race: { $ifNull: ["$myRace", ""] },
      },
    });
    pipeline.push({ $sort: sort });
    pipeline.push({
      $facet: {
        meta: [{ $count: "total" }],
        rows: [{ $skip: offset }, { $limit: limit }],
      },
    });
    const [doc] = await this.db.games.aggregate(pipeline).toArray();
    const total = doc?.meta?.[0]?.total || 0;
    const games = doc?.rows || [];
    return {
      ok: true,
      total,
      offset,
      limit,
      count: games.length,
      games,
    };
  }
}

// ---------------- helpers ----------------

function bucketSwitch() {
  return {
    $switch: {
      branches: RESULT_BUCKET_BRANCHES,
      default: null,
    },
  };
}

function matchupFacet() {
  return [
    {
      $group: {
        _id: {
          $cond: [
            { $eq: [{ $ifNull: ["$opponent.race", ""] }, ""] },
            "vs Unknown",
            {
              $concat: [
                "vs ",
                { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
              ],
            },
          ],
        },
        wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        total: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        name: "$_id",
        wins: 1,
        losses: 1,
        total: 1,
      },
    },
    { $sort: { total: -1 } },
  ];
}

function mapFacet() {
  return [
    {
      $group: {
        _id: { $ifNull: ["$map", "Unknown"] },
        wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
        total: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        name: "$_id",
        wins: 1,
        losses: 1,
        total: 1,
      },
    },
    { $sort: { total: -1 } },
  ];
}

/** @param {any} stage */
function stripFacetWrappers(stage) {
  // Helper for callers that use the same pipeline outside of $facet.
  // We just yield the stage as-is — a shim so the matchupFacet /
  // mapFacet definitions can be reused in two contexts.
  return [stage];
}

/** @param {Array<{name: string, wins?: number, losses?: number, total?: number}>} rows */
function rowsToObject(rows) {
  /** @type {Record<string, {wins: number, losses: number, total: number, winRate: number}>} */
  const out = {};
  for (const row of rows) {
    out[row.name] = {
      wins: row.wins || 0,
      losses: row.losses || 0,
      total: row.total || 0,
      winRate: row.total ? (row.wins || 0) / row.total : 0,
    };
  }
  return out;
}

/** @param {Array<Record<string, any>>} rows */
function finalizeRows(rows) {
  return rows.map(addWinRate);
}

/** @param {Record<string, any>} row */
function addWinRate(row) {
  const total = row.total || 0;
  return {
    ...row,
    winRate: total ? (row.wins || 0) / total : 0,
  };
}

/** @param {unknown} raw */
function pickInterval(raw) {
  const s = String(raw || "day").toLowerCase();
  if (s === "week") return "week";
  if (s === "month") return "month";
  return "day";
}

/**
 * Validate an IANA timezone identifier supplied by the client. Falls
 * back to UTC for missing or malformed values so we never push an
 * unresolvable timezone into Mongo's $dateTrunc.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function pickTimezone(raw) {
  if (typeof raw !== "string") return "UTC";
  const s = raw.trim();
  if (!s) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return s;
  } catch {
    return "UTC";
  }
}

/** @param {unknown} raw */
function pickSort(raw) {
  const key = String(raw || "date_desc").toLowerCase();
  switch (key) {
    case "date_asc":
      return { date: 1 };
    case "opponent_asc":
      return { opponent: 1 };
    case "opponent_desc":
      return { opponent: -1 };
    case "map_asc":
      return { map: 1 };
    case "map_desc":
      return { map: -1 };
    case "length_desc":
      return { game_length: -1 };
    case "length_asc":
      return { game_length: 1 };
    case "date_desc":
    default:
      return { date: -1 };
  }
}

/** @param {unknown} s */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap an aggregator so that `filters.groupByRacePlayed` produces a
 * `{ Protoss, Terran, Zerg }` payload while leaving the single-shot
 * call shape unchanged.
 *
 * @template T
 * @param {object} filters
 * @param {(f: object) => Promise<T>} runOnce
 * @returns {Promise<T | Record<string, T>>}
 */
async function applyRaceGrouping(filters, runOnce) {
  /** @type {Record<string, any>} */
  const f = filters || {};
  if (!f.groupByRacePlayed) return runOnce(f);
  const { groupByRacePlayed: _g, race: _r, ...base } = f;
  /** @type {Record<string, T>} */
  const out = {};
  for (const race of RACES_PLAYED) {
    /** @type {Record<string, string>} */
    const letterMap = RACE_NAME_TO_LETTER;
    out[race] = await runOnce({ ...base, race: letterMap[race] });
  }
  return out;
}

module.exports = {
  AggregationsService,
  RACES_PLAYED,
  RACE_LETTER_TO_NAME,
  RACE_NAME_TO_LETTER,
};
