"use strict";
const { observeJob } = require("../util/jobLedger");
const { CustomBuildLibraryService } = require("../services/customBuildLibrary");

/**
 * Nightly purge of the build library's "Recently deleted" trash: builds
 * deleted more than 30 days ago are hard-deleted with their version
 * history (services/customBuildLibrary.js ``purgeExpiredTrash``).
 *
 * Modeled on jobs/reviewDigestJob.js: setInterval, single-flight guard and
 * the same disable-knob convention. Render restarts the process on every
 * deploy, so the first run is shortly after boot and then every 24 hours;
 * the purge is idempotent and index-backed, so an extra run is harmless.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_BUILD_TRASH_PURGE_DISABLED=1   soft-disable
 *   * SC2TOOLS_BUILD_TRASH_PURGE_INTERVAL_SEC override the 24 h interval
 */

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

/**
 * @param {{
 *   jobLedger?: import("../util/jobLedger").JobLedger,
 *   library?: {purgeExpiredTrash(): Promise<{purged: number}>},
 *   db?: import('../db/connect').DbContext,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   firstDelayMs?: number,
 * }} deps
 */
function buildCustomBuildTrashPurgeJob(deps) {
  const found = deps && (deps.library || (deps.db ? new CustomBuildLibraryService(deps.db) : null));
  if (!found) throw new Error("buildCustomBuildTrashPurgeJob: library or db required");
  const library = found;
  if (!deps.logger) throw new Error("buildCustomBuildTrashPurgeJob: logger required");
  const env = process.env;
  const disabled = env.SC2TOOLS_BUILD_TRASH_PURGE_DISABLED === "1";
  const interval = Math.max(
    MIN_INTERVAL_MS,
    deps.intervalMs || parseSeconds(env.SC2TOOLS_BUILD_TRASH_PURGE_INTERVAL_SEC) || DEFAULT_INTERVAL_MS,
  );
  const logger = deps.logger.child({ component: "buildTrashPurge" });
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {NodeJS.Timeout | null} */
  let firstRun = null;
  let started = false;
  /** @type {Promise<void> | null} */
  let inflight = null;

  async function tickWork() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { purged } = await library.purgeExpiredTrash();
        if (purged > 0) logger.info({ purged }, "build_trash_purged");
      } catch (err) {
        tick.failed(err);
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "build_trash_purge_error");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }
  const tick = observeJob(deps, "build-trash-purge", interval, tickWork, {
    disabled,
    envFlag: "SC2TOOLS_BUILD_TRASH_PURGE_DISABLED",
  });

  return {
    start() {
      if (started || disabled) {
        if (disabled) logger.info("build_trash_purge_job_disabled");
        return;
      }
      started = true;
      firstRun = setTimeout(() => void tick(), deps.firstDelayMs ?? FIRST_RUN_DELAY_MS);
      if (typeof firstRun.unref === "function") firstRun.unref();
      timer = setInterval(() => void tick(), interval);
      if (typeof timer.unref === "function") timer.unref();
      logger.info({ intervalMs: interval }, "build_trash_purge_job_started");
    },
    async stop() {
      if (firstRun) clearTimeout(firstRun);
      if (timer) clearInterval(timer);
      firstRun = null;
      timer = null;
      started = false;
      if (inflight) await inflight;
    },
    runOnce: tick,
  };
}

/** @param {string | undefined} raw @returns {number | null} */
function parseSeconds(raw) {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

module.exports = { buildCustomBuildTrashPurgeJob };
