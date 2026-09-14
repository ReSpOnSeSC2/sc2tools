"use strict";

const { AggregationsService } = require("./aggregations");
const { gamesMatchStage } = require("../util/parseQuery");
const { myLadderRaceExpr } = require("./trendsRegionExpr");
const { globalHistoryStages, parseGlobalTrendsFilters, playerIncluded } = require("./adminGlobalTrendsScope");
const { readGlobalPlayers, paginatePlayers } = require("./adminGlobalTrendsPlayers");
const { globalMmrProgression, fitGlobalInterval } = require("./adminGlobalTrendsMmr");

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
    /** @type {Promise<Awaited<ReturnType<typeof readGlobalPlayers>>> | null} */
    this.roster = null;
    this.rosterExpiresAt = 0;
    this.activeQueries = 0;
    /** @type {Array<() => void>} */
    this.queryWaiters = [];
    /** @type {Map<string, {expiresAt: number, promise: Promise<any>}>} */
    this.results = new Map();
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
    this.roster = null;
    this.rosterExpiresAt = 0;
    this.results.clear();
  }

  /** Shared by simultaneous chart requests; refresh promptly after uploads. */
  async _players() {
    if (!this.roster || Date.now() >= this.rosterExpiresAt) {
      this.rosterExpiresAt = Date.now() + 30000;
      this.roster = readGlobalPlayers(this.db).catch((err) => {
        this.roster = null;
        throw err;
      });
    }
    return this.roster;
  }

  /** @param {Record<string, unknown>} query */
  async players(query = {}) {
    this._refresh(query);
    return paginatePlayers(await this._players(), parseGlobalTrendsFilters(query), query);
  }

  /** @param {Record<string, unknown>} query */
  async filterOptions(query = {}) {
    this._refresh(query);
    const cohort = parseGlobalTrendsFilters(query);
    const agg = await this._aggregations("filterOptions", cohort);
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
    const key = JSON.stringify([method, cohort, opts]);
    const cached = this.results.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    // Both net-MMR cards request the same data. Share their in-flight work,
    // and bound simultaneous global scans across all admins to this service.
    // The cache is short-lived, bounded, and contains admin read responses only.
    while (this.results.size >= 64) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
    const promise = this._withQuerySlot(() => this._run(method, cohort, opts)).catch((err) => {
      this.results.delete(key);
      throw err;
    });
    this.results.set(key, { expiresAt: Date.now() + 15000, promise });
    return promise;
  }

  /** @param {() => Promise<any>} work */
  async _withQuerySlot(work) {
    if (this.activeQueries >= 3) await new Promise((resolve) => this.queryWaiters.push(() => resolve(undefined)));
    else this.activeQueries += 1;
    try { return await work(); } finally {
      const next = this.queryWaiters.shift();
      if (next) next();
      else this.activeQueries -= 1;
    }
  }

  /** @param {string} method @param {import('./adminGlobalTrendsScope').Cohort} cohort @param {Record<string, any>} opts */
  async _run(method, cohort, opts) {
    const agg = await this._aggregations(method, cohort);
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
      const names = new Map((await this._players()).map((p) => [p.playerId, p.displayName]));
      result.games = result.games.map((/** @type {any} */ game) => ({
        ...game, playerName: names.get(game.playerId) || game.playerId,
      }));
    }
    return result;
  }

  /** @param {string} method @param {import('./adminGlobalTrendsScope').Cohort} cohort */
  async _aggregations(method, cohort) {
    /** @type {Record<string, any>} */
    const playerMatch = {};
    if (cohort.excludedPlayers.length) playerMatch.$nin = cohort.excludedPlayers;
    if (cohort.selection === "include") playerMatch.$in = cohort.includedPlayers;
    if (cohort.mmrMin !== undefined || cohort.mmrMax !== undefined || !cohort.includeUnrated) {
      playerMatch.$in = (await this._players()).filter((p) => playerIncluded(p, cohort)).map((p) => p.playerId);
    }
    const prefix = globalHistoryStages(playerMatch);
    const games = {
      aggregate: (/** @type {Array<Record<string, any>>} */ pipeline) => {
        // Fail closed if a newly reused helper does not carry the expected
        // explicit scope. No recursive rewrite touches nested lookup scopes.
        if (pipeline[0]?.$match?.userId !== ADMIN_SCOPE) throw new Error("Unscoped global trends pipeline");
        const stages = adaptPipeline(pipeline, method, cohort);
        return this.db.games.aggregate([...prefix, ...stages], { allowDiskUse: true, maxTimeMS: 60000 });
      },
    };
    return new AggregationsService({ games: /** @type {import('mongodb').Collection} */ (/** @type {unknown} */ (games)) });
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
