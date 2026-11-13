"use strict";

const { buildJobLock } = require("../util/jobLock");
const { observeJob } = require("../util/jobLedger");
const { USER_AGENT, buildPulseBalanceCollector } = require("../services/pulseBalanceCollector");

const ENABLE_FLAG = "SC2TOOLS_PULSE_BALANCE_ENABLED";
const DAY_MS = 86_400_000;
const RUN_HOUR_UTC = 3;
const LEASE_MS = 10 * 60_000;

/** @param {number} now */
function dailySlot(now) {
  const day = new Date(now);
  return day.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
}

/**
 * @param {{
 *   db:import("../db/connect").DbContext,
 *   store:import("../services/pulseBalanceStore").PulseBalanceStore,
 *   seasons:import("../services/seasons").SeasonsService,
 *   logger:import("pino").Logger,
 *   jobLedger?:import("../util/jobLedger").JobLedger,
 *   now?:()=>number,
 *   enabled?:boolean,
 *   collect?:ReturnType<typeof buildPulseBalanceCollector>,
 *   lock?:import("../util/jobLock").JobLock,
 * }} deps
 */
function buildPulseBalanceSnapshotJob(deps) {
  const { store, seasons, now = Date.now } = deps;
  const enabled = deps.enabled ?? process.env[ENABLE_FLAG] === "1";
  const logger = deps.logger.child({ component: "pulseBalanceSnapshot" });
  const lock = deps.lock ?? buildJobLock({ collection: deps.db.db.collection("jobLocks"), key: "pulseBalanceSnapshot", leaseMs: LEASE_MS, now });
  const collect = deps.collect ?? buildPulseBalanceCollector({
    catalog: () => seasons.catalog({ freshOnly: true, userAgent: USER_AGENT }),
    now,
  });

  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {AbortController|null} */
  let controller = null;
  /** @type {Promise<void>|null} */
  let inflight = null;

  /** @param {AbortSignal} signal */
  async function takeSnapshot(signal) {
    const timestamp = now();
    const asOf = new Date(timestamp).toISOString().slice(0, 10);
    const latest = await store.latest();
    if (latest && (latest.asOf >= asOf || timestamp < dailySlot(timestamp))) return { lockHeld: true };
    signal.throwIfAborted();
    await lock.ensureIndexes();
    const owner = await lock.acquire();
    if (!owner) return { lockHeld: true };
    try {
      signal.throwIfAborted();
      const current = await store.latest();
      if (current && (current.asOf >= asOf || timestamp < dailySlot(timestamp))) return { lockHeld: true };
      if (!await store.claim(asOf, timestamp)) return { lockHeld: true };
      const snapshot = await collect(asOf, signal);
      signal.throwIfAborted();
      if (current && snapshot.bundle.season < current.season) {
        throw Object.assign(new Error("Balance season moved backwards"), { code: "pulse_balance_season_regressed" });
      }
      if (!await lock.extend(owner)) {
        throw Object.assign(new Error("Balance job lease was lost"), { code: "pulse_balance_lease_lost" });
      }
      signal.throwIfAborted();
      if (!await store.publish(snapshot)) return { lockHeld: true };
      const summary = { season: snapshot.bundle.season, tiers: snapshot.bundle.tiers.length };
      logger.info({ ...summary, asOf }, "pulse_balance_snapshot_published");
      return summary;
    } finally {
      await lock.release(owner).catch(() => logger.warn("pulse_balance_lock_release_failed"));
    }
  }

  const tick = observeJob(deps, "pulse-balance-snapshot", DAY_MS, takeSnapshot, {
    disabled: !enabled, manual: false, envFlag: ENABLE_FLAG,
  });

  /** @param {AbortSignal} signal */
  function run(signal) {
    inflight = Promise.resolve(tick(signal))
      .then(() => {})
      .catch(error => { if (!signal.aborted) logger.warn(safeFailure(error), "pulse_balance_snapshot_failed"); })
      .finally(() => {
        if (!signal.aborted) timer = scheduleNext(now(), () => run(signal));
      });
  }

  return {
    start() {
      if (!enabled || controller) return;
      controller = new AbortController();
      run(controller.signal);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      await inflight;
      inflight = null;
      controller = null;
    },
  };
}

/** @param {number} now @param {() => void} callback */
function scheduleNext(now, callback) {
  const slot = dailySlot(now);
  const next = slot > now ? slot : slot + DAY_MS;
  const timer = setTimeout(callback, next - now);
  timer.unref();
  return timer;
}

/** @param {{code?:unknown,league?:unknown,division?:unknown,reason?:unknown}|null} error */
function safeFailure(error) {
  return {
    code: typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "job_failed",
    league: typeof error?.league === "string" && /^[a-z]{1,16}$/.test(error.league) ? error.league : undefined,
    division: error?.division === null || error?.division === 1 || error?.division === 2 || error?.division === 3 ? error.division : undefined,
    reason: typeof error?.reason === "string" && /^[a-z0-9_]{1,64}$/.test(error.reason) ? error.reason : undefined,
  };
}

module.exports = { buildPulseBalanceSnapshotJob };
