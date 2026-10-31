"use strict";

const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { withUpdatedAt } = require("../util/corpusUpdatedAt");
const { commitReclassifyRunPipeline, RECLASSIFY_LEASE_MS } = require("./customBuildReclassifyPipeline");
const { OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD, opponentBuildOrderWriteInProgressError } = require("./opponentBuildOrderFence");

const REPAIR_KIND = "repair_custom-builds";
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const FIELDS = ["kind", "runId", "sequence", "mode", "lease", "repairFenceId", "signal"];

/** @typedef {{generation:string,leaseToken:string}} EofJobLease */
/** @typedef {{kind:"customBuildEof",runId:string,sequence:number,mode:"single"|"all",
 * lease?:EofJobLease,repairFenceId?:string,signal?:AbortSignal}} CustomBuildEofMutation */

/** @param {any} input @param {string[]} allowed @param {string[]} required */
function dataFields(input, allowed, required) {
  return !!input && Object.getPrototypeOf(input) === Object.prototype
    && Reflect.ownKeys(input).every(key => typeof key === "string" && allowed.includes(key))
    && required.every(key => Object.hasOwn(input, key))
    && Object.values(Object.getOwnPropertyDescriptors(input)).every(field => Object.hasOwn(field, "value"));
}

/** @param {any} value */
function boundedString(value) { return typeof value === "string" && value.length > 0 && value.length <= 256; }

/** @param {any} lease */
function validLease(lease) {
  return dataFields(lease, ["generation", "leaseToken"], ["generation", "leaseToken"])
    && boundedString(lease.generation) && boundedString(lease.leaseToken);
}

/** @param {any} value */
function validRepairId(value) { return typeof value === "string" && UUID.test(value); }

/** @param {CustomBuildEofMutation} input */
function validEof(input) {
  return dataFields(input, FIELDS, ["kind", "runId", "sequence", "mode"])
    && input.kind === "customBuildEof" && typeof input.runId === "string" && UUID.test(input.runId)
    && Number.isSafeInteger(input.sequence) && input.sequence >= 0
    && ["single", "all"].includes(input.mode);
}

/** Optional repair and job authorities are mutually exclusive and all-mode.
 * @param {CustomBuildEofMutation} input */
function validEofAuthority(input) {
  if (input.lease !== undefined && !validLease(input.lease)) return false;
  if (input.repairFenceId !== undefined && !validRepairId(input.repairFenceId)) return false;
  if (input.mode === "single" && (input.lease !== undefined || input.repairFenceId !== undefined)) return false;
  return input.lease === undefined || input.repairFenceId === undefined;
}

/** Call the intrinsic getter, never a caller's overridden aborted property.
 * @param {AbortSignal} signal */
function signalAborted(signal) {
  if (!(signal instanceof AbortSignal) || typeof nativeAborted !== "function") throw failure("game_stats_neutral_operation_invalid");
  return Boolean(Reflect.apply(nativeAborted, signal, []));
}

/** Data is BSON-copied before awaits. The native signal deliberately stays a
 * live cancellation control; no caller callback or pipeline is accepted.
 * @param {CustomBuildEofMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<CustomBuildEofMutation>} */
function immutableCustomBuildEof(input, options = {}) {
  if (!validEof(input) || !validEofAuthority(input) || !dataFields(options, [], [])) throw failure("game_stats_neutral_operation_invalid");
  const signal = input.signal;
  if (signal !== undefined) signalAborted(signal);
  const copied = copyEofData(input);
  return Object.freeze(/** @type {CustomBuildEofMutation} */ ({ ...copied, ...(signal === undefined ? {} : { signal }) }));
}

/** @param {CustomBuildEofMutation} input */
function copyEofData(input) {
  const data = { kind: input.kind, runId: input.runId, sequence: input.sequence, mode: input.mode,
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.repairFenceId === undefined ? {} : { repairFenceId: input.repairFenceId }) };
  const bytes = BSON.serialize(data);
  if (bytes.length > 16 * 1024) throw failure("game_stats_neutral_operation_invalid");
  const copied = BSON.deserialize(bytes);
  if (!isDeepStrictEqual(data, copied)) throw failure("game_stats_neutral_operation_invalid");
  if (copied.lease) Object.freeze(copied.lease);
  return copied;
}

/** Only a captured custom-build repair handle may use this fenced authority.
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<CustomBuildEofMutation>} mutation */
function customBuildEofRepairAuthority(owner, mutation) {
  const id = mutation.repairFenceId;
  if (!id || owner.id === null || owner.epoch !== id) throw failure("game_stats_owner_unavailable");
  return { userId: owner.userId, _id: owner.id, gameStatsMutationEpoch: id,
    "_gdprMutation.id": id, "_gdprMutation.kind": REPAIR_KIND };
}

/** @param {Readonly<CustomBuildEofMutation>} mutation */
function assertEofNotAborted(mutation) {
  if (mutation.signal !== undefined && signalAborted(mutation.signal)) throw abortError();
}

/** @param {import('../db/connect').DbContext} db */
function jobCollection(db) {
  return db.customBuildJobs || /** @type {any} */ (db.customBuilds).s.db.collection("custom_build_jobs");
}

/** The exact existing job authority and heartbeat renewal, now inside the
 * EOF transaction. There is no new expiry or caller-declared success flag.
 * @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {EofJobLease} lease @param {import('mongodb').ClientSession|undefined} session */
async function renewEofJobLease(db, userId, lease, session) {
  const result = await jobCollection(db).updateOne(
    { userId, generation: lease.generation, leaseToken: lease.leaseToken, status: "running" },
    { $set: { leaseUntil: new Date(Date.now() + RECLASSIFY_LEASE_MS) } },
    session ? { session } : {},
  );
  if (result.acknowledged !== true || result.matchedCount !== 1) throw abortError();
}

/** Recovery still runs at the original service boundary. This fixed read
 * repeats the active-write guard after owner/floor awaits in all-mode.
 * @param {import('../db/connect').DbContext} db @param {string} userId
 * @param {import('mongodb').ClientSession|undefined} session */
async function assertEofOpponentStable(db, userId, session) {
  const field = OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD;
  const active = await db.games.findOne(
    { userId, [`${field}.leaseUntil`]: { $gt: new Date() } },
    { projection: { _id: 1, [`${field}.leaseUntil`]: 1 }, ...(session ? { session } : {}) },
  );
  if (active) throw opponentBuildOrderWriteInProgressError(active[field]?.leaseUntil);
}

/** One full server-owned EOF update; membership/date/pipeline/query/upsert are
 * never caller-selected. Cancellation after dispatch cannot undo a commit.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<CustomBuildEofMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session */
async function applyCustomBuildEof(db, owner, mutation, session) {
  assertEofNotAborted(mutation);
  if (mutation.mode === "all") await assertEofOpponentStable(db, owner.userId, session);
  assertEofNotAborted(mutation);
  if (mutation.lease) await renewEofJobLease(db, owner.userId, mutation.lease, session);
  assertEofNotAborted(mutation);
  const result = await db.games.updateMany(
    { userId: owner.userId, "_customBuildReclassify.runId": mutation.runId },
    withUpdatedAt(commitReclassifyRunPipeline(mutation.runId, mutation.sequence)),
    { ...(session ? { session } : {}), upsert: false },
  );
  if (result.acknowledged !== true) throw failure("custom_build_eof_unacknowledged");
  return result;
}

function abortError() { return Object.assign(new Error("reclassify_aborted"), { name: "AbortError" }); }
/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { immutableCustomBuildEof, applyCustomBuildEof, customBuildEofRepairAuthority, assertEofNotAborted, dataFields };
