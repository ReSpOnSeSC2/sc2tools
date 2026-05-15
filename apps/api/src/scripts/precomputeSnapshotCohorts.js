#!/usr/bin/env node
"use strict";

/**
 * Nightly precompute job for the snapshot_cohorts cache.
 *
 * Walks the top N cohorts by recent query volume (proxied via the
 * popularity of each (myBuild, matchup) pair in the games
 * collection) and regenerates their band rows before they expire.
 * That keeps the snapshot drilldown page's steady-state cache miss
 * rate near zero — a user opening the page on a popular build sees
 * a sub-100ms response because the heavy fold ran overnight.
 *
 * Designed to run from a cron / Render scheduled job. Idempotent:
 * re-running mid-day just refreshes any cohorts already touched.
 *
 * Env:
 *   SNAPSHOT_PRECOMPUTE_TOP_N   how many cohorts to refresh (default 200)
 *   SNAPSHOT_PRECOMPUTE_SCOPE   "community" (default) or "mine"
 *   MONGO_URI                   inherited from cloud secret
 *   MONGO_DB                    inherited from cloud secret
 */

const { connect } = require("../db/connect");
const { loadConfig } = require("../config/loader");
const { GameDetailsService } = require("../services/gameDetails");
const { buildStoreFromConfig } = require("../services/gameDetailsStore");
const { SnapshotCohortService } = require("../services/snapshotCohort");
const { SnapshotCacheService } = require("../services/snapshotCache");
const { SnapshotCentroidsService } = require("../services/snapshotCentroids");

const DEFAULT_TOP_N = 200;
const MAX_TOP_N = 1000;

async function main() {
  const cfg = loadConfig();
  const db = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDbName });
  const store = buildStoreFromConfig({
    db,
    config: { gameDetailsStore: cfg.gameDetailsStore, r2: cfg.r2 },
  });
  const gameDetails = new GameDetailsService(store);
  const cohort = new SnapshotCohortService(db, { gameDetails });
  const cache = new SnapshotCacheService(db);
  const centroids = new SnapshotCentroidsService();
  const topN = clampTopN(process.env.SNAPSHOT_PRECOMPUTE_TOP_N);
  const scope = process.env.SNAPSHOT_PRECOMPUTE_SCOPE || "community";
  console.log(
    JSON.stringify({
      level: "info",
      msg: "snapshot.precompute.start",
      topN,
      scope,
    }),
  );
  const targets = await pickTopCohorts(db, topN);
  let refreshed = 0;
  let skipped = 0;
  for (const target of targets) {
    try {
      const refreshedRow = await refreshOne(target, scope, {
        cohort,
        cache,
        gameDetails,
        centroids,
      });
      if (refreshedRow) refreshed += 1;
      else skipped += 1;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "snapshot.precompute.error",
          target,
          err: String(err?.message || err),
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      level: "info",
      msg: "snapshot.precompute.done",
      refreshed,
      skipped,
      totalTargets: targets.length,
    }),
  );
  await db.close();
}

/**
 * Pick the top-N (myBuild, myRace, oppRace) tuples by aggregate
 * game count across all users. These map directly to tier-2 cohort
 * keys — the cohort tier the snapshot UI hits most often. Tier-1
 * is finer (per opening) so it has more variance and a smaller
 * absolute query volume; the precompute walks tier-2 to amortize
 * the heavy fold across the widest possible audience.
 *
 * @param {import('../db/connect').DbContext} db
 * @param {number} topN
 */
async function pickTopCohorts(db, topN) {
  return db.games
    .aggregate([
      {
        $match: {
          myBuild: { $type: "string" },
          myRace: { $type: "string" },
          "opponent.race": { $type: "string" },
        },
      },
      {
        $group: {
          _id: {
            myBuild: "$myBuild",
            myRace: { $substrCP: ["$myRace", 0, 1] },
            oppRace: { $substrCP: ["$opponent.race", 0, 1] },
          },
          gameCount: { $sum: 1 },
        },
      },
      { $match: { gameCount: { $gte: 8 } } },
      { $sort: { gameCount: -1 } },
      { $limit: topN },
      {
        $project: {
          _id: 0,
          myBuild: "$_id.myBuild",
          myRace: "$_id.myRace",
          oppRace: "$_id.oppRace",
          gameCount: 1,
        },
      },
    ])
    .toArray();
}

/**
 * @param {object} target
 * @param {string} scope
 * @param {object} services
 */
async function refreshOne(target, scope, services) {
  const cohort = await services.cohort.resolveCohort({
    scope,
    myBuild: target.myBuild,
    myRace: target.myRace,
    oppRace: target.oppRace,
  });
  if (cohort.tooSmall) return null;
  const ids = cohort.games.map((g) => g.gameId);
  const { hash, inputGameIdsHash } = services.cache.buildHashKey(cohort.cohortKey, ids);
  const bands = await services.cohort.aggregateBands(cohort.games);
  const detailsMap = await loadDetailsBatch(services.gameDetails, cohort.games);
  const centroidMaps = services.centroids.computeCentroids(cohort.games, detailsMap);
  const ticks = bands.ticks.map((row) => ({
    ...row,
    composition: {
      my: centroidMaps.my.get(row.t)
        ? {
            winnerCentroid: centroidMaps.my.get(row.t).winnerCentroid,
            loserCentroid: centroidMaps.my.get(row.t).loserCentroid,
          }
        : null,
      opp: centroidMaps.opp.get(row.t)
        ? {
            winnerCentroid: centroidMaps.opp.get(row.t).winnerCentroid,
            loserCentroid: centroidMaps.opp.get(row.t).loserCentroid,
          }
        : null,
    },
  }));
  await services.cache.put({
    hash,
    cohortKey: cohort.cohortKey,
    mmrBucket: null,
    scope,
    sampleSize: cohort.sampleSize,
    cohortTier: cohort.cohortTier,
    ticks,
    inputGameIdsHash,
    metadata: { source: "precompute" },
  });
  return true;
}

/**
 * @param {import('../services/gameDetails').GameDetailsService} gameDetails
 * @param {Array<object>} games
 */
async function loadDetailsBatch(gameDetails, games) {
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
    const map = await gameDetails.findMany(userId, gameIds);
    for (const [gameId, detail] of map) {
      out.set(`${userId}:${gameId}`, detail);
    }
  }
  return out;
}

/** @param {unknown} raw */
function clampTopN(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N;
  return Math.min(Math.floor(n), MAX_TOP_N);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "snapshot.precompute.fatal",
        err: String(err?.message || err),
        stack: err?.stack,
      }),
    );
    process.exit(1);
  });
}

module.exports = {
  main,
  pickTopCohorts,
  refreshOne,
  DEFAULT_TOP_N,
  MAX_TOP_N,
};
