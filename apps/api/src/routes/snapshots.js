"use strict";

const express = require("express");
const crypto = require("crypto");
const {
  parseCohortQuery,
  parseGameQuery,
  parseTrendsQuery,
  parseNeighborsQuery,
  parseBuildsQuery,
  parseMatrixQuery,
} = require("../validation/snapshotQuery");

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
 *   snapshotTechPath: import('../services/snapshotTechPath').SnapshotTechPathService,
 *   snapshotMatchupMatrix: import('../services/snapshotMatchupMatrix').SnapshotMatchupMatrixService,
 *   snapshotGameComposer: import('../services/snapshotGameComposer').SnapshotGameComposer,
 *   users: import('../services/users').UsersService,
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

  router.get("/snapshots/matrix", async (req, res, next) => {
    try {
      requireAuth(req);
      const q = parseMatrixQuery(req.query);
      if (!q.valid) return badRequest(res, q.errors);
      const data = await fetchMatrix(deps, /** @type {any} */ (q.value));
      if (data.tooSmall) {
        return res.status(422).json({
          error: {
            code: "cohort_too_small",
            sampleSize: data.sampleSize,
            requiredMin: data.requiredMin,
          },
        });
      }
      res.set("cache-control", "public, max-age=3600");
      res.json(data);
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
  const cohortSlim = await deps.snapshotCohort.resolveCohort(cohortQuery);
  if (cohortSlim.tooSmall) return cohortSlim;
  const detailsMap = await loadDetailsBatch(deps, cohortSlim.games);
  const weightsOverride = deps.users && deps.users.getSnapshotWeightsOverride
    ? await deps.users.getSnapshotWeightsOverride(userId).catch(() => null)
    : null;
  const composed = deps.snapshotGameComposer.composeGameResponse({
    focal: { game, detail },
    cohortGames: cohortSlim.games,
    detailsByGameId: detailsMap,
    bandsTicks: cohortResult.ticks,
    weightsOverride,
  });
  const ticksWithComposition = composed.ticks;
  const insights = composed.insights;
  return {
    gameId,
    cohortKey: cohortResult.cohortKey,
    cohortTier: cohortResult.cohortTier,
    sampleSize: cohortResult.sampleSize,
    ticks: ticksWithComposition,
    insights,
  };
}

/**
 * Standalone matchup matrix lookup for the cohort browser tab.
 * Reads from the snapshot_matrices cache when fresh; recomputes on
 * miss and writes the result back. K-anon gated like /cohort.
 *
 * @param {SnapshotsDeps} deps
 * @param {{ matchup: string, mmrBucket?: number, tick?: number, scope?: string }} q
 */
async function fetchMatrix(deps, q) {
  const matchup = parseMatchup(q.matchup);
  if (!matchup) {
    const err = new Error("invalid_matchup");
    /** @type {any} */ (err).status = 400;
    throw err;
  }
  const tickSec = roundTickToBin(q.tick ?? 360);
  const scope = q.scope || "community";
  const resolved = await deps.snapshotCohort.resolveCohort({
    scope: /** @type {any} */ (scope),
    myRace: matchup.my,
    oppRace: matchup.opp,
    mmrBucket: q.mmrBucket,
  });
  if (resolved.tooSmall) {
    return { tooSmall: true, sampleSize: resolved.sampleSize, requiredMin: 8 };
  }
  const ids = resolved.games.map((g) => g.gameId);
  const inputGameIdsHash = crypto
    .createHash("sha256")
    .update(ids.slice().sort().join("\0"))
    .digest("hex")
    .slice(0, 16);
  const hashKey = crypto
    .createHash("sha256")
    .update(`${q.matchup}|${q.mmrBucket ?? "*"}|${scope}|${tickSec}|${inputGameIdsHash}`)
    .digest("hex");
  const cached = await deps.db.snapshotMatrices.findOne({ _id: hashKey });
  if (cached && cached.inputGameIdsHash === inputGameIdsHash) {
    return shapeMatrixResponse(cached, q.matchup, scope, tickSec);
  }
  const detailsByGameId = await loadDetailsBatch(deps, resolved.games);
  const matrix = deps.snapshotMatchupMatrix.buildMatrix(resolved.games, detailsByGameId, tickSec);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await deps.db.snapshotMatrices.findOneAndUpdate(
    { _id: hashKey },
    {
      $set: {
        _id: hashKey,
        matchup: q.matchup,
        mmrBucket: q.mmrBucket ?? null,
        scope,
        tickSec,
        cohortTier: resolved.cohortTier,
        sampleSize: resolved.sampleSize,
        matrix,
        inputGameIdsHash,
        generatedAt: now,
        expiresAt,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return shapeMatrixResponse(
    { matrix, cohortTier: resolved.cohortTier, sampleSize: resolved.sampleSize },
    q.matchup,
    scope,
    tickSec,
  );
}

function shapeMatrixResponse(row, matchup, scope, tickSec) {
  return {
    matchup,
    scope,
    tick: tickSec,
    cohortTier: row.cohortTier,
    sampleSize: row.sampleSize,
    matrix: row.matrix,
  };
}

function roundTickToBin(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 360;
  const r = Math.round(n / 30) * 30;
  return Math.min(Math.max(r, 0), 1200);
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
