"use strict";

const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");

/** Fence kinds whose genuine claims may authorize fenced opponent heals. */
const REPAIR_LIVENESS_KINDS = Object.freeze(["repair_opponents", "admin_rebuild_opponents"]);
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

/** @typedef {{userId:string,idBytes:Uint8Array,epoch:string,compatibility:boolean,fenceId:string,
 * kind:string,closed:boolean,reason:unknown}} LivenessBinding */
/** @typedef {Readonly<{issue:(owner:import('./gameStatsWrites').GameStatsOwner|null,fenceId:string,kind:string)=>object|undefined,
 * fail:<E>(handle:unknown,error:E)=>E,release:(handle:unknown)=>void}>} RepairLivenessIssuer */

/** Process-local, deny-only state keyed by the opaque handle object itself.
 * Nothing here performs IO, reads a clock or calls back into a caller.
 * @type {WeakMap<object,LivenessBinding>} */
const bindings = new WeakMap();
let issuerTaken = false;

/** The genuine claim site takes the only issuer at module load; any second
 * taker in the same module registry fails loudly instead of minting handles.
 * @returns {RepairLivenessIssuer} */
function takeRepairLivenessIssuer() {
  if (issuerTaken) throw failure("gdpr_liveness_issuer_taken");
  issuerTaken = true;
  return Object.freeze({ issue, fail, release });
}

/** Bind a successful claim's captured owner to its new fence epoch. Issuing
 * never throws: an unusable tuple yields no handle, so every heal stays vetoed.
 * @param {import('./gameStatsWrites').GameStatsOwner|null} owner @param {string} fenceId @param {string} kind
 * @returns {object|undefined} */
function issue(owner, fenceId, kind) {
  try {
    if (!owner || !issuableFence(fenceId, kind) || !issuableOwner(owner)) return undefined;
    const handle = Object.freeze(Object.create(null));
    bindings.set(handle, { userId: owner.userId, idBytes: idBytes(owner.id), epoch: fenceId,
      compatibility: owner.compatibility, fenceId, kind, closed: false, reason: undefined });
    return handle;
  } catch {
    return undefined;
  }
}

/** @param {unknown} fenceId @param {unknown} kind */
function issuableFence(fenceId, kind) {
  return typeof kind === "string" && REPAIR_LIVENESS_KINDS.includes(kind)
    && typeof fenceId === "string" && UUID.test(fenceId);
}

/** @param {import('./gameStatsWrites').GameStatsOwner} owner */
function issuableOwner(owner) {
  return typeof owner.userId === "string" && !!owner.userId && owner.id !== null && owner.id !== undefined
    && typeof owner.compatibility === "boolean";
}

/** Exact BSON identity bytes; a value that does not survive BSON is unusable.
 * @param {unknown} id @returns {Uint8Array} */
function idBytes(id) {
  const bytes = BSON.serialize({ id });
  if (!isDeepStrictEqual(BSON.deserialize(bytes).id, id)) throw failure("game_stats_repair_authority_unavailable");
  return bytes;
}

/** The first known failure is terminal and keeps its reason; it returns the
 * caller's error so lifecycle sites can rethrow the exact original value.
 * @template E @param {unknown} handle @param {E} error @returns {E} */
function fail(handle, error) {
  close(handle, error);
  return error;
}

/** Release-begin closes the handle before any database release work.
 * @param {unknown} handle */
function release(handle) {
  close(handle, failure("gdpr_repair_fence_released"));
}

/** Unknown or undefined handles are ignored; nothing can reopen a handle.
 * @param {unknown} handle @param {unknown} reason */
function close(handle, reason) {
  const binding = bindings.get(/** @type {object} */ (handle));
  if (binding && !binding.closed) {
    binding.closed = true;
    binding.reason = reason;
  }
}

/** A synchronous deny-only check. Passing grants nothing: the exact database
 * predicate stays authoritative for every claim, retirement and publication.
 * @param {unknown} handle @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {string} fenceId @param {string} kind */
function assertRepairLiveness(handle, owner, fenceId, kind) {
  const binding = bindings.get(/** @type {object} */ (handle));
  if (!binding || binding.closed || !boundTuple(binding, owner, fenceId, kind)) throw unavailable(binding?.reason);
}

/** @param {LivenessBinding} binding @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {string} fenceId @param {string} kind */
function boundTuple(binding, owner, fenceId, kind) {
  try {
    return !!owner && owner.userId === binding.userId && owner.epoch === binding.epoch
      && owner.compatibility === binding.compatibility && fenceId === binding.fenceId && kind === binding.kind
      && isDeepStrictEqual(idBytes(owner.id), binding.idBytes);
  } catch {
    return false;
  }
}

/** @param {unknown} cause */
function unavailable(cause) {
  return Object.assign(new Error("game_stats_repair_authority_unavailable", { cause }),
    { code: "game_stats_repair_authority_unavailable", status: 503 });
}

/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { REPAIR_LIVENESS_KINDS, takeRepairLivenessIssuer, assertRepairLiveness };
