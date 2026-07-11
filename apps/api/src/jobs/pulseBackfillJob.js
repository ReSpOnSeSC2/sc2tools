"use strict";

/**
 * Pulse-character-id backfill cron.
 *
 * Periodically heals opponents rows whose ``toonHandle`` is set but
 * whose ``pulseCharacterId`` never landed (typically because
 * SC2Pulse was unreachable / rate-limited at first ingest). For
 * each user with at least one stuck row we call
 * ``OpponentsService.backfillPulseCharacterId(userId, { limit })``,
 * which in turn drives the real cloud-side pulse resolver.
 *
 * Single-instance-safe: claims a Mongo advisory lock document in
 * the ``jobLocks`` collection (TTL'd just under the cycle interval)
 * so two API replicas can't double-fire. The lock collection
 * carries a TTL index on ``expiresAt`` so a crashed replica's lock
 * is reclaimed automatically.
 *
 * Disable knobs (env):
 *   * SC2TOOLS_PULSE_BACKFILL_DISABLED=1     soft-disable
 *   * SC2TOOLS_PULSE_BACKFILL_INTERVAL_SEC   override 15 m default
 *   * SC2TOOLS_PULSE_BACKFILL_USER_LIMIT     per-user row cap
 *   * SC2TOOLS_PULSE_BACKFILL_USERS_PER_TICK how many users one
 *                                            tick processes
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_USER_LIMIT = 25;
const DEFAULT_USERS_PER_TICK = 25;
const LOCK_KEY = "pulseBackfill";
const LOCK_COLLECTION = "jobLocks";
// Lock TTL must be slightly shorter than the cycle interval so a
// crashed replica's lock is reclaimed in time for the next tick,
// but long enough to outlive a normal cycle's actual work.
const LOCK_LEAD_MS = 60 * 1000;

/**
 * @param {{
 *   db: import('../db/connect').DbContext,
 *   opponents: import('../services/opponents').OpponentsService,
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   nowFn?: () => number,
 * }} deps
 */
