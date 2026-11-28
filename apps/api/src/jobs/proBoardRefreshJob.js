"use strict";
const { observeJob } = require("../util/jobLedger");

/**
 * Pros board refresh worker: the only thing that reaches SC2Pulse for the
 * board, on a fixed timer, so no visitor ever triggers a provider call.
 * `ProBoardService.refresh()` is bounded (one teams call plus a few pro
 * histories) and the shared SC2Pulse pace spaces its calls. The worker does
 * nothing while the board's gate is off.
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {{
 *   jobLedger?: import("../util/jobLedger").JobLedger,
 *   proBoard: import("../services/proBoard").ProBoardService,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 * }} deps
 */
function buildProBoardRefreshJob(deps) {
  if (!deps?.proBoard) throw new Error("buildProBoardRefreshJob: proBoard required");
  if (!deps.logger) throw new Error("buildProBoardRefreshJob: logger required");
  const logger = deps.logger.child({ component: "proBoardRefresh" });
  const interval = deps.intervalMs || REFRESH_INTERVAL_MS;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inflight = null;

  async function tickWork() {
    if (inflight) return;
    inflight = (async () => {
      try {
        await deps.proBoard.refresh();
      } catch (err) {
        tick.failed(err);
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "proBoard_refresh_error");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }
  const tick = observeJob(deps, "pro-board", interval, tickWork, { disabled: !deps.proBoard.isOpen() });

  return {
    start() {
      if (timer || !deps.proBoard.isOpen()) return;
      logger.info({ intervalMs: interval }, "proBoardRefresh_started");
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, interval);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (inflight) await inflight;
    },
  };
}

module.exports = { buildProBoardRefreshJob, REFRESH_INTERVAL_MS };
