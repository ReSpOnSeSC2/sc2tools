"use strict";
const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { withGameStatsAuthority, saveGameStats, MAINTENANCE_VERSION } = require("./gameStatsMaintenance");
const { readyStatsFromOwnerRow } = require("./maintainedGameStatsRead");
const { immutablePulseStamp, applyPulseStamp } = require("./gameStatsPulseNeutral");

/** This named operation owns its filter and update. No arbitrary callback or
 * caller-declared neutral boolean can select the carry path.
 * @typedef {{kind:"macroSurface",gameId:string,macroScore:number,top3Leaks?:object[]}} MacroSurfaceMutation */
/** @typedef {MacroSurfaceMutation|import('./gameStatsPulseNeutral').PulseStampMutation} NeutralMutation */

/** @param {NeutralMutation} input @param {Record<string,any>} [options] */
function immutableNeutralMutation(input, options = {}) {
  return input?.kind === "pulseGameStamp" ? immutablePulseStamp(input, options) : immutableMacroSurface(input, options);
}
/** @param {import('../db/connect').DbContext} db @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<NeutralMutation>} mutation @param {import('mongodb').ClientSession|undefined} session */
function applyNeutralMutation(db, owner, mutation, session) {
  return mutation.kind === "pulseGameStamp" ? applyPulseStamp(db, owner, mutation, session) : applyMacroSurface(db, owner, mutation, session);
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
  return typeof owner.userId === "string" && !!owner.userId && owner.id !== undefined
    && typeof owner.compatibility === "boolean" && (owner.epoch === undefined
      || (typeof owner.epoch === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(owner.epoch)));
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

/** Internal body used only by the admitted writer's fixed named operations.
 * An invalid prior tuple stays retired; neutral work must not recount history.
 * This is count proof only, not an expanded chart-coverage seal.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<NeutralMutation>} mutation
 * @param {import('mongodb').ClientSession} session */
function carryUnchangedGameStats(db, owner, mutation, session) {
  const fixedOwner = immutableNeutralOwner(owner), fixedMutation = immutableNeutralMutation(mutation);
  const authority = { userId: fixedOwner.userId, _id: fixedOwner.id,
    gameStatsMutationEpoch: fixedOwner.epoch === undefined ? { $exists: false } : fixedOwner.epoch,
    _gdprMutation: { $exists: false } };
  return withGameStatsAuthority(db, fixedOwner, authority, async (before, revision) => {
    const stats = readyStatsFromOwnerRow(before, fixedOwner.userId, true);
    const result = await applyNeutralMutation(db, fixedOwner, fixedMutation, session);
    if (stats) await saveGameStats(db, authority, revision, { $set: {
      gameStats: stats, gameStatsMaintenance: { version: MAINTENANCE_VERSION, status: "ready",
        ownerId: fixedOwner.id, revision, ...(fixedOwner.epoch === undefined ? {} : { epoch: fixedOwner.epoch }) },
    } }, session);
    return result;
  }, session);
}
/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { immutableMacroSurface, immutableNeutralOwner, applyMacroSurface, carryUnchangedGameStats,
  immutableNeutralMutation, applyNeutralMutation };
