"use strict";

/**
 * Ladder-map (re)classification backfill, run on API startup.
 *
 * Stamps ``isLadderMap`` (+ ``isLadderMapV``, the classifier version) on
 * games that aren't at the CURRENT classifier version — i.e. games that
 * pre-date the field AND games classified by an older version of the
 * logic / map list. Matching uses the all-seasons ladder set
 * (``buildClassifierSet``: the baked-in historical list ∪ the live
 * current pool), so a game on a since-retired ladder map counts as
 * ladder rather than leaking into the Custom bucket.
 *
 * Runs on every boot (so deployers who only merge + auto-deploy never
 * touch a terminal), but version-gated so the work is bounded:
 *   * A cheap pre-count of games not at ``LADDER_CLASSIFY_VERSION``
 *     short-circuits to a no-op once the dataset is fully up to date.
 *   * Bumping ``LADDER_CLASSIFY_VERSION`` (when the map list changes)
 *     makes the next deploy reclassify exactly once, then self-skip.
 *
 * Safety:
 *   * Fire-and-forget — never blocks ``listen``; a failure is logged
 *     and swallowed so a hiccup can't take the API down.
 *   * The classifier set is never empty (the historical list is baked
 *     in), so there's no empty/stale-fallback failure mode.
 *   * Soft-disable: ``SC2TOOLS_LADDER_BACKFILL_DISABLED=1``.
 *
 * Mirrors the structure of jobs/ladderMapPoolRefreshJob.js.
 */

const {
  buildClassifierSet,
  isLadderMap,
  LADDER_CLASSIFY_VERSION,
} = require("../util/isLadderMap");

const DEFAULT_BATCH = 500;

/**
 * @param {{
 *   db: import('../db/connect').DbContext,
 *   ladderMapPool: {
 *     get(): Promise<{ maps: string[], teamMaps?: string[], source: string }>,
 *   },
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

  // Games not yet classified by the current classifier version. ``$ne``
  // also matches docs with no ``isLadderMapV`` at all (never stamped).
  const STALE = { isLadderMapV: { $ne: LADDER_CLASSIFY_VERSION } };

  async function run() {
    const remaining = await games.countDocuments(STALE);
    if (remaining === 0) {
      logger.info({ version: LADDER_CLASSIFY_VERSION }, "ladderMapBackfill_skip_complete");
      return { remaining: 0, scanned: 0, written: 0, skipped: true };
    }
    /** @type {{ maps: string[], teamMaps?: string[], source: string }} */
    let pool = { maps: [], teamMaps: [], source: "unavailable" };
    try {
      pool = await deps.ladderMapPool.get();
    } catch (err) {
      // The baked-in historical list still gives a comprehensive set,
      // so a pool fetch failure is non-fatal — we just miss any map
      // newer than the baked list until a later boot.
      const e = /** @type {{ message?: unknown }} */ (err);
      logger.warn(
        { err: e && e.message ? e.message : String(e) },
        "ladderMapBackfill_pool_unavailable",
      );
    }
    const ladderSet = buildClassifierSet([
      ...((pool && pool.maps) || []),
      ...((pool && pool.teamMaps) || []),
    ]);
    logger.info(
      {
        remaining,
        version: LADDER_CLASSIFY_VERSION,
        poolSource: pool.source,
        ladderKeys: ladderSet.size,
      },
      "ladderMapBackfill_start",
    );

    const cursor = games.find(STALE, {
      projection: { _id: 0, userId: 1, gameId: 1, map: 1, isLadderGame: 1 },
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
      // Prefer the agent's authoritative flag (present on re-ingested
      // games) over the map-name proxy.
      const flag =
        typeof row.isLadderGame === "boolean"
          ? row.isLadderGame
          : isLadderMap(row.map, ladderSet);
      ops.push({
        updateOne: {
          filter: { userId: row.userId, gameId: row.gameId },
          update: {
            $set: { isLadderMap: flag, isLadderMapV: LADDER_CLASSIFY_VERSION },
          },
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
