"use strict";

const { isoWeekStart } = require("../services/reviewerReputation");

/**
 * Replay Review Exchange weekly digest — "N open requests in your
 * matchups at your level" (docs/reviews.md).
 *
 * Modeled on jobs/leaguePercentilesRecomputeJob.js: setInterval (no
 * node-cron dep), single-flight guard, same disable-knob convention.
 * Render restarts the process on every deploy, so a 7-day interval would
 * rarely fire: the job instead ticks hourly and sends once the week's
 * slot (Monday 15:00 UTC) has passed. ``sendWeeklyDigest`` claims each
 * reviewer per ISO week with a conditional update, so catch-up after
 * downtime and a brief two-instance overlap during a deploy are both
 * harmless.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_REVIEW_DIGEST_DISABLED=1      soft-disable
 *   * SC2TOOLS_REVIEW_DIGEST_INTERVAL_SEC    override the 1 h check
 * Runs only when REVIEWS_ENABLED=on.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const SEND_HOUR_UTC = 15;

/**
 * @param {{
 *   reviews: {sendWeeklyDigest(opts: {weekKey: string}): Promise<{notified: number}>},
 *   logger: import('pino').Logger,
 *   enabled: boolean,
 *   intervalMs?: number,
 *   nowFn?: () => number,
 * }} deps
 */
function buildReviewDigestJob(deps) {
  if (!deps || !deps.reviews) throw new Error("buildReviewDigestJob: reviews required");
  if (!deps.logger) throw new Error("buildReviewDigestJob: logger required");
  const env = process.env;
  const disabled = !deps.enabled || env.SC2TOOLS_REVIEW_DIGEST_DISABLED === "1";
  const interval = Math.max(
    MIN_INTERVAL_MS,
    deps.intervalMs || parseSeconds(env.SC2TOOLS_REVIEW_DIGEST_INTERVAL_SEC) || DEFAULT_INTERVAL_MS,
  );
  const now = deps.nowFn || (() => Date.now());
  const logger = deps.logger.child({ component: "reviewDigest" });
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let started = false;
  /** @type {Promise<void> | null} */
  let inflight = null;

  async function tick() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const at = new Date(now());
        if (!isPastSendSlot(at)) return;
        const weekKey = isoWeekStart(at).toISOString().slice(0, 10);
        const res = await deps.reviews.sendWeeklyDigest({ weekKey });
        if (res.notified > 0) logger.info({ weekKey, notified: res.notified }, "review_digest_sent");
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "review_digest_error",
        );
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    start() {
      if (started || disabled) {
        if (disabled) logger.info("review_digest_job_disabled");
        return;
      }
      started = true;
      void tick();
      timer = setInterval(() => void tick(), interval);
      if (typeof timer.unref === "function") timer.unref();
      logger.info({ intervalMs: interval }, "review_digest_job_started");
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      if (inflight) await inflight;
    },
    runOnce: tick,
  };
}

/**
 * True from Monday SEND_HOUR_UTC until the end of the ISO week.
 *
 * @param {Date} at
 */
function isPastSendSlot(at) {
  const weekday = (at.getUTCDay() + 6) % 7; // Monday = 0
  return weekday > 0 || at.getUTCHours() >= SEND_HOUR_UTC;
}

/** @param {string | undefined} raw @returns {number | null} */
function parseSeconds(raw) {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

module.exports = { buildReviewDigestJob, isPastSendSlot };
