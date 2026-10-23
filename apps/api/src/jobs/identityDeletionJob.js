"use strict";

/** Retry durable identity deletions through the service's renewable jobLock.
 * Uses existing process timers; no scheduler/infrastructure is added.
 * @param {{service:import('../services/identityDeletions').IdentityDeletionsService, logger:import('pino').Logger, intervalMs?:number}} deps */
function buildIdentityDeletionJob(deps) {
  /** @type {NodeJS.Timeout|null} */ let timer = null;
  /** @type {Promise<void>|null} */ let active = null;
  const runOnce = () => {
    if (active) return active;
    active = deps.service.sweep().then(() => {}).catch(() => { deps.logger.warn({ code: "identity_retry_failed" }, "identity_deletion_sweep_failed"); }).finally(() => { active = null; });
    return active;
  };
  return {
    start() { if (!timer) { void runOnce(); timer = setInterval(() => void runOnce(), deps.intervalMs || 60_000); timer.unref?.(); } },
    async stop() { if (timer) clearInterval(timer); timer = null; await active; },
    runOnce,
  };
}
module.exports = { buildIdentityDeletionJob };
