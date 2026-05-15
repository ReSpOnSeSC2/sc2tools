"use strict";

const express = require("express");
const {
  parseCohortQuery,
  parseGameQuery,
  parseTrendsQuery,
  parseNeighborsQuery,
  parseBuildsQuery,
} = require("../validation/snapshotQuery");
const { indexUnitTimeline } = require("../services/snapshotCentroids");

/**
 * /v1/snapshots/* — game-state snapshot cohort analytics.
 *
 *   GET /snapshots/builds              list buildable cohorts + sample sizes
 *   GET /snapshots/cohort              pure cohort bands (no game overlay)
 *   GET /snapshots/game/:gameId        single-game position scores + insights
 *   GET /snapshots/trends              recurring weaknesses across last N games
 *   GET /snapshots/neighbors/:gameId   counterfactual replay finder
 *
 * Every endpoint reads (with cache miss → compute → cache) from the
 * snapshot_cohorts collection. Per the spec, scope=community/both
 * is k-anon gated (≥8 games); below the floor the cohort endpoint
 * returns 422 rather than fabricated bands.
 *
 * @typedef {{
 *   db: import('../db/connect').DbContext,
 *   gameDetails: import('../services/gameDetails').GameDetailsService,
 *   snapshotCohort: import('../services/snapshotCohort').SnapshotCohortService,
 *   snapshotCache: import('../services/snapshotCache').SnapshotCacheService,
 *   snapshotCompare: import('../services/snapshotCompare').SnapshotCompareService,
 *   snapshotCentroids: import('../services/snapshotCentroids').SnapshotCentroidsService,
 *   snapshotInsights: import('../services/snapshotInsights').SnapshotInsightsService,
 *   snapshotTrends: import('../services/snapshotTrends').SnapshotTrendsService,
 *   snapshotNeighbors: import('../services/snapshotNeighbors').SnapshotNeighborsService,
 *   auth: import('express').RequestHandler,
 * }} SnapshotsDeps
 *
 * @param {SnapshotsDeps} deps
 */
function buildSnapshotsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/snapshots/builds", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const q = parseBuildsQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      res.set("cache-control", "public, max-age=3600");
      res.json(await listBuilds(deps, userId, /** @type {any} */ (q.value)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/snapshots/cohort", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const q = parseCohortQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      const result = await fetchCohort(deps, userId, /** @type {any} */ (q.value));
      if (result.tooSmall) {
        return res.status(422).json({
          error: {
            code: "cohort_too_small",
            sampleSize: result.sampleSize,
            requiredMin: result.requiredMin,
          },
        });
      }
      res.set("cache-control", "public, max-age=3600");
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/snapshots/game/:gameId", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const q = parseGameQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      const data = await fetchGameSnapshot(
        deps,
        userId,
        req.params.gameId,
        /** @type {any} */ (q.value),
      );
      if (data.tooSmall) {
        return res.status(422).json({
          error: {
            code: "cohort_too_small",
            sampleSize: data.sampleSize,
            requiredMin: data.requiredMin,
          },
        });
      }
      res.set("cache-control", "private, max-age=300");
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/snapshots/trends", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const q = parseTrendsQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      res.set("cache-control", "private, max-age=600");
      res.json(
        await deps.snapshotTrends.findTrends(userId, /** @type {any} */ (q.value)),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/snapshots/neighbors/:gameId", async (req, res, next) => {
    try {
      const userId = requireAuth(req).userId;
      const q = parseNeighborsQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      const v = /** @type {any} */ (q.value);
      res.set("cache-control", "private, max-age=600");
      res.json(
        await deps.snapshotNeighbors.findNeighbors({
          userId,
          gameId: req.params.gameId,
          anchorTick: v.anchorTick,
          divergenceTick: v.divergenceTick,
          k: v.k,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * @param {SnapshotsDeps} deps
 * @param {string} userId
 * @param {{ matchup?: string, minSampleSize?: number }} opts
 */
async function listBuilds(deps, userId, opts) {
  /** @type {Record<string, any>} */
  const match = { userId };
  const matchupFilter = opts.matchup ? matchupRegexes(opts.matchup) : null;
  if (matchupFilter) {
    match.myRace = matchupFilter.my;
    match["opponent.race"] = matchupFilter.opp;
  }
  const rows = await deps.db.games
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            build: { $ifNull: ["$myBuild", "Unknown"] },
            matchup: {
              $concat: [
                { $substrCP: [{ $ifNull: ["$myRace", "?"] }, 0, 1] },
                "v",
                { $substrCP: [{ $ifNull: ["$opponent.race", "?"] }, 0, 1] },
              ],
            },
          },
          sampleSize: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          name: "$_id.build",
          matchup: "$_id.matchup",
          sampleSize: 1,
          hasEnoughData: { $gte: ["$sampleSize", opts.minSampleSize || 8] },
        },
      },
      { $sort: { sampleSize: -1 } },
      { $limit: 500 },
    ])
    .toArray();
  return { builds: rows };
}

/**
 * @param {SnapshotsDeps} deps
 * @param {string} userId
 * @param {{ build?: string, matchup?: string, oppOpening?: string, mmrBucket?: number, mapId?: string, scope?: string }} q
 * @returns {Promise<any>}
 */
async function fetchCohort(deps, userId, q) {
  const matchup = q.matchup ? parseMatchup(q.matchup) : null;
  const cohort = await deps.snapshotCohort.resolveCohort({
    userId,
    scope: /** @type {any} */ (q.scope || "community"),
    myBuild: q.build,
    myRace: matchup?.my,
    oppRace: matchup?.opp,
    oppOpening: q.oppOpening,
    mmrBucket: q.mmrBucket,
    mapId: q.mapId,
  });
  if (cohort.tooSmall) {
    return {
      tooSmall: true,
      sampleSize: cohort.sampleSize,
      requiredMin: 8,
      cohortKey: cohort.cohortKey,
    };
  }
  const games = cohort.games;
  const ids = games.map((g) => g.gameId);
  const { hash, inputGameIdsHash } = deps.snapshotCache.buildHashKey(cohort.cohortKey, ids);
  const cached = await deps.snapshotCache.get(hash);
  if (cached && cached.inputGameIdsHash === inputGameIdsHash) {
    return {
      cohortKey: cached.cohortKey,
      cohortTier: cached.cohortTier,
      sampleSize: cached.sampleSize,
      scope: cached.scope,
      ticks: cached.ticks,
      cached: true,
    };
  }
  const bands = await deps.snapshotCohort.aggregateBands(games);
  const detailsMap = await loadDetailsBatch(deps, games);
  const centroids = deps.snapshotCentroids.computeCentroids(games, detailsMap);
  const ticks = mergeTickRows(bands.ticks, centroids);
  await deps.snapshotCache.put({
    hash,
    cohortKey: cohort.cohortKey,
    mmrBucket: q.mmrBucket ?? null,
    scope: cohort.scope,
    sampleSize: cohort.sampleSize,
    cohortTier: cohort.cohortTier,
    ticks,
    inputGameIdsHash,
  });
  return {
    cohortKey: cohort.cohortKey,
    cohortTier: cohort.cohortTier,
    sampleSize: cohort.sampleSize,
    scope: cohort.scope,
    ticks,
    cached: false,
  };
}

/**
 * @param {SnapshotsDeps} deps
 * @param {string} userId
 * @param {string} gameId
 * @param {{ scope?: string, mmrBucket?: number, mapId?: string }} q
 * @returns {Promise<any>}
 */
async function fetchGameSnapshot(deps, userId, gameId, q) {
  const game = await deps.db.games.findOne(
    { userId, gameId },
    {
      projection: {
        _id: 0,
        userId: 1,
        gameId: 1,
        result: 1,
        myRace: 1,
        myBuild: 1,
        durationSec: 1,
        opponent: 1,
        map: 1,
        myMmr: 1,
      },
    },
  );
  if (!game) {
    const err = new Error("game_not_found");
    /** @type {any} */ (err).status = 404;
    /** @type {any} */ (err).code = "game_not_found";
    throw err;
  }
  const cohortQuery = {
    userId,
    scope: /** @type {any} */ (q.scope || "community"),
    myBuild: game.myBuild,
    myRace: game.myRace,
    oppRace: game.opponent?.race,
    oppOpening: game.opponent?.opening,
    mmrBucket: q.mmrBucket,
    mapId: q.mapId,
  };
  const cohortResult = await fetchCohort(deps, userId, {
    build: game.myBuild,
    matchup: matchupOf(game),
    oppOpening: game.opponent?.opening,
    mmrBucket: q.mmrBucket,
    mapId: q.mapId,
    scope: q.scope || "community",
  });
  if (cohortResult.tooSmall) return cohortResult;
  const detail = await deps.gameDetails.findOne(userId, gameId);
  if (!detail) {
    return {
      gameId,
      cohortKey: cohortResult.cohortKey,
      cohortTier: cohortResult.cohortTier,
      sampleSize: cohortResult.sampleSize,
      ticks: [],
      insights: { inflectionTick: null, timingMisses: [], coachingTags: [] },
      missingDetail: true,
    };
  }
  const tickScores = deps.snapshotCompare.compareGameToCohort(
    detail,
    { ticks: cohortResult.ticks },
    { myRace: game.myRace, oppRace: game.opponent?.race },
  );
  const cohortSlim = await deps.snapshotCohort.resolveCohort(cohortQuery);
  const detailsMap = cohortSlim.tooSmall
    ? new Map()
    : await loadDetailsBatch(deps, cohortSlim.games);
  const centroids = cohortSlim.tooSmall
    ? { my: new Map(), opp: new Map() }
    : deps.snapshotCentroids.computeCentroids(cohortSlim.games, detailsMap);
  const { my: myUnits, opp: oppUnits } = indexUnitTimeline(detail.macroBreakdown?.unit_timeline);
  const compositionByTick = deps.snapshotCentroids.computeDeltas(myUnits, oppUnits, centroids);
  const ticksWithComposition = tickScores.map((row) => {
    const comp = compositionByTick.get(row.t);
    return {
      ...row,
      compositionDelta: comp
        ? {
            my: comp.my,
            opp: comp.opp,
            mySimilarity: comp.mySimilarity,
            oppSimilarity: comp.oppSimilarity,
          }
        : null,
    };
  });
  const inflection = deps.snapshotInsights.detectInflection(tickScores);
  const timingMisses = cohortSlim.tooSmall
    ? []
    : deps.snapshotInsights.detectTimingMisses(
        cohortSlim.games,
        detailsMap,
        detail.macroBreakdown?.unit_timeline,
      );
  const coachingTags = deps.snapshotInsights.deriveCoachingTags(tickScores);
  return {
    gameId,
    cohortKey: cohortResult.cohortKey,
    cohortTier: cohortResult.cohortTier,
    sampleSize: cohortResult.sampleSize,
    ticks: ticksWithComposition,
    insights: {
      inflectionTick: inflection.inflectionTick,
      primaryMetric: inflection.primaryMetric,
      secondaryMetric: inflection.secondaryMetric,
      timingMisses,
      coachingTags,
    },
  };
}

/**
 * @param {SnapshotsDeps} deps
 * @param {Array<{ userId: string, gameId: string }>} games
 */
async function loadDetailsBatch(deps, games) {
  /** @type {Map<string, string[]>} */
  const byUser = new Map();
  for (const g of games) {
    let arr = byUser.get(g.userId);
    if (!arr) {
      arr = [];
      byUser.set(g.userId, arr);
    }
    arr.push(g.gameId);
  }
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [userId, gameIds] of byUser) {
    const map = await deps.gameDetails.findMany(userId, gameIds);
    for (const [gameId, detail] of map) {
      out.set(`${userId}:${gameId}`, detail);
    }
  }
  return out;
}

