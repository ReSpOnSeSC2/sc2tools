"use strict";

/**
 * Guide videos sync worker.
 *
 * Keeps `guide_videos` (services/guideVideos.js) current with the site
 * owner's YouTube channel: on start it seeds the committed channel
 * snapshot (insert-only) and pulls the channel's public Atom feed, then
 * re-pulls the feed on a fixed interval. The feed lists the newest 15
 * videos and the sync never deletes, so older videos stay.
 *
 * Modeled on jobs/ladderMetaRecomputeJob.js: setInterval (no node-cron
 * dep), unref'd timer, single-flight guard, same disable-knob convention.
 * Failures (YouTube down, timeout, oversize feed, Mongo error) are logged
 * at warn with a reason code only — never a URL or provider body — and
 * never stop the job; the next tick retries.
 *
 * Wiring: built in app.js makeServices as `services.guideVideosJob` (not
 * started there); server.js starts it only when GUIDES_ENABLED and a
 * channel id (GUIDES_YOUTUBE_CHANNEL_ID) are configured, and stops it on
 * shutdown.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_GUIDE_VIDEOS_DISABLED=1          soft-disable
 *   * SC2TOOLS_GUIDE_VIDEOS_INTERVAL_SEC        override the 6 h default
 *                                              (floor 15 min)
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 15 * 60 * 1000;
const MS_PER_SEC = 1000;
/** Error codes worth logging verbatim ("feed_http_503", "NetworkTimeout"). */
const SAFE_CODE_RE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * @typedef {object} GuideVideosSyncSummary
 * @property {{ inserted: number } | null} snapshot null when not run or failed
 * @property {{ fetched: number, inserted: number, updated: number } | null} sync null when failed
 * @property {string|null} error reason code of the first failure
 */

/**
 * @typedef {object} GuideVideosSyncTarget
 * @property {() => boolean} isConfigured
 * @property {() => Promise<{ inserted: number }>} ensureSnapshot
 * @property {() => Promise<{ fetched: number, inserted: number, updated: number }>} syncFromChannel
 */

/**
 * A log-safe reason code for an error.
 *
 * @param {unknown} err
 * @returns {string}
 */
function reasonCode(err) {
  const e = /** @type {any} */ (err);
  if (e && typeof e.code === "string" && SAFE_CODE_RE.test(e.code)) return e.code;
  if (e && typeof e.codeName === "string" && SAFE_CODE_RE.test(e.codeName)) return e.codeName;
  return "error";
}

/**
 * @param {string|undefined} raw seconds
 * @returns {number|null} milliseconds
 */
function parseSeconds(raw) {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * MS_PER_SEC : null;
}

/**
 * Single-flight sync runner: seeds the snapshot until that succeeds once,
 * then pulls the feed. Never rejects; failures become warn logs.
 *
 * @param {GuideVideosSyncTarget} videos
 * @param {import('pino').Logger} logger
 * @returns {{ runOnce: () => Promise<GuideVideosSyncSummary>, inflight: () => Promise<GuideVideosSyncSummary> | null }}
 */
function buildSyncRunner(videos, logger) {
  let seeded = false;
  /** @type {Promise<GuideVideosSyncSummary> | null} */
  let current = null;

  /** @returns {Promise<GuideVideosSyncSummary>} */
  async function syncOnce() {
    /** @type {GuideVideosSyncSummary} */
    const summary = { snapshot: null, sync: null, error: null };
    if (!seeded) {
      try {
        summary.snapshot = await videos.ensureSnapshot();
        seeded = true;
      } catch (err) {
        summary.error = reasonCode(err);
        logger.warn({ code: summary.error }, "guide_videos_snapshot_error");
      }
    }
    try {
      summary.sync = await videos.syncFromChannel();
      logger.info({ ...summary.sync, seeded: summary.snapshot?.inserted ?? 0 }, "guide_videos_synced");
    } catch (err) {
      const code = reasonCode(err);
      summary.error = summary.error || code;
      logger.warn({ code }, "guide_videos_sync_error");
    }
    return summary;
  }

  return {
    runOnce() {
      if (!current) {
        current = syncOnce().finally(() => {
          current = null;
        });
      }
      return current;
    },
    inflight: () => current,
  };
}

/**
 * @param {{
 *   guideVideos: GuideVideosSyncTarget,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} deps
 * @returns {{
 *   start: () => void,
 *   stop: () => Promise<void>,
 *   runOnce: () => Promise<GuideVideosSyncSummary>,
 *   isRunning: () => boolean,
 * }}
 */
function buildGuideVideosSyncJob(deps) {
  if (!deps || !deps.guideVideos) throw new Error("buildGuideVideosSyncJob: guideVideos required");
  if (!deps.logger) throw new Error("buildGuideVideosSyncJob: logger required");
  const env = deps.env || process.env;
  const disabled = env.SC2TOOLS_GUIDE_VIDEOS_DISABLED === "1";
  const interval = Math.max(
    MIN_INTERVAL_MS,
    deps.intervalMs || parseSeconds(env.SC2TOOLS_GUIDE_VIDEOS_INTERVAL_SEC) || DEFAULT_INTERVAL_MS,
  );
  const logger = deps.logger.child({ component: "guideVideosJob" });
  const videos = deps.guideVideos;
  const runner = buildSyncRunner(videos, logger);
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let started = false;

  return {
    start() {
      if (started) return;
      if (disabled || !videos.isConfigured()) {
        logger.info({ reason: disabled ? "disabled" : "no_channel" }, "guide_videos_job_not_started");
        return;
      }
      started = true;
      void runner.runOnce();
      timer = setInterval(() => void runner.runOnce(), interval);
      if (typeof timer.unref === "function") timer.unref();
      logger.info({ intervalMs: interval }, "guide_videos_job_started");
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      const pending = runner.inflight();
      if (pending) await pending;
    },
    runOnce: runner.runOnce,
    isRunning() {
      return started;
    },
  };
}

module.exports = { buildGuideVideosSyncJob, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS };
