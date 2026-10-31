"use strict";

const { dataFields } = require("./gameStatsCustomBuildEof");
const { assertRepairLiveness, REPAIR_LIVENESS_KINDS } = require("./gdprRepairLiveness");
const { withUpdatedAt } = require("../util/corpusUpdatedAt");

const REGION_KIND = "opponentGameRegion", IDENTITY_KIND = "opponentGameIdentity";
/** @type {"opponentGameIdentityRepair"} */
const OPPONENT_REPAIR_KIND = "opponentGameIdentityRepair";
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const REGION_FIELDS = ["kind", "gameId", "region"];
const IDENTITY_FIELDS = ["kind", "pulseId", "region", "pulseCharacterId"];
const CONTEXT_FIELDS = ["owner", "fenceId", "kind", "handle"];

/** Fixed opponent-game families: only these server-owned paths, never a query.
 * @typedef {{kind:"opponentGameRegion",gameId:string,region:string}} OpponentGameRegionMutation */
/** @typedef {{kind:"opponentGameIdentity",pulseId:string,region?:string,pulseCharacterId?:string}} OpponentGameIdentityMutation */
/** @typedef {OpponentGameRegionMutation|OpponentGameIdentityMutation} OpponentGameMutation */
/** @typedef {{kind:"opponentGameIdentityRepair",identity:Readonly<OpponentGameIdentityMutation>}} OpponentGameIdentityRepairMutation */
/** @typedef {{owner:import('./gameStatsWrites').GameStatsOwner|null|undefined,fenceId:string,
 * kind:"repair_opponents"|"admin_rebuild_opponents",handle:object|undefined}} OpponentRepairContext */
/** @typedef {Readonly<{owner:Readonly<import('./gameStatsWrites').GameStatsOwner>,fenceId:string,kind:string,handle:object}>} RepairBinding */

/** Descriptors issued below are fresh in-module literals. The in-transaction
 * re-check returns them as-is, so no realm or BSON copy can reject them. */
const issued = new WeakSet();
/** Genuine repair bindings; the opaque handle is kept by reference only.
 * @type {WeakMap<object,RepairBinding>} */
const repairs = new WeakMap();

/** @param {unknown} kind */
function isOpponentGameKind(kind) { return kind === REGION_KIND || kind === IDENTITY_KIND; }
/** @param {unknown} kind */
function isOpponentGameFamily(kind) { return isOpponentGameKind(kind) || kind === OPPONENT_REPAIR_KIND; }

/** Plain own data only; literal strings are kept without trim, cap or coercion.
 * The repair kind is never accepted here.
 * @param {OpponentGameMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<OpponentGameMutation>} */
function immutableOpponentGameMutation(input, options = {}) {
  if (!dataFields(options, [], [])) throw invalid();
  if (issued.has(input)) return input;
  if (!dataFields(input, [...REGION_FIELDS, ...IDENTITY_FIELDS], ["kind"])) throw invalid();
  const mutation = input.kind === REGION_KIND ? regionMutation(input) : identityMutation(input);
  issued.add(mutation);
  return mutation;
}

/** @param {any} input @returns {Readonly<OpponentGameRegionMutation>} */
function regionMutation(input) {
  if (!dataFields(input, REGION_FIELDS, REGION_FIELDS) || typeof input.gameId !== "string" || !input.gameId
    || typeof input.region !== "string") throw invalid();
  return Object.freeze({ kind: REGION_KIND, gameId: input.gameId, region: input.region });
}

/** @param {any} input @returns {Readonly<OpponentGameIdentityMutation>} */
function identityMutation(input) {
  if (!dataFields(input, IDENTITY_FIELDS, ["kind", "pulseId"]) || input.kind !== IDENTITY_KIND
    || typeof input.pulseId !== "string" || !validPatch(input)) throw invalid();
  return Object.freeze(/** @type {OpponentGameIdentityMutation} */ ({ kind: IDENTITY_KIND, pulseId: input.pulseId,
    ...(Object.hasOwn(input, "region") ? { region: input.region } : {}),
    ...(Object.hasOwn(input, "pulseCharacterId") ? { pulseCharacterId: input.pulseCharacterId } : {}) }));
}

/** At least one present patch field, and every present one a string.
 * @param {Record<string,unknown>} input */
function validPatch(input) {
  const region = Object.hasOwn(input, "region"), character = Object.hasOwn(input, "pulseCharacterId");
  return (region || character) && (!region || typeof input.region === "string")
    && (!character || typeof input.pulseCharacterId === "string");
}

/** The original filters and $set paths, now with an explicit no-upsert option; the identity write also carries the
 * corpus change stamp, which moves only when the character id changes. No MMR, league, marker, game date,
 * membership or schema field is written.
 * @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<OpponentGameMutation>} mutation @param {import('mongodb').ClientSession|undefined} [session]
 * @returns {Promise<import('mongodb').UpdateResult>} */
function applyOpponentGameMutation(db, owner, mutation, session) {
  const options = { ...(session ? { session } : {}), upsert: false };
  if (mutation.kind === REGION_KIND) {
    return db.games.updateOne({ userId: owner.userId, gameId: mutation.gameId },
      { $set: { "opponent.region": mutation.region } }, options);
  }
  return db.games.updateMany({ userId: owner.userId, "opponent.pulseId": mutation.pulseId },
    withUpdatedAt({ $set: identitySet(mutation) }), options);
}

