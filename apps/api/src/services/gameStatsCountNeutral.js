"use strict";
const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { withGameStatsAuthority, saveGameStats, MAINTENANCE_VERSION } = require("./gameStatsMaintenance");
const { readyStatsFromOwnerRow } = require("./maintainedGameStatsRead");
const { immutableBuildState, applyBuildState } = require("./gameStatsBuildStateNeutral");
const { immutablePulseStamp, applyPulseStamp } = require("./gameStatsPulseNeutral");
const { immutableCustomBuildEof, applyCustomBuildEof, customBuildEofRepairAuthority } = require("./gameStatsCustomBuildEof");
const { immutableCustomBuildIngestTag, applyCustomBuildIngestTag } = require("./gameStatsCustomBuildIngestTag");
const { immutableCustomBuildDefinitionSave, applyCustomBuildDefinitionSave } = require("./gameStatsCustomBuildDefinitionSave");
const { OPPONENT_REPAIR_KIND, immutableOpponentGameMutation, applyOpponentGameMutation, opponentRepairAuthority,
  issuedOpponentRepair, applyOpponentGameIdentityRepair } = require("./gameStatsOpponentGame");

/** This named operation owns its filter and update. No arbitrary callback or
 * caller-declared neutral boolean can select the carry path.
 * @typedef {{kind:"macroSurface",gameId:string,macroScore:number,top3Leaks?:object[]}} MacroSurfaceMutation */
/** @typedef {MacroSurfaceMutation|import('./gameStatsBuildStateNeutral').BuildStateMutation|import('./gameStatsPulseNeutral').PulseStampMutation|import('./gameStatsCustomBuildEof').CustomBuildEofMutation|import('./gameStatsOpponentGame').OpponentGameMutation} UpdateNeutralMutation */
/** @typedef {UpdateNeutralMutation|import('./gameStatsCustomBuildIngestTag').CustomBuildIngestTagMutation} NeutralMutation */
/** @typedef {import('mongodb').UpdateResult|import('./gameStatsCustomBuildIngestTag').CustomBuildIngestTagResult} NeutralResult */
/** @typedef {NeutralMutation|import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation|import('./gameStatsOpponentGame').OpponentGameIdentityRepairMutation} ReservedCarryMutation */
/** @typedef {import('./gameStatsBuildStateNeutral').BuildStateMutation|import('./gameStatsOpponentGame').OpponentGameMutation} RemainingNeutralMutation */

/** @param {NeutralMutation} input @param {Record<string,any>} [options] */
function immutableNeutralMutation(input, options = {}) {
  if (input?.kind === "customBuildIngestTag") {
    return immutableCustomBuildIngestTag(input, options);
  }
  if (input?.kind === "customBuildEof") {
    return immutableCustomBuildEof(input, options);
  }
  if (input?.kind === "pulseGameStamp") {
    return immutablePulseStamp(input, options);
  }
  return input?.kind === "macroSurface" ? immutableMacroSurface(input, options) : immutableRemainingNeutral(input, options);
}
/** The repair kind is not a public neutral kind and falls to rejection.
 * @param {RemainingNeutralMutation} input @param {Record<string,any>} options */
function immutableRemainingNeutral(input, options) {
  return input?.kind === "opponentGameRegion" || input?.kind === "opponentGameIdentity"
    ? immutableOpponentGameMutation(input, options) : immutableBuildState(input, options);
}
/** @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<NeutralMutation>} mutation @param {import('mongodb').ClientSession|undefined} session */
function applyNeutralMutation(db, owner, mutation, session) {
  if (mutation.kind === "customBuildIngestTag") {
    return applyCustomBuildIngestTag(db, owner, mutation, session);
  }
  if (mutation.kind === "customBuildEof") {
    return applyCustomBuildEof(db, owner, mutation, session);
  }
  if (mutation.kind === "pulseGameStamp") {
    return applyPulseStamp(db, owner, mutation, session);
  }
  return mutation.kind === "macroSurface" ? applyMacroSurface(db, owner, mutation, session) : applyRemainingNeutral(db, owner, mutation, session);
}
/** @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<RemainingNeutralMutation>} mutation @param {import('mongodb').ClientSession|undefined} session */
function applyRemainingNeutral(db, owner, mutation, session) {
  return mutation.kind === "opponentGameRegion" || mutation.kind === "opponentGameIdentity"
    ? applyOpponentGameMutation(db, owner, mutation, session) : applyBuildState(db, owner, mutation, session);
}

/** Snapshot before owner/floor awaits, including nested payload arrays.
 * _schemaVersion is stamped by the server, never accepted in this descriptor.
 * @param {MacroSurfaceMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<MacroSurfaceMutation>} */
function immutableMacroSurface(input, options = {}) {
  if (!macroFields(input) || Object.keys(options).length
    || input.kind !== "macroSurface" || typeof input.gameId !== "string" || typeof input.macroScore !== "number"
    || (Object.hasOwn(input, "top3Leaks") && !Array.isArray(input.top3Leaks))) throw failure("game_stats_neutral_operation_invalid");
  return Object.freeze(/** @type {MacroSurfaceMutation} */ (BSON.deserialize(BSON.serialize(input))));
}
/** @param {MacroSurfaceMutation} input */
function macroFields(input) {
  return !!input && Object.getPrototypeOf(input) === Object.prototype
    && ["kind", "gameId", "macroScore"].every(key => Object.hasOwn(input, key))
    && !Object.keys(input).some(key => !["kind", "gameId", "macroScore", "top3Leaks"].includes(key));
}

