"use strict";
const { observeJob } = require("../util/jobLedger");

/**
 * Stale-backup alert. Checks the newest Atlas Cloud Backup snapshot every
 * hour and raises one ``backup_stale`` admin notification per UTC day while
 * it is overdue (50 h or older) or missing. See services/backupStatus.js.
 *
 * Modeled on jobs/reviewDigestJob.js: setInterval (no node-cron dep),
 * single-flight guard, unref'd timer. Each tick reuses the service's
 * ten-minute cache, so this adds at most three read-only Atlas calls an
 * hour. Runs only when the Atlas service account is configured.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_BACKUP_ALERT_DISABLED=1       soft-disable
 *   * SC2TOOLS_BACKUP_ALERT_INTERVAL_SEC     override the 1 h check
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
// Let boot-time work settle before the first Atlas call.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

/**
 * @typedef {{
 *   isConfigured(): boolean,
 *   checkAndAlert(): Promise<{ alerted: boolean, reason: string }>,
 * }} BackupAlertSource
 */

/**
 * @param {{
 *   backupStatus: BackupAlertSource,
 *   logger: import('pino').Logger,
 *   jobLedger?: import("../util/jobLedger").JobLedger,
 *   intervalMs?: number,
 *   firstCheckDelayMs?: number,
 * }} deps
 */
function buildBackupHealthJob(deps) {
  if (!deps || !deps.backupStatus) {
    throw new Error("buildBackupHealthJob: backupStatus required");
  }
  if (!deps.logger) throw new Error("buildBackupHealthJob: logger required");
  const env = process.env;
  const disabled = env.SC2TOOLS_BACKUP_ALERT_DISABLED === "1"
    || !deps.backupStatus.isConfigured();
  const interval = Math.max(
    MIN_INTERVAL_MS,
    deps.intervalMs
      || parseSeconds(env.SC2TOOLS_BACKUP_ALERT_INTERVAL_SEC)
      || DEFAULT_INTERVAL_MS,
  );
  const firstDelay = deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS;
  const logger = deps.logger.child({ component: "backupHealth" });
  const check = singleFlightCheck(deps.backupStatus, logger, (error) => tick.failed(error));
  const tick = observeJob(deps, "backup-health", interval, check, { disabled, firstDelayMs: firstDelay, envFlag: "SC2TOOLS_BACKUP_ALERT_DISABLED" });
  /** @type {NodeJS.Timeout[]} */
  let timers = [];

  return {
    start() {
      if (timers.length > 0 || disabled) {
        if (disabled) logger.info("backup_health_job_disabled");
        return;
      }
      timers = [
        setTimeout(() => void tick(), firstDelay),
        setInterval(() => void tick(), interval),
      ];
      for (const timer of timers) timer.unref?.();
      logger.info({ intervalMs: interval }, "backup_health_job_started");
    },
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      await tick.settled();
    },
    runOnce: tick,
  };
}

/**
 * One check at a time; a tick that lands while one is running joins it.
 * Failures are logged, never thrown, so a timer can't crash the process.
 *
 * @param {BackupAlertSource} backupStatus
 * @param {import('pino').Logger} logger
 * @param {(error:unknown)=>void} onError
 */
function singleFlightCheck(backupStatus, logger, onError) {
  /** @type {Promise<void> | null} */
  let inflight = null;
  const tick = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await backupStatus.checkAndAlert();
        if (result.alerted) {
          logger.warn({ reason: result.reason }, "backup_stale_alert_raised");
        }
      } catch (err) {
        onError(err);
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "backup_health_check_error",
        );
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  tick.settled = async () => {
    if (inflight) await inflight;
  };
  return tick;
}

/** @param {string | undefined} raw @returns {number | null} */
function parseSeconds(raw) {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

module.exports = { buildBackupHealthJob };