/** @param {Readonly<OpponentGameIdentityMutation>} mutation */
function identitySet(mutation) {
  /** @type {Record<string,string>} */
  const set = {};
  if (mutation.region !== undefined) set["opponent.region"] = mutation.region;
  if (mutation.pulseCharacterId !== undefined) set["opponent.pulseCharacterId"] = mutation.pulseCharacterId;
  return set;
}

/** Strictly validated context fields; the writer copies this owner itself.
 * @param {unknown} context @returns {unknown} */
function repairContextOwner(context) {
  if (!dataFields(context, CONTEXT_FIELDS, CONTEXT_FIELDS)) throw unavailable();
  return /** @type {OpponentRepairContext} */ (context).owner;
}

/** Only a genuine, still-live repair claim can issue the fenced heal. Its
 * owner copy, fence id, fixed kind and opaque handle are bound privately.
 * @param {Readonly<OpponentRepairContext>} context @param {Readonly<import('./gameStatsWrites').GameStatsOwner>} owner
 * @param {OpponentGameIdentityMutation} input @returns {Readonly<OpponentGameIdentityRepairMutation>} */
function issueOpponentIdentityRepair(context, owner, input) {
  const identity = immutableOpponentGameMutation(input);
  if (identity.kind !== IDENTITY_KIND || !genuineContext(context, owner)) throw unavailable();
  assertRepairLiveness(context.handle, owner, context.fenceId, context.kind);
  const mutation = Object.freeze(/** @type {OpponentGameIdentityRepairMutation} */ ({ kind: OPPONENT_REPAIR_KIND, identity }));
  repairs.set(mutation, Object.freeze({ owner, fenceId: context.fenceId, kind: context.kind,
    handle: /** @type {object} */ (context.handle) }));
  return mutation;
}

/** @param {Readonly<OpponentRepairContext>} context @param {Readonly<import('./gameStatsWrites').GameStatsOwner>} owner */
function genuineContext(context, owner) {
  return dataFields(context, CONTEXT_FIELDS, CONTEXT_FIELDS) && typeof context.fenceId === "string"
    && UUID.test(context.fenceId) && REPAIR_LIVENESS_KINDS.includes(context.kind)
    && !!owner && owner.id !== null && owner.epoch === context.fenceId;
}

/** The brand, not a re-validated copy, carries the handle into a transaction.
 * @param {Readonly<OpponentGameIdentityRepairMutation>} mutation */
function issuedOpponentRepair(mutation) {
  if (!repairs.has(mutation)) throw unavailable();
  return mutation;
}

/** @param {import('./gameStatsWrites').GameStatsOwner} owner @param {Readonly<OpponentGameIdentityRepairMutation>} mutation */
function liveRepair(owner, mutation) {
  const binding = repairs.get(mutation);
  if (!binding) throw unavailable();
  assertRepairLiveness(binding.handle, owner, binding.fenceId, binding.kind);
  return binding;
}

/** The one fenced predicate for owner claim, retirement and publication.
 * @param {import('./gameStatsWrites').GameStatsOwner} owner @param {Readonly<OpponentGameIdentityRepairMutation>} mutation
 * @returns {Record<string,any>} */
function opponentRepairAuthority(owner, mutation) {
  const binding = liveRepair(owner, mutation);
  return { userId: binding.owner.userId, _id: binding.owner.id, gameStatsMutationEpoch: binding.fenceId,
    "_gdprMutation.id": binding.fenceId, "_gdprMutation.kind": binding.kind };
}

/** Post-floor handle read before any session or transaction work.
 * @param {import('./gameStatsWrites').GameStatsOwner} owner @param {Readonly<{kind:string}>|null} mutation */
function assertReservedDispatch(owner, mutation) {
  if (mutation?.kind === OPPONENT_REPAIR_KIND) liveRepair(owner, /** @type {Readonly<OpponentGameIdentityRepairMutation>} */ (mutation));
}

/** Synchronous handle read immediately before the fixed command; no await
 * separates them. A failure observed after dispatch cannot cancel it.
 * @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<OpponentGameIdentityRepairMutation>} mutation @param {import('mongodb').ClientSession|undefined} [session]
 * @returns {Promise<import('mongodb').UpdateResult>} */
function applyOpponentGameIdentityRepair(db, owner, mutation, session) {
  liveRepair(owner, mutation);
  return applyOpponentGameMutation(db, owner, mutation.identity, session);
}

function invalid() {
  return Object.assign(new Error("game_stats_neutral_operation_invalid"), { code: "game_stats_neutral_operation_invalid", status: 503 });
}
function unavailable() {
  return Object.assign(new Error("game_stats_repair_authority_unavailable"), { code: "game_stats_repair_authority_unavailable", status: 503 });
}

module.exports = { OPPONENT_REPAIR_KIND, isOpponentGameKind, isOpponentGameFamily, immutableOpponentGameMutation,
  applyOpponentGameMutation, repairContextOwner, issueOpponentIdentityRepair, issuedOpponentRepair,
  opponentRepairAuthority, assertReservedDispatch, applyOpponentGameIdentityRepair };
