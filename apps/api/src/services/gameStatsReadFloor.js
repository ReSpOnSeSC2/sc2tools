"use strict";

const { Timestamp } = require("mongodb");
const { performance } = require("perf_hooks");
const QUERY_MS = 2000, OPERATION_MS = 5000, RETRY_MS = 1000;
/** @type {WeakMap<object,()=>Timestamp|Promise<Timestamp>>} */
const providers = new WeakMap();

/** @param {Timestamp} value */
function copyFloor(value) { return new Timestamp({ t: value.getHighBitsUnsigned(), i: value.getLowBitsUnsigned() }); }
/** @param {any} value */
function topologyPresent(value) {
  return !!value && value.processId !== undefined && value.processId !== null
    && value.counter !== undefined && value.counter !== null;
}
/** @param {any} hello */
function isPrimary(hello) {
  return typeof hello?.setName === "string" && hello.isWritablePrimary === true
    && hello.operationTime instanceof Timestamp && !hello.operationTime.isZero() && topologyPresent(hello.topologyVersion);
}
/** @param {any} before @param {any} after */
function samePrimary(before, after) {
  return isPrimary(after) && String(before.topologyVersion.processId) === String(after.topologyVersion.processId)
    && String(before.topologyVersion.counter) === String(after.topologyVersion.counter);
}
/** @param {string} code @param {unknown} [cause] */
function failure(code, cause) { return Object.assign(new Error(code, { cause }), { status: 503, code }); }

/** Read-only readiness: no gossip clock, user-supplied timestamp or historical
 * time. A real majority collection read must acknowledge the primary's floor.
 * @param {import('../db/connect').DbContext} db @param {any} [logger]
 * @returns {Promise<Timestamp>} */
async function readMajorityFloor(db, logger) {
  const admin = db.db.admin(), options = { readPreference: /** @type {const} */ ("primary"), timeoutMS: OPERATION_MS };
  const before = await admin.command({ hello: 1, maxTimeMS: QUERY_MS }, options);
  if (!isPrimary(before)) throw failure("game_stats_read_floor_primary_unavailable");
  const anchor = copyFloor(before.operationTime);
  const session = db.client.startSession({ causalConsistency: true });
  try {
    session.advanceOperationTime(anchor);
    // MongoClient6.13 applies session.operationTime as afterClusterTime on this
    // genuine read and on the first statement of each future causal TX.
    await db.users.findOne({}, { projection: { _id: 1 }, readPreference: "primary",
      readConcern: { level: "majority" }, session, maxTimeMS: QUERY_MS, timeoutMS: OPERATION_MS });
    const after = await admin.command({ hello: 1, maxTimeMS: QUERY_MS }, options);
    if (!samePrimary(before, after)) throw failure("game_stats_read_floor_primary_changed");
    return anchor;
  } finally {
    try { await session.endSession(); }
    catch { try { logger?.warn?.({ code: "game_stats_floor_session_cleanup_failed" }, "game_stats_floor_session_cleanup_failed"); } catch { /* Diagnostic only. */ } }
  }
}

/** At most one pending barrier per connected client, retried on later demand
 * after a finite cooldown. Actual callers remain charged to writer admission.
 * @param {import('../db/connect').DbContext} db
 * @param {{logger?:any,now?:()=>number}} [options]
 * @returns {()=>Timestamp|Promise<Timestamp>} */
function createReadFloorProvider(db, options = {}) {
  const now = options.now || (() => performance.now());
  /** @type {Timestamp|null} */ let ready = null;
  /** @type {Promise<Timestamp>|null} */ let pending = null;
  let retryAfter = 0;
  return () => {
    if (ready) return copyFloor(ready);
    if (pending) return pending.then(copyFloor);
    const time = now();
    if (!Number.isFinite(time) || time < retryAfter) return Promise.reject(failure("game_stats_read_floor_unavailable"));
    const task = readMajorityFloor(db, options.logger).then(floor => {
      ready = copyFloor(floor); pending = null; return floor;
    }, error => {
      const failedAt = now();
      retryAfter = Number.isFinite(failedAt) ? failedAt + RETRY_MS : Infinity; pending = null;
      throw failure("game_stats_read_floor_unavailable", error);
    });
    pending = task;
    return task.then(copyFloor);
  };
}

/** @param {import('../db/connect').DbContext} db @param {any} [logger] */
function statsReadFloorFor(db, logger) {
  if (!db.client || typeof db.client.startSession !== "function") throw failure("game_stats_transactions_required");
  let provider = providers.get(db.client);
  if (!provider) { provider = createReadFloorProvider(db, { logger }); providers.set(db.client, provider); }
  return provider;
}

module.exports = { statsReadFloorFor, createReadFloorProvider, readMajorityFloor, RETRY_MS };