function buildPulseBackfillJob(deps) {
  if (!deps || !deps.db) throw new Error("buildPulseBackfillJob: db required");
  if (!deps.opponents) throw new Error("buildPulseBackfillJob: opponents required");
  if (!deps.logger) throw new Error("buildPulseBackfillJob: logger required");

  const env = process.env;
  const disabled = env.SC2TOOLS_PULSE_BACKFILL_DISABLED === "1";
  const intervalMs = clampInterval(
    deps.intervalMs
      || parseSeconds(env.SC2TOOLS_PULSE_BACKFILL_INTERVAL_SEC)
      || DEFAULT_INTERVAL_MS,
  );
  const userLimit = parsePositiveInt(
    env.SC2TOOLS_PULSE_BACKFILL_USER_LIMIT,
    DEFAULT_USER_LIMIT,
  );
  const usersPerTick = parsePositiveInt(
    env.SC2TOOLS_PULSE_BACKFILL_USERS_PER_TICK,
    DEFAULT_USERS_PER_TICK,
  );
  const logger = deps.logger.child({ component: "pulseBackfillJob" });
  const lockCollection = deps.db.db.collection(LOCK_COLLECTION);
  const opponents = deps.db.opponents;
  const now = deps.nowFn || (() => Date.now());

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<TickResult|null> | null} */
  let inFlight = null;
  let started = false;

  /**
   * @typedef {{
   *   ranAsLeader: boolean,
   *   users: number,
   *   scanned: number,
   *   resolved: number,
   *   updated: number,
   *   skipped: number,
   *   elapsedMs: number,
   * }} TickResult
   */

  async function ensureLockIndex() {
    // TTL index: Mongo's reaper drops the doc when ``expiresAt``
    // passes, so a crashed lock-holder doesn't permanently block
    // future ticks. ``expireAfterSeconds: 0`` means "expire at the
    // exact time stored in the field".
    await lockCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    await lockCollection.createIndex({ key: 1 }, { unique: true });
  }

  async function acquireLock() {
    const expiresAt = new Date(now() + intervalMs - LOCK_LEAD_MS);
    try {
      // Compare-and-set: only acquire when the existing lock has
      // expired (or doesn't exist). Without the upsert+filter combo
      // two replicas firing within microseconds would both succeed
      // on a plain insertOne with a duplicate-key swallow.
      const res = await lockCollection.findOneAndUpdate(
        {
          key: LOCK_KEY,
          $or: [
            { expiresAt: { $lte: new Date(now()) } },
            { expiresAt: { $exists: false } },
          ],
        },
        { $set: { key: LOCK_KEY, expiresAt, acquiredAt: new Date(now()) } },
        { upsert: true, returnDocument: "after" },
      );
      // mongodb@6 returns the document directly (not a `{value, ok}`
      // envelope) when `includeResultMetadata` is unset. A non-null
      // result here means we either updated an expired lock or
      // inserted a fresh one — both count as a successful claim.
      return res != null;
    } catch (err) {
      // E11000 = another replica won the race. That's fine; we'll
      // run next tick.
      const e = /** @type {{ code?: unknown, codeName?: unknown }} */ (err);
      if (e && (e.code === 11000 || e.codeName === "DuplicateKey")) {
        return false;
      }
      throw err;
    }
  }

  async function releaseLock() {
    try {
      await lockCollection.deleteOne({ key: LOCK_KEY });
    } catch (err) {
      logger.warn({ err }, "pulse_backfill_lock_release_failed");
    }
  }

  /**
   * One backfill cycle. Idempotent — safe to call manually
   * (e.g. from a unit test or an admin tool) even when the timer
   * is also running. Concurrent calls coalesce onto the same
   * in-flight promise.
   *
   * @returns {Promise<TickResult|null>}
   */
  async function runOnce() {
    if (disabled) {
      logger.debug("pulse_backfill_disabled");
      return null;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const startedAt = now();
      try {
        await ensureLockIndex();
      } catch (err) {
        logger.warn({ err }, "pulse_backfill_index_failed");
      }
      let leader = false;
      try {
        leader = await acquireLock();
      } catch (err) {
        logger.warn({ err }, "pulse_backfill_lock_acquire_failed");
      }
      if (!leader) {
        return {
          ranAsLeader: false,
          users: 0,
          scanned: 0,
          resolved: 0,
          updated: 0,
          skipped: 0,
          elapsedMs: now() - startedAt,
        };
      }
      const summary = {
        ranAsLeader: true,
        users: 0,
        scanned: 0,
        resolved: 0,
        updated: 0,
        skipped: 0,
        // Reveal re-check pass (already-resolved opponents whose
        // SC2Pulse "revealed" name we re-probe). Kept separate from the
        // id-resolution counters above so each pass is independently
        // observable.
        revealUsers: 0,
        revealScanned: 0,
        revealed: 0,
        revealUpdated: 0,
        elapsedMs: 0,
      };
      try {
        const userIds = await pickStuckUsers(opponents, usersPerTick);
        summary.users = userIds.length;
        for (const userId of userIds) {
          try {
            const r = await deps.opponents.backfillPulseCharacterId(userId, {
              limit: userLimit,
            });
            summary.scanned += r.scanned;
            summary.resolved += r.resolved;
            summary.updated += r.updated;
            summary.skipped += r.skipped;
          } catch (err) {
            logger.warn(
              { err, userId },
              "pulse_backfill_user_failed",
            );
          }
        }
        // Second pass: re-check the SC2Pulse "revealed" identity for
        // opponents already resolved to a pulseCharacterId. A barcode's
        // reveal can land long after we resolved its id, so the
        // id-backfill loop above (which only touches unresolved rows)
        // would never catch it — this pass does. Best-effort: a failure
        // here never blocks the id-resolution work that already ran.
        if (typeof deps.opponents.backfillRevealedNames === "function") {
          const revealUserIds = await pickRevealRecheckUsers(
            opponents,
            usersPerTick,
          );
          summary.revealUsers = revealUserIds.length;
          for (const userId of revealUserIds) {
            try {
              const r = await deps.opponents.backfillRevealedNames(userId, {
                limit: userLimit,
              });
              summary.revealScanned += r.scanned;
              summary.revealed += r.revealed;
              summary.revealUpdated += r.updated;
            } catch (err) {
              logger.warn(
                { err, userId },
                "pulse_backfill_reveal_user_failed",
              );
            }
          }
        }
      } finally {
        await releaseLock();
        summary.elapsedMs = now() - startedAt;
        logger.info(summary, "pulse_backfill_cycle");
      }
      return summary;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (started || timer) return;
    started = true;
    if (disabled) {
      logger.info("pulse_backfill_disabled_skip_start");
      return;
    }
    logger.info({ intervalMs, userLimit, usersPerTick }, "pulse_backfill_started");
    // Don't fire immediately on boot — give the API a beat to
    // settle. The first tick lands one interval after start.
    timer = setInterval(() => {
      runOnce().catch((err) => logger.warn({ err }, "pulse_backfill_tick_failed"));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    started = false;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // already logged inside runOnce
      }
    }
  }

  function isRunning() {
    return started;
  }

  return { start, stop, runOnce, isRunning };
}

