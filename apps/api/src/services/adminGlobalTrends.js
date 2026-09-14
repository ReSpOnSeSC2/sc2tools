"use strict";

const { AggregationsService } = require("./aggregations");
const { gamesMatchStage } = require("../util/parseQuery");
const { myLadderRaceExpr } = require("./trendsRegionExpr");
const { parseGlobalTrendsFilters, playerIncluded } = require("./adminGlobalTrendsScope");
const { readGlobalPlayers, paginatePlayers } = require("./adminGlobalTrendsPlayers");
const { globalMmrProgression, fitGlobalInterval } = require("./adminGlobalTrendsMmr");
const { GlobalTrendsQueries, QUERY_MAX_TIME_MS, queryKey } = require("./adminGlobalTrendsQueries");
const { GlobalTrendsHistory } = require("./adminGlobalTrendsHistory");

// Never accepted from a query parameter. Only the private collection adapter
// below can translate this marker; ordinary AggregationsService stays scoped.
const ADMIN_SCOPE = "__admin_global_trends_internal__";
const INTERVAL_METHODS = new Set([
  "timeseries", "matchupTimeseries", "mapTrend", "myBuildMixOverTime", "oppStrategyMixOverTime",
]);
const ALLOWED_METHODS = new Set([
  ...INTERVAL_METHODS, "dayHourHeatmap", "activityCalendar", "lengthBuckets", "momentum",
  "oppMmrBuckets", "oppMmrBucketGames", "netMmrByMatchup", "netMmrByOpponent", "mmrProgression",
]);
const NET_METHODS = new Set(["netMmrByMatchup", "netMmrByOpponent"]);

class AdminGlobalTrendsService {
  /** @param {{db: import('../db/connect').DbContext}} deps */
  constructor({ db }) {
    this.db = db;
    this.queries = new GlobalTrendsQueries();
    this.history = new GlobalTrendsHistory(db, (work) => this.queries.execute(work));
    this.refreshedAfter = 0;
  }

  /** One explicit UI refresh token is shared by every chart request.
   * Invalidating once prevents concurrent cards from repeatedly clearing
   * each other's results. Reject extreme clock skew rather than poisoning
   * the monotonic marker with an arbitrary future timestamp.
   * @param {Record<string, unknown>} query */
  _refresh(query) {
    const token = Number(query.refresh_after);
    if (!Number.isFinite(token) || token <= this.refreshedAfter || token > Date.now() + 60000) return;
    this.refreshedAfter = token;
    this.queries.clear();
    this.history.invalidate();
  }

  /** Shared by simultaneous chart requests within one canonical history.
   * @param {import('./adminGlobalTrendsHistory').HistorySnapshot} snapshot */
  async _players(snapshot) {
    return /** @type {Promise<Awaited<ReturnType<typeof readGlobalPlayers>>>} */ (this.queries.cached(queryKey(["roster", snapshot.id]), () => {
        const games = { aggregate: (/** @type {Array<Record<string, any>>} */ pipeline) => this._query(pipeline, this.history.collection) };
        return readGlobalPlayers({ ...this.db, games: /** @type {any} */ (games) }, [{ $match: { _globalSnapshotId: snapshot.id } }]);
      }));
  }

  /** @param {Record<string, unknown>} query */
  async players(query = {}) {
    this._refresh(query);
    return this.history.withSnapshot(async (snapshot) => paginatePlayers(await this._players(snapshot), parseGlobalTrendsFilters(query), query));
  }

  /** @param {Record<string, unknown>} query */
  async filterOptions(query = {}) {
    this._refresh(query);
    const cohort = parseGlobalTrendsFilters(query);
    return this.history.withSnapshot((snapshot) => this.queries.cached(queryKey(["options", snapshot.id, cohort]), () => this._filterOptions(cohort, snapshot)));
  }

  /** @param {import('./adminGlobalTrendsScope').Cohort} cohort
   * @param {import('./adminGlobalTrendsHistory').HistorySnapshot} snapshot */
  async _filterOptions(cohort, snapshot) {
    const agg = await this._aggregations("filterOptions", cohort, snapshot);
    const [result] = await agg.db.games.aggregate([
      { $match: gamesMatchStage(ADMIN_SCOPE, {}) },
      { $facet: {
        maps: distinctFacet("$map"), builds: distinctFacet("$myBuild"),
        strategies: distinctFacet("$opponent.strategy"),
      } },
    ]).toArray();
    return Object.fromEntries(["maps", "builds", "strategies"].map((key) => [
      key, (result?.[key] || []).map((/** @type {any} */ row) => row._id),
    ]));
  }

  /** @param {string} method @param {Record<string, unknown>} query @param {Record<string, any>} opts */
  async run(method, query = {}, opts = {}) {
    if (!ALLOWED_METHODS.has(method)) throw new Error("Unsupported global trends method");
    this._refresh(query);
    const cohort = parseGlobalTrendsFilters(query);
    return this.history.withSnapshot((snapshot) => this.queries.cached(queryKey(["result", snapshot.id, method, cohort, opts]), () => this._run(method, cohort, opts, snapshot)));
  }