/**
 * @param {Array<any>} ticks
 * @param {{ my: Map<number, any>, opp: Map<number, any> }} centroids
 */
function mergeTickRows(ticks, centroids) {
  return ticks.map((row) => ({
    ...row,
    composition: {
      my: centroids.my.get(row.t)
        ? {
            winnerCentroid: centroids.my.get(row.t).winnerCentroid,
            loserCentroid: centroids.my.get(row.t).loserCentroid,
          }
        : null,
      opp: centroids.opp.get(row.t)
        ? {
            winnerCentroid: centroids.opp.get(row.t).winnerCentroid,
            loserCentroid: centroids.opp.get(row.t).loserCentroid,
          }
        : null,
    },
  }));
}

/** @param {{ myRace?: string, opponent?: { race?: string } }} game */
function matchupOf(game) {
  const my = String(game.myRace || "?").charAt(0).toUpperCase();
  const opp = String(game.opponent?.race || "?").charAt(0).toUpperCase();
  return `${my}v${opp}`;
}

/** @param {string} raw */
function parseMatchup(raw) {
  const m = String(raw || "").toUpperCase().match(/^([PTZ])V([PTZ])$/);
  if (!m) return null;
  return { my: m[1], opp: m[2] };
}

/** @param {string} matchup */
function matchupRegexes(matchup) {
  const parsed = parseMatchup(matchup);
  if (!parsed) return null;
  return {
    my: new RegExp(`^${parsed.my}`, "i"),
    opp: new RegExp(`^${parsed.opp}`, "i"),
  };
}

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (!req.auth) {
    const err = new Error("auth_required");
    /** @type {any} */ (err).status = 401;
    /** @type {any} */ (err).code = "auth_required";
    throw err;
  }
  return req.auth;
}

/** @param {import('express').Response} res @param {string[]} errors */
function badRequest(res, errors) {
  return res.status(400).json({
    error: { code: "bad_request", message: errors.join("; ") },
  });
}

module.exports = { buildSnapshotsRouter };