/**
 * Distinct user ids that own at least one row needing backfill.
 * Bounded by ``limit`` so a single tick can't try to walk every
 * user in one go.
 *
 * @param {import('mongodb').Collection} opponents
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function pickStuckUsers(opponents, limit) {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const filter = {
    $or: [
      { pulseCharacterId: { $exists: false } },
      { pulseCharacterId: "" },
      { pulseCharacterId: null },
    ],
    toonHandle: { $type: "string", $ne: "" },
    $and: [
      {
        $or: [
          { pulseResolveAttemptedAt: { $exists: false } },
          { pulseResolveAttemptedAt: null },
          { pulseResolveAttemptedAt: { $lt: cutoff } },
        ],
      },
    ],
  };
  const distinct = await opponents.aggregate([
    { $match: filter },
    { $group: { _id: "$userId" } },
    { $limit: limit },
  ]).toArray();
  return distinct.map((d) => d._id).filter((id) => typeof id === "string" && id);
}

/**
 * Distinct user ids owning at least one ALREADY-RESOLVED opponent whose
 * SC2Pulse reveal status is due for a re-check (``revealedNameCheckedAt``
 * missing or older than the re-check window). These are the users the
 * reveal pass (``backfillRevealedNames``) has work for — distinct from
 * ``pickStuckUsers``, which targets opponents still missing a
 * pulseCharacterId.
 *
 * @param {import('mongodb').Collection} opponents
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function pickRevealRecheckUsers(opponents, limit) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const filter = {
    pulseCharacterId: { $type: "string", $ne: "" },
    $or: [
      { revealedNameCheckedAt: { $exists: false } },
      { revealedNameCheckedAt: null },
      { revealedNameCheckedAt: { $lt: cutoff } },
    ],
  };
  const distinct = await opponents.aggregate([
    { $match: filter },
    { $group: { _id: "$userId" } },
    { $limit: limit },
  ]).toArray();
  return distinct.map((d) => d._id).filter((id) => typeof id === "string" && id);
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * @param {unknown} raw
 * @returns {number} milliseconds, 0 when unset/invalid.
 */
function parseSeconds(raw) {
  if (!raw) return 0;
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1000);
}

/**
 * @param {unknown} ms
 * @returns {number}
 */
function clampInterval(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(ms));
}

module.exports = {
  buildPulseBackfillJob,
  // Exported for tests.
  __internal: {
    pickStuckUsers,
    pickRevealRecheckUsers,
    clampInterval,
    parseSeconds,
  },
};