  /** The adapter's only cursor operation is toArray. Delay acquisition until
   * execution, and coalesce identical range probes used by multiple charts.
   * @param {Array<Record<string, any>>} pipeline
   * @param {import('mongodb').Collection} collection */
  _query(pipeline, collection) {
    const finalGroup = pipeline.at(-1)?.$group;
    const isRange = finalGroup?.first?.$min === "$date" && finalGroup?.last?.$max === "$date";
    const read = () => this.queries.execute(() =>
      collection.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: QUERY_MAX_TIME_MS }).toArray());
    return { toArray: () => isRange ? this.queries.cached(queryKey(["range", pipeline]), read) : read() };
  }

  /** @param {string} method @param {import('./adminGlobalTrendsScope').Cohort} cohort @param {Record<string, any>} opts
   * @param {import('./adminGlobalTrendsHistory').HistorySnapshot} snapshot */
  async _run(method, cohort, opts, snapshot) {
    const agg = await this._aggregations(method, cohort, snapshot);
    const filters = cohort.filters;
    if (method === "mmrProgression") return globalMmrProgression(agg, ADMIN_SCOPE, filters, opts);
    if (INTERVAL_METHODS.has(method)) {
      const requested = opts.interval === "day" || opts.interval === "month" ? opts.interval : "week";
      opts = { ...opts, interval: method === "timeseries" ? requested
        : await fitGlobalInterval(agg.db.games, gamesMatchStage(ADMIN_SCOPE, filters), requested) };
      return /** @type {any} */ (agg)[method](ADMIN_SCOPE, opts, filters);
    }
    if (method === "dayHourHeatmap" || method === "activityCalendar") {
      return agg[method](ADMIN_SCOPE, opts, filters);
    }
    const result = await /** @type {any} */ (agg)[method](ADMIN_SCOPE, filters, opts);
    if (method === "oppMmrBucketGames") {
      const names = new Map((await this._players(snapshot)).map((p) => [p.playerId, p.displayName]));
      result.games = result.games.map((/** @type {any} */ game) => ({
        ...game, playerName: names.get(game.playerId) || game.playerId,
      }));
    }
    return result;
  }

  /** @param {string} method @param {import('./adminGlobalTrendsScope').Cohort} cohort
   * @param {import('./adminGlobalTrendsHistory').HistorySnapshot} snapshot */
  async _aggregations(method, cohort, snapshot) {
    /** @type {Record<string, any>} */
    const playerMatch = {};
    if (cohort.excludedPlayers.length) playerMatch.$nin = cohort.excludedPlayers;
    if (cohort.selection === "include") playerMatch.$in = cohort.includedPlayers;
    if (cohort.mmrMin !== undefined || cohort.mmrMax !== undefined || !cohort.includeUnrated) {
      playerMatch.$in = (await this._players(snapshot)).filter((p) => playerIncluded(p, cohort)).map((p) => p.playerId);
    }
    const prefix = [{ $match: {
      _globalSnapshotId: snapshot.id,
      ...(Object.keys(playerMatch).length ? { _globalPlayerId: playerMatch } : {}),
    } }, { $set: { _id: "$_globalSourceId" } }];
    const games = {
      aggregate: (/** @type {Array<Record<string, any>>} */ pipeline) => {
        // Fail closed if a newly reused helper does not carry the expected
        // explicit scope. No recursive rewrite touches nested lookup scopes.
        if (pipeline[0]?.$match?.userId !== ADMIN_SCOPE) throw new Error("Unscoped global trends pipeline");
        const stages = adaptPipeline(pipeline, method, cohort);
        return this._query([...prefix, ...stages], this.history.collection);
      },
    };
    const agg = new AggregationsService({ games: /** @type {import('mongodb').Collection} */ (/** @type {unknown} */ (games)) });
    // Every time chart now emits the same date-range probe. The query cache
    // shares it across charts and requested intervals instead of rescanning.
    /** @type {any} */ (agg)._fitInterval = (
      /** @type {Record<string, any>} */ match,
      /** @type {'day'|'week'|'month'} */ requested,
    ) => fitGlobalInterval(agg.db.games, match, requested);
    return agg;
  }
}

/** @param {string} field */
function distinctFacet(field) {
  return [{ $group: { _id: field } }, { $match: { _id: { $type: "string", $ne: "" } } }, { $sort: { _id: 1 } }];
}

/** @param {Array<Record<string, any>>} pipeline @param {string} method
 * @param {import('./adminGlobalTrendsScope').Cohort} cohort */
function adaptPipeline(pipeline, method, cohort) {
  return pipeline.flatMap((stage, index) => {
    if (stage.$match?.userId === ADMIN_SCOPE) {
      const match = { ...stage.$match };
      delete match.userId;
      // Net-MMR pairing must see full account history before race/date/etc.
      if (cohort.excludedRaces.length && (!NET_METHODS.has(method) || index > 0)) {
        match._globalPlayedRace = { $nin: cohort.excludedRaces };
      }
      return [{ $match: match }];
    }
    if (method === "momentum" && stage.$setWindowFields) {
      const window = stage.$setWindowFields;
      const partition = {
        player: "$_globalPlayerId", race: myLadderRaceExpr(),
        ladder: { $ifNull: ["$isLadderGame", null] },
        size: { $ifNull: ["$playerCount", null] },
        ...(window.partitionBy ? { session: window.partitionBy } : {}),
      };
      return [
        // $documentNumber accepts exactly one sort key. A composite value
        // keeps equal-timestamp replays ordered consistently in all windows.
        ...(window.output._prevDate ? [{ $addFields: { _globalSequenceOrder: { date: "$date", game: "$gameId" } } }] : []),
        { $setWindowFields: { ...window, partitionBy: partition, sortBy: { _globalSequenceOrder: 1 } } },
      ];
    }
    if (method === "oppMmrBucketGames" && stage.$project?.id === "$gameId") {
      return [{ $project: { ...stage.$project, playerId: "$_globalPlayerId" } }];
    }
    // Global charts can contain many more maps/builds than one player. The
    // caller fits time intervals; do not silently truncate cross-tab rows.
    if ((INTERVAL_METHODS.has(method) || method === "activityCalendar") && stage.$limit) return [];
    return [stage];
  });
}

module.exports = { AdminGlobalTrendsService };
