"use strict";

// ADR 0072's overlap guard for the default-off chart cache. Every entry point is a no-op unless the cache is enabled.
// - Shutdown-start retirement: at SIGTERM, before the first await, stop serving and storing retained bodies.
// - Admission-time quarantine: from listen until QUARANTINE_MS has passed, retain nothing, so requests get uncached
//   200 private, no-store responses. The first request admitted after it ends runs one full local retirement of inner
//   joins and reuse before its snapshot, without retiring tokens or the epoch, so no admitted request is refused.
// - Startup cohort record: one log line with the revision, the flag, the writer-set version and the quarantine end.

/** The predecessor's assumed 300-second shutdown bound, plus 120 s for this process to pass its health check and for
 * the platform to signal the predecessor (ADR 0072, Follow-on guard). An activation receipt must observe both. */
const QUARANTINE_MS = 420000;
/** Names the in-process writer set (`gameWrite` and `UserRevision.run` placements) this cohort runs. Bump it in the same
 * pull request as any change to a covered input's writers, so a receipt can tell cohorts with different writers apart. */
const WRITER_SET_VERSION = "2026-10-30.1";

/** @param {import('./userCache').UserCache|null|undefined} cache */
function beginChartCacheShutdown(cache) {
  if (!cache?.enabled || cache.closing) return;
  cache.closing = true;
  cache.invalidateForUser(null);
}

/** @param {import('./userCache').UserCache|null|undefined} cache @param {any} logger @param {number} [ms] */
function startChartCacheQuarantine(cache, logger, ms = QUARANTINE_MS) {
  if (!cache?.enabled) return;
  cache.quarantineUntil = cache.now() + ms; cache.quarantineEnded = false;
  try {
    const source = process.env.RENDER_GIT_COMMIT || "";
    logger?.info?.({ sourceRevision: /^[a-f\d]{40}$/i.test(source) ? source : null, userCacheEnabled: true,
      writerSetVersion: WRITER_SET_VERSION, quarantineMs: ms, quarantineEndsAt: new Date(Date.now() + ms).toISOString() },
    "chart_cache_cohort_start");
  } catch { /* The record is diagnostic and never fails boot. */ }
}

/** Whether a request admitted now, before its snapshot, may use a retained key.
 * @param {import('./userCache').UserCache} cache */
function retentionOpen(cache) {
  if (cache.closing) return false;
  if (cache.quarantineEnded) return true;
  if (cache.now() < cache.quarantineUntil) return false;
  cache.quarantineEnded = true;
  for (const callback of cache.revisions.invalidators) {
    try { callback(null); } catch { cache.revisions.poisoned = true; cache.revisions.counters.revision_failure += 1; }
  }
  return true;
}

module.exports = { beginChartCacheShutdown, startChartCacheQuarantine, retentionOpen, QUARANTINE_MS, WRITER_SET_VERSION };
