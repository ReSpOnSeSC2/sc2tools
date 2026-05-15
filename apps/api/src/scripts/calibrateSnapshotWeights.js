#!/usr/bin/env node
"use strict";

/**
 * CLI runner for SnapshotCalibrateService.
 *
 *   node scripts/calibrateSnapshotWeights.js \
 *        --matchup=PvZ --mmrBucket=Diamond [--writeWeights]
 *
 * Pulls every cohort game (with known result) from Mongo for the
 * requested (matchup, mmrBucket), builds per-tick score vectors via
 * SnapshotCompareService against the cached cohort bands, fits ridge
 * + partial correlation per phase, prints a report, and OPTIONALLY
 * updates ``snapshotWeights.json`` if the sanity gate passes.
 *
 * Sanity gate: any single weight that would move >±0.10 from its
 * current value blocks the write — the recommended weights are
 * instead written to ``snapshotWeights.recommended.json`` for a
 * human to review.
 */

const path = require("path");
const fs = require("fs");
const { connect } = require("../db/connect");
const { loadConfig } = require("../config/loader");
const { buildStoreFromConfig } = require("../services/gameDetailsStore");
const { GameDetailsService } = require("../services/gameDetails");
const { SnapshotCohortService } = require("../services/snapshotCohort");
const { SnapshotCacheService } = require("../services/snapshotCache");
const { SnapshotCompareService } = require("../services/snapshotCompare");
const { SnapshotCalibrateService } = require("../services/snapshotCalibrate");
const {
  loadWeights,
  writeWeights,
  DEFAULT_PATH,
  PHASE_NAMES,
} = require("../services/snapshotWeights");

const SIDECAR_PATH = path.join(path.dirname(DEFAULT_PATH), "snapshotWeights.recommended.json");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.matchup) {
    fail("--matchup is required (e.g. PvZ)");
  }
  const cfg = loadConfig();
  const db = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDbName });
  const store = buildStoreFromConfig({
    db,
    config: { gameDetailsStore: cfg.gameDetailsStore, r2: cfg.r2 },
  });
  const gameDetails = new GameDetailsService(store);
  const cohort = new SnapshotCohortService(db, { gameDetails });
  const cache = new SnapshotCacheService(db);
  const compare = new SnapshotCompareService();
  const calibrate = new SnapshotCalibrateService();
  const matchup = parseMatchupArg(args.matchup);
  if (!matchup) fail(`invalid --matchup: ${args.matchup}`);
  const resolved = await cohort.resolveCohort({
    scope: "community",
    myRace: matchup.my,
    oppRace: matchup.opp,
    mmrBucket: args.mmrBucket ? Number(args.mmrBucket) : undefined,
  });
  if (resolved.tooSmall) {
    fail(`cohort too small for ${args.matchup}: ${resolved.sampleSize} games`);
  }
  console.log(
    JSON.stringify({
      level: "info",
      msg: "calibrate.start",
      matchup: args.matchup,
      mmrBucket: args.mmrBucket,
      cohortTier: resolved.cohortTier,
      sampleSize: resolved.sampleSize,
    }),
  );
  const bands = await cohort.aggregateBands(resolved.games);
  const detailsByGameId = await loadDetailsBatch(gameDetails, resolved.games);
  const games = [];
  for (const game of resolved.games) {
    const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
    if (!detail) continue;
    const tickScores = compare.compareGameToCohort(detail, { ticks: bands.ticks }, {
      myRace: game.myRace,
      oppRace: game.opponent?.race,
    });
    games.push({ result: game.result, tickScores });
  }
  const report = calibrate.calibrate(games);
  printReport(report);
  if (args.writeWeights) {
    const current = loadWeights();
    let blocked = false;
    /** @type {Record<string, any>} */
    const nextPhases = { ...current.phases };
    for (const phase of PHASE_NAMES) {
      const p = report.perPhase[phase];
      if (p.skipped) continue;
      if (!p.sanityGate.passed) {
        blocked = true;
        continue;
      }
      nextPhases[phase] = {
        ...current.phases[phase],
        weights: p.recommendedWeights,
      };
    }
    if (blocked) {
      const sidecar = { ...current, phases: nextPhases, version: current.version };
      fs.writeFileSync(SIDECAR_PATH, JSON.stringify(sidecar, null, 2));
      console.log(JSON.stringify({
        level: "warn",
        msg: "calibrate.gate_tripped",
        sidecar: SIDECAR_PATH,
      }));
    } else {
      const bumped = writeWeights(DEFAULT_PATH, { ...current, phases: nextPhases });
      console.log(JSON.stringify({
        level: "info",
        msg: "calibrate.weights_written",
        version: bumped.version,
        path: DEFAULT_PATH,
      }));
    }
  }
  await db.close();
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

function printReport(report) {
  console.log("\n=== Snapshot weights calibration report ===");
  for (const phase of PHASE_NAMES) {
    const p = report.perPhase[phase];
    console.log(`\n[${phase}]`);
    if (p.skipped) {
      console.log(`  skipped: ${p.reason} (samples=${p.sampleSize})`);
      continue;
    }
    console.log(`  samples: ${p.sampleSize}  R²: ${p.r2.toFixed(4)}`);
    console.log("  metric            current  recommended  partial-r   coefficient");
    for (const k of Object.keys(p.currentWeights)) {
      const cur = p.currentWeights[k];
      const rec = p.recommendedWeights[k];
      const pr = p.partials[k] || 0;
      const co = p.coefficients[k] || 0;
      console.log(`  ${k.padEnd(18)} ${cur.toFixed(3)}    ${rec.toFixed(3)}        ${pr.toFixed(3)}      ${co.toFixed(3)}`);
    }
    if (!p.sanityGate.passed) {
      console.log("  GATE TRIPPED:");
      for (const v of p.sanityGate.violations) {
        console.log(`    ${v.metric}: ${v.currentValue} → ${v.nextValue} (Δ=${v.delta.toFixed(3)})`);
      }
    }
  }
}

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function parseMatchupArg(raw) {
  const m = String(raw || "").toUpperCase().match(/^([PTZ])V([PTZ])$/);
  if (!m) return null;
  return { my: m[1], opp: m[2] };
}

function fail(msg) {
  console.error(JSON.stringify({ level: "error", msg }));
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: "calibrate.fatal",
        err: String(err?.message || err),
        stack: err?.stack,
      }),
    );
    process.exit(1);
  });
}

module.exports = { main };
