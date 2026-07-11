"use strict";

/**
 * Ladder-meta recompute worker.
 *
 * Rebuilds the ``ladder_meta`` aggregate tables (see
 * services/ladderMeta.js) on a fixed interval so the public Ladder Meta
 * Radar ("which openers actually win, by league band + matchup, with
 * week-over-week movement") stays current as games flow in. A full
 * rebuild is one aggregation pass over slim game rows — cheap enough to
 * run daily without coordination.
 *
 * Modeled on jobs/leaguePercentilesRecomputeJob.js: setInterval (no
 * node-cron dep), single-flight guard, same disable-knob convention.
 * Single-instance safe by deployment (render.yaml pins one instance);
 * recompute itself is idempotent either way.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_LADDER_META_RECOMPUTE_DISABLED=1     soft-disable
 *   * SC2TOOLS_LADDER_META_RECOMPUTE_INTERVAL_SEC   override 24 h default
 */

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000; // hourly floor — it's a full scan

/**
 * @param {{
 *   ladderMeta: import('../services/ladderMeta').LadderMetaService,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   runOnStart?: boolean,
 * }} deps
 */
function buildLadderMetaRecomputeJob(deps) {
  if (!deps || !deps.ladderMeta) {
    throw new Error("buildLadderMetaRecomputeJob: ladderMeta required");
  }
  if (!deps.logger) {
    throw new Error("buildLadderMetaRecomputeJob: logger required");
  }
  const env = process.env;
  const disabled = env.SC2TOOLS_LADDER_META_RECOMPUTE_DISABLED === "1";
  const interval = clamp(
    deps.intervalMs
      || parseSeconds(env.SC2TOOLS_LADDER_META_RECOMPUTE_INTERVAL_SEC)
      || DEFAULT_INTERVAL_MS,
  );
  const logger = deps.logger.child({ component: "ladderMeta" });
  // Default true: a fresh deploy should serve the meta report immediately
  // rather than waiting a day for the first table.
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
        const res = await deps.ladderMeta.recompute();
        logger.info({ bands: res.bands }, "ladder_meta_recomputed");
      } catch (err) {
        logger.warn(
          { err: err && err.message ? err.message : String(err) },
          "ladder_meta_recompute_error",
        );
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  }

  return {
    start() {
      if (started || disabled) {
        if (disabled) logger.info("ladder_meta_job_disabled");
        return;
      }
      started = true;
      if (runOnStart) void tick();
      timer = setInterval(() => void tick(), interval);
      if (typeof timer.unref === "function") timer.unref();
      logger.info({ intervalMs: interval }, "ladder_meta_job_started");
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      if (inflight) await inflight;
    },
  };
}

/** @param {string | undefined} raw @returns {number | null} */
function parseSeconds(raw) {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/** @param {number} ms */
function clamp(ms) {
  return Math.max(MIN_INTERVAL_MS, ms);
}

module.exports = { buildLadderMetaRecomputeJob };
