#!/usr/bin/env node
"use strict";

/**
 * Nightly precompute job for ``snapshot_matrices``.
 *
 * Walks the top-N (matchup, mmrBucket) pairs by recent query
 * volume and rebuilds the composition matchup matrix at a fixed
 * set of "anchor" ticks (3:00, 5:00, 7:00, 10:00, 13:00, 16:00)
 * so the cohort browser's matrix tab and the per-game drilldown
 * both hit a warm cache for the common ticks.
 *
 * Same pattern as ``precomputeSnapshotCohorts.js`` — idempotent
 * upsert, skip cohorts under the k-anon floor, emit one structured
 * log line per (matchup × tick) refresh.
 */

const crypto = require("crypto");
const { connect } = require("../db/connect");
const { loadConfig } = require("../config/loader");
const { buildStoreFromConfig } = require("../services/gameDetailsStore");
const { GameDetailsService } = require("../services/gameDetails");
const { SnapshotCohortService } = require("../services/snapshotCohort");
const { SnapshotMatchupMatrixService } = require("../services/snapshotMatchupMatrix");

const ANCHOR_TICKS = [180, 300, 420, 600, 780, 960];
const DEFAULT_TOP_N = 30;
const MAX_TOP_N = 200;
const TTL_MS = 24 * 60 * 60 * 1000;
const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];

async function main() {
  const cfg = loadConfig();
  const db = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDbName });
  const store = buildStoreFromConfig({
    db,
    config: { gameDetailsStore: cfg.gameDetailsStore, r2: cfg.r2 },
  });
  const gameDetails = new GameDetailsService(store);
  const cohort = new SnapshotCohortService(db, { gameDetails });
  const matrix = new SnapshotMatchupMatrixService();
  const topN = clampTopN(process.env.SNAPSHOT_MATRIX_TOP_N);
  const targets = await pickTopMatchups(db, topN);
  console.log(JSON.stringify({
    level: "info",
    msg: "matrix.precompute.start",
    topN,
    targetCount: targets.length,
  }));
  let refreshed = 0;
  let skipped = 0;
  for (const target of targets) {
    for (const tick of ANCHOR_TICKS) {
      try {
        const ok = await refreshOne(target, tick, { cohort, matrix, gameDetails, db });
        if (ok) refreshed += 1;
        else skipped += 1;
      } catch (err) {
        console.error(JSON.stringify({
          level: "error",
          msg: "matrix.precompute.error",
          target,
          tick,
          err: String(err?.message || err),
        }));
      }
    }
  }
  console.log(JSON.stringify({
    level: "info",
    msg: "matrix.precompute.done",
    refreshed,
    skipped,
    totalAttempts: targets.length * ANCHOR_TICKS.length,
  }));
  await db.close();
}

async function pickTopMatchups(db, topN) {
  const rows = await db.games
    .aggregate([
      {
        $match: {
          myRace: { $type: "string" },
          "opponent.race": { $type: "string" },
        },
      },
      {
        $group: {
          _id: {
            myRace: { $substrCP: ["$myRace", 0, 1] },
            oppRace: { $substrCP: ["$opponent.race", 0, 1] },
          },
          gameCount: { $sum: 1 },
        },
      },
      { $match: { gameCount: { $gte: 8 } } },
      { $sort: { gameCount: -1 } },
      { $limit: topN },
    ])
    .toArray();
  return rows
    .map((r) => `${r._id.myRace}v${r._id.oppRace}`)
    .filter((m) => MATCHUPS.includes(m));
}

async function refreshOne(matchup, tickSec, services) {
  const parsed = matchup.match(/^([PTZ])v([PTZ])$/);
  if (!parsed) return false;
  const resolved = await services.cohort.resolveCohort({
    scope: "community",
    myRace: parsed[1],
    oppRace: parsed[2],
  });
  if (resolved.tooSmall) return false;
  const detailsByGameId = await loadDetailsBatch(services.gameDetails, resolved.games);
  const built = services.matrix.buildMatrix(resolved.games, detailsByGameId, tickSec);
  const ids = resolved.games.map((g) => g.gameId);
  const inputGameIdsHash = hashIds(ids);
  const hash = crypto
    .createHash("sha256")
    .update(`${matchup}|community|${tickSec}|${inputGameIdsHash}`)
    .digest("hex");
  const now = new Date();
  await services.db.snapshotMatrices.findOneAndUpdate(
    { _id: hash },
    {
      $set: {
        _id: hash,
        matchup,
        mmrBucket: null,
        scope: "community",
        tickSec,
        cohortTier: resolved.cohortTier,
        sampleSize: resolved.sampleSize,
        matrix: built,
        inputGameIdsHash,
        generatedAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return true;
}

async function loadDetailsBatch(gameDetails, games) {
  const byUser = new Map();
  for (const g of games) {
    let arr = byUser.get(g.userId);
    if (!arr) {
      arr = [];
      byUser.set(g.userId, arr);
    }
    arr.push(g.gameId);
  }
  const out = new Map();
  for (const [userId, gameIds] of byUser) {
    const map = await gameDetails.findMany(userId, gameIds);
    for (const [gameId, detail] of map) out.set(`${userId}:${gameId}`, detail);
  }
  return out;
}

function hashIds(ids) {
  const sorted = [...ids].sort();
  const h = crypto.createHash("sha256");
  for (const id of sorted) {
    h.update(id);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function clampTopN(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N;
  return Math.min(Math.floor(n), MAX_TOP_N);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({
      level: "fatal",
      msg: "matrix.precompute.fatal",
      err: String(err?.message || err),
      stack: err?.stack,
    }));
    process.exit(1);
  });
}

module.exports = {
  main,
  refreshOne,
  pickTopMatchups,
  ANCHOR_TICKS,
};
