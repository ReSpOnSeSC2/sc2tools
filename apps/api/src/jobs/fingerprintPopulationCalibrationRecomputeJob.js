"use strict";

/**
 * Nightly rebuild for player-level fingerprint population calibration.
 *
 * Wiring is intentionally separate from the service so app/server integration
 * can land independently. The job is single-flight and the recompute itself is
 * idempotent.
 *
 * Environment controls:
 *   SC2TOOLS_FINGERPRINT_CALIBRATION_RECOMPUTE_DISABLED=1
 *   SC2TOOLS_FINGERPRINT_CALIBRATION_RECOMPUTE_INTERVAL_SEC=<seconds>
 */

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {{
 *   calibration: { recompute: () => Promise<Record<string, any>> },
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   runOnStart?: boolean,
 * }} deps
 */
function buildFingerprintPopulationCalibrationRecomputeJob(deps) {
  if (!deps || !deps.calibration) {
    throw new Error(
      "buildFingerprintPopulationCalibrationRecomputeJob: calibration required",
    );
  }
  if (!deps.logger) {
    throw new Error(
      "buildFingerprintPopulationCalibrationRecomputeJob: logger required",
    );
  }

  const disabled =
    process.env.SC2TOOLS_FINGERPRINT_CALIBRATION_RECOMPUTE_DISABLED === "1";
  const intervalMs = clampInterval(
    deps.intervalMs ||
      parseSeconds(
        process.env.SC2TOOLS_FINGERPRINT_CALIBRATION_RECOMPUTE_INTERVAL_SEC,
      ) ||
      DEFAULT_INTERVAL_MS,
  );
  const runOnStart = deps.runOnStart !== false;
  const logger = deps.logger.child({
    component: "fingerprintPopulationCalibration",
  });
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  let started = false;

  async function tick() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await deps.calibration.recompute();
        logger.info(
          {
            matchups: result && result.matchups,
            playerMatchupWindows: result && result.playerMatchupWindows,
          },
          "fingerprint_population_calibration_recomputed",
        );
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "fingerprint_population_calibration_recompute_error",
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
        if (disabled) {
          logger.info(
            "fingerprint_population_calibration_recompute_job_disabled",
          );
        }
        return;
      }
      started = true;
      if (runOnStart) void tick();
      timer = setInterval(() => void tick(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      logger.info(
        { intervalMs },
        "fingerprint_population_calibration_recompute_job_started",
      );
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
      if (inflight) await inflight;
    },
    tick,
  };
}

/** @param {string | undefined} raw @returns {number | null} */
function parseSeconds(raw) {
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** @param {number} value @returns {number} */
function clampInterval(value) {
  return Math.max(MIN_INTERVAL_MS, value);
}

module.exports = {
  buildFingerprintPopulationCalibrationRecomputeJob,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
};
