"use strict";

/**
 * Ladder map pool refresh worker.
 *
 * Calls LadderMapPoolService.refresh({ force: true }) on a fixed
 * interval (default 24h) so the bundled pool stays in sync with
 * Blizzard's Battle.net rotations without requiring a redeploy. Logs
 * the diff (added / removed maps) when the pool actually changes.
 *
 * Modeled on jobs/pulseBackfillJob.js — interval-based setInterval
 * rather than a cron expression so we don't add a node-cron dep, and
 * the same disable knob convention applies.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_LADDER_POOL_REFRESH_DISABLED=1     soft-disable
 *   * SC2TOOLS_LADDER_POOL_REFRESH_INTERVAL_SEC   override 24 h default
 */

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 h floor — Liquipedia is rate-sensitive

/** @param {{ ladderMapPool: any, logger: any, res: any }} args */
function logRefreshOutcome({ logger, res }) {
  if (res.added.length > 0 || res.removed.length > 0) {
    logger.info(
      { added: res.added, removed: res.removed, count: res.maps.length },
      "ladderMapPool_diff",
    );
  } else {
    logger.info({ count: res.maps.length }, "ladderMapPool_unchanged");
  }
}

/**
 * @param {{
 *   ladderMapPool: import('../services/ladderMapPool').LadderMapPoolService,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   runOnStart?: boolean,
 * }} deps
 */
function buildLadderMapPoolRefreshJob(deps) {
  if (!deps || !deps.ladderMapPool) {
    throw new Error("buildLadderMapPoolRefreshJob: ladderMapPool required");
  }
  if (!deps.logger) {
    throw new Error("buildLadderMapPoolRefreshJob: logger required");
  }
  const env = process.env;
  const disabled = env.SC2TOOLS_LADDER_POOL_REFRESH_DISABLED === "1";
  const interval = clamp(
    deps.intervalMs
      || parseSeconds(env.SC2TOOLS_LADDER_POOL_REFRESH_INTERVAL_SEC)
      || DEFAULT_INTERVAL_MS,
  );
  const logger = deps.logger.child({ component: "ladderMapPoolRefresh" });
  // Default true: a fresh container should hit Liquipedia once on boot
  // so we don't rely on a 24h delay to get past the bundled seed file.
  const runOnStart = deps.runOnStart !== false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let started = false;
  /** @type {Promise<void> | null} */
  let inflight = null;

  async function tick() {
    if (inflight) return;
    inflight = (async () => {
      try {
        const res = await deps.ladderMapPool.refresh({ force: true });
        logRefreshOutcome({ ladderMapPool: deps.ladderMapPool, logger, res });
      } catch (err) {
        logger.warn(
          { err: err && err.message ? err.message : String(err) },
          "ladderMapPool_refresh_error",
        );
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    start() {
      if (disabled || started) return;
      started = true;
      logger.info({ intervalMs: interval, runOnStart }, "ladderMapPoolRefresh_started");
      if (runOnStart) tick().catch(() => {});
      timer = setInterval(() => {
        tick().catch(() => {});
      }, interval);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      if (inflight) {
        try { await inflight; } catch { /* best-effort */ }
      }
    },
    async runOnce() { await tick(); },
  };
}

/** @param {string | undefined} v @returns {number | null} */
function parseSeconds(v) {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 1000;
}

/** @param {number} ms */
function clamp(ms) {
  if (ms < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  return ms;
}

module.exports = { buildLadderMapPoolRefreshJob };