/** Same private owner handle for authority and game work across all awaits.
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @returns {import('./gameStatsWrites').GameStatsOwner} */
function immutableNeutralOwner(owner) {
  if (!validNeutralOwner(owner)) throw failure("game_stats_owner_unavailable");
  const bytes = BSON.serialize({ id: owner.id }), copied = BSON.deserialize(bytes);
  if (!isDeepStrictEqual(bytes, BSON.serialize(copied)) || !isDeepStrictEqual(owner.id, copied.id)) throw failure("game_stats_owner_unavailable");
  return Object.freeze({ userId: owner.userId, id: copied.id, compatibility: owner.compatibility,
    ...(owner.epoch === undefined ? {} : { epoch: owner.epoch }) });
}
/** @param {import('./gameStatsWrites').GameStatsOwner} owner */
function validNeutralOwner(owner) {
  return !!owner && typeof owner.userId === "string" && !!owner.userId && owner.id !== undefined
    && typeof owner.compatibility === "boolean" && (owner.epoch === undefined
      || (typeof owner.epoch === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(owner.epoch)));
}

/** Named EOF repair is the only additional authority. Caller options cannot
 * select it, and other neutral families retain the absent-fence predicate.
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<ReservedCarryMutation>} mutation */
function neutralAuthority(owner, mutation) {
  if (mutation.kind === OPPONENT_REPAIR_KIND) return opponentRepairAuthority(owner, mutation);
  if (mutation.kind === "customBuildEof" && mutation.repairFenceId !== undefined) {
    return customBuildEofRepairAuthority(owner, mutation);
  }
  return { userId: owner.userId, _id: owner.id,
    gameStatsMutationEpoch: owner.epoch === undefined ? { $exists: false } : owner.epoch,
    _gdprMutation: { $exists: false } };
}

/** Preserve one server-owned identity across a request's reads/claim/retries.
 * Never recapture a supplied ingest handle after its epoch is retired.
 * @param {import('./gameStatsWrites').GameStatsWrites} writer @param {string} userId
 * @param {import('./gameStatsWrites').GameStatsOwner} [supplied] */
async function capturedNeutralOwner(writer, userId, supplied) {
  const owner = immutableNeutralOwner(supplied === undefined ? await writer.capture(userId) : supplied);
  if (owner.userId !== userId) throw failure("game_stats_owner_unavailable");
  return owner;
}

/** Only these macro fields are neutral to the original count/latest contract.
 * No upsert, membership flag, date, replacement or client query is accepted.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<MacroSurfaceMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session */
function applyMacroSurface(db, owner, mutation, session) {
  /** @type {Record<string,any>} */
  const set = { macroScore: mutation.macroScore };
  if (Array.isArray(mutation.top3Leaks)) set.top3Leaks = mutation.top3Leaks;
  stampVersion(set, COLLECTIONS.GAMES);
  return db.games.updateOne({ userId: owner.userId, gameId: mutation.gameId, ...LIVE_GAME_MATCH },
    { $set: set, $unset: { macroBreakdown: "" } }, { ...(session ? { session } : {}), upsert: false });
}

/** Internal body used only by the admitted writer's closed named operations.
 * An invalid prior tuple stays retired; neutral work must not recount history.
 * This is count proof only, not an expanded chart-coverage seal.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<NeutralMutation>} mutation
 * @param {import('mongodb').ClientSession} session */
function carryUnchangedGameStats(db, owner, mutation, session) {
  return carryFixedGameStats(db, immutableNeutralOwner(owner), immutableNeutralMutation(mutation), session);
}

/** Only the already-reserved fixed definition executor enters this path.
 * The public neutral validator deliberately does not accept this kind.
 * @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>} mutation
 * @param {import('mongodb').ClientSession} session */
function carryDefinitionGameStats(db, owner, mutation, session) {
  return carryFixedGameStats(db, immutableNeutralOwner(owner), immutableCustomBuildDefinitionSave(mutation), session);
}

/** Only the writer's fenced repair capability enters this path. The brand,
 * not a copy, keeps the issued handle; a fenced preimage is never ready.
 * @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<import('./gameStatsOpponentGame').OpponentGameIdentityRepairMutation>} mutation
 * @param {import('mongodb').ClientSession} session */
function carryOpponentRepairGameStats(db, owner, mutation, session) {
  return carryFixedGameStats(db, immutableNeutralOwner(owner), issuedOpponentRepair(mutation), session);
}

/** @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<ReservedCarryMutation>} mutation @param {import('mongodb').ClientSession} session */
function carryFixedGameStats(db, owner, mutation, session) {
  const authority = neutralAuthority(owner, mutation);
  return withGameStatsAuthority(db, owner, authority, async (before, revision) => {
    const stats = readyStatsFromOwnerRow(before, owner.userId, true);
    const result = await applyCarriedMutation(db, owner, mutation, session);
    if (stats) await saveGameStats(db, authority, revision, { $set: {
      gameStats: stats, gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready",
        ownerId: owner.id, revision, ...(owner.epoch === undefined ? {} : { epoch: owner.epoch }) },
    } }, session);
    return result;
  }, session);
}

/** @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<ReservedCarryMutation>} mutation @param {import('mongodb').ClientSession} session */
function applyCarriedMutation(db, owner, mutation, session) {
  if (mutation.kind === "customBuildDefinitionSave") return applyCustomBuildDefinitionSave(db, owner, mutation, session);
  return mutation.kind === OPPONENT_REPAIR_KIND ? applyOpponentGameIdentityRepair(db, owner, mutation, session)
    : applyNeutralMutation(db, owner, mutation, session);
}
/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { immutableMacroSurface, immutableNeutralOwner, applyMacroSurface, carryUnchangedGameStats,
  immutableNeutralMutation, applyNeutralMutation, capturedNeutralOwner, neutralAuthority, carryDefinitionGameStats,
  carryOpponentRepairGameStats };
