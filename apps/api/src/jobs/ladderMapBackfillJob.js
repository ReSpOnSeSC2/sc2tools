"use strict";

/**
 * One-time ladder-map backfill, run on API startup.
 *
 * New uploads get ``isLadderMap`` stamped at ingest, but games uploaded
 * before that field shipped carry no flag — so the FilterBar's ladder /
 * non-ladder filter silently excludes them. This job classifies those
 * historical games in the background on boot by matching their stored
 * map name against the live ladder pool (1v1 + team), so deployers who
 * only ever merge + auto-deploy don't have to run the standalone
 * migration script by hand.
 *
 * Self-terminating + idempotent:
 *   * It only ever touches games WHERE ``isLadderMap`` is absent, so a
 *     completed dataset means zero work — the cheap pre-count short-
 *     circuits before any pool fetch or scan.
 *   * Once every game has the field, future boots skip immediately.
 *
 * Safety:
 *   * Fire-and-forget — never blocks ``listen``; a failure is logged
 *     and swallowed so a backfill hiccup can't take the API down.
 *   * Refuses to write if the resolved pool is empty (Liquipedia
 *     unreachable AND no cached/seed file) — otherwise it would mark
 *     every historical game non-ladder.
 *   * Soft-disable: ``SC2TOOLS_LADDER_BACKFILL_DISABLED=1``.
 *
 * Mirrors the structure of jobs/ladderMapPoolRefreshJob.js.
 */

const { buildLadderMapSet, isLadderMap } = require("../util/isLadderMap");

const DEFAULT_BATCH = 500;

/**
 * @param {{
 *   db: import('../db/connect').DbContext,
 *   ladderMapPool: { get(): Promise<{ maps: string[], teamMaps?: string[] }> },
 *   logger: import('pino').Logger,
 *   batchSize?: number,
 * }} deps
 */
function buildLadderMapBackfillJob(deps) {
  if (!deps || !deps.db || !deps.db.games) {
    throw new Error("buildLadderMapBackfillJob: db.games required");
  }
  if (!deps.ladderMapPool || typeof deps.ladderMapPool.get !== "function") {
    throw new Error("buildLadderMapBackfillJob: ladderMapPool required");
  }
  if (!deps.logger) {
    throw new Error("buildLadderMapBackfillJob: logger required");
  }
  const disabled = process.env.SC2TOOLS_LADDER_BACKFILL_DISABLED === "1";
  const batchSize = clampBatch(deps.batchSize);
  const logger = deps.logger.child({ component: "ladderMapBackfill" });
  const games = deps.db.games;
  /** @type {Promise<any> | null} */
  let inflight = null;

  /** The query for games that still need classification. */
  const MISSING = { isLadderMap: { $exists: false } };

  async function run() {
    const remaining = await games.countDocuments(MISSING);
    if (remaining === 0) {
      logger.info("ladderMapBackfill_skip_complete");
      return { remaining: 0, scanned: 0, written: 0, skipped: true };
    }
    const pool = await deps.ladderMapPool.get();
    const ladderSet = buildLadderMapSet([
      ...((pool && pool.maps) || []),
      ...((pool && pool.teamMaps) || []),
    ]);
    if (ladderSet.size === 0) {
      logger.warn(
        { remaining },
        "ladderMapBackfill_empty_pool_skip",
      );
      return { remaining, scanned: 0, written: 0, skipped: true };
    }
    // Never classify a full history against the stale hardcoded
    // fallback pool — that would wrongly mark current-ladder games
    // "custom". Wait for a real Liquipedia fetch (or the persisted
    // last-good file); a later boot retries once one is available.
    if (pool.source === "fallback") {
      logger.warn(
        { remaining, ladderKeys: ladderSet.size },
        "ladderMapBackfill_fallback_pool_skip",
      );
      return { remaining, scanned: 0, written: 0, skipped: true };
    }
    logger.info(
      { remaining, poolSource: pool.source, ladderKeys: ladderSet.size },
      "ladderMapBackfill_start",
    );

    const cursor = games.find(MISSING, {
      projection: { _id: 0, userId: 1, gameId: 1, map: 1 },
    });
    /** @type {Array<{ updateOne: { filter: object, update: object } }>} */
    let ops = [];
    let scanned = 0;
    let written = 0;

    const flush = async () => {
      if (ops.length === 0) return;
      const res = await games.bulkWrite(ops, { ordered: false });
      written += res.modifiedCount || 0;
      ops = [];
    };

    for await (const row of cursor) {
      scanned += 1;
      if (typeof row.gameId !== "string" || !row.gameId) continue;
      const flag = isLadderMap(row.map, ladderSet);
      ops.push({
        updateOne: {
          filter: { userId: row.userId, gameId: row.gameId },
          update: { $set: { isLadderMap: flag } },
        },
      });
      if (ops.length >= batchSize) await flush();
    }
    await flush();

    logger.info({ scanned, written }, "ladderMapBackfill_done");
    return { remaining, scanned, written, skipped: false };
  }

  return {
    /** Kick off the backfill in the background. Never throws. */
    start() {
      if (disabled) {
        logger.info("ladderMapBackfill_disabled");
        return;
      }
      if (inflight) return;
      inflight = run()
        .catch((err) => {
          logger.warn(
            { err: err && err.message ? err.message : String(err) },
            "ladderMapBackfill_error",
          );
        })
        .finally(() => {
          inflight = null;
        });
    },
    /** Await a single pass (tests / manual trigger). */
    async runOnce() {
      return run();
    },
    /** Await any in-flight background pass (used on shutdown). */
    async stop() {
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* already logged */
        }
      }
    },
  };
}

/** @param {unknown} raw */
function clampBatch(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH;
  return Math.min(n, 5000);
}

module.exports = { buildLadderMapBackfillJob };
