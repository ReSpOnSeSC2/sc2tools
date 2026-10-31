"use strict";
const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { withUpdatedAt } = require("../util/corpusUpdatedAt");
const { BUILD_INTENT, COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");

/** Fixed check-in operations, not arbitrary neutral callbacks or filters.
 * @typedef {{kind:"buildIntentUpdate"|"buildIntentPending",gameId:string,pipeline:Record<string,any>[]}
 * | {kind:"buildIntentDismiss",gameIds:string[],pipeline:Record<string,any>[]}
 * | {kind:"buildIntentBind",gameId:string,pipeline:Record<string,any>[],guard:"empty"|"missingUpdatedAt"|"updatedAt",updatedAt?:Date}} BuildStateMutation */
const FIELDS = new Set(["buildIntent", "myBuild", "_customBuildSlug", "opponent.strategy", "_customOpponentStrategySlug", "_schemaVersion"]);
const YOU_FIELDS = new Set(["buildIntent", "myBuild", "_customBuildSlug", "_schemaVersion"]);
const PENDING_FIELDS = new Set(["buildIntent", "_schemaVersion"]);
const SINGLE_FIELDS = ["kind", "gameId", "pipeline"];

/** Private BSON snapshot before owner/floor IO. Only server pipeline builders
 * supply expressions; their possible write paths are independently bounded.
 * Invalid/raw values cannot silently normalize during the copy.
 * @param {BuildStateMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<BuildStateMutation>} */
function immutableBuildState(input, options = {}) {
  if (Object.keys(options).length || !validShape(input) || !validPipeline(input)) throw invalid();
  const bytes = BSON.serialize(input), copied = BSON.deserialize(bytes);
  if (!isDeepStrictEqual(bytes, BSON.serialize(copied)) || !isDeepStrictEqual(input, copied)) throw invalid();
  return Object.freeze(/** @type {BuildStateMutation} */ (copied));
}
/** @param {BuildStateMutation} input */
function validShape(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) return false;
  if (input.kind === "buildIntentDismiss") return validDismiss(input);
  if (input.kind === "buildIntentBind") return validBind(input);
  return ["buildIntentUpdate", "buildIntentPending"].includes(input.kind)
    && ownFields(input, SINGLE_FIELDS) && typeof input.gameId === "string";
}
/** @param {Extract<BuildStateMutation,{kind:"buildIntentDismiss"}>} input */
function validDismiss(input) {
  return ownFields(input, ["kind", "gameIds", "pipeline"]) && Array.isArray(input.gameIds)
    && input.gameIds.length > 0 && input.gameIds.length <= BUILD_INTENT.DISMISS_MAX && input.gameIds.every(id => typeof id === "string");
}
/** @param {Extract<BuildStateMutation,{kind:"buildIntentBind"}>} input */
function validBind(input) {
  if (typeof input.gameId !== "string") return false;
  if (input.guard === "updatedAt") return ownFields(input, [...SINGLE_FIELDS, "guard", "updatedAt"])
    && input.updatedAt instanceof Date && Number.isFinite(input.updatedAt.getTime());
  return ["empty", "missingUpdatedAt"].includes(input.guard) && ownFields(input, [...SINGLE_FIELDS, "guard"]);
}
/** @param {Record<string,any>} input @param {string[]} keys */
function ownFields(input, keys) {
  return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}
/** @param {BuildStateMutation} input */
function validPipeline(input) {
  const fields = input.kind === "buildIntentUpdate" ? FIELDS : input.kind === "buildIntentPending" ? PENDING_FIELDS : YOU_FIELDS;
  const pipeline = input.pipeline;
  return Array.isArray(pipeline) && pipeline.length > 0 && pipeline.length <= 3 && pipeline.every(stage =>
    !!stage && Object.getPrototypeOf(stage) === Object.prototype && ownFields(stage, ["$set"])
    && validSet(stage.$set, fields));
}
/** @param {Record<string,any>} set @param {Set<string>} fields */
function validSet(set, fields) {
  return !!set && Object.getPrototypeOf(set) === Object.prototype && Object.keys(set).length > 0
    && Object.keys(set).every(field => fields.has(field))
    && (!Object.hasOwn(set, "_schemaVersion") || set._schemaVersion === expectedVersion(COLLECTIONS.GAMES));
}

/** Exact previous filters, including missing/null and optimistic bind guard.
 * @param {string} userId @param {Readonly<BuildStateMutation>} mutation */
function buildStateFilter(userId, mutation) {
  if (mutation.kind === "buildIntentDismiss") return { userId, gameId: { $in: mutation.gameIds }, ...LIVE_GAME_MATCH,
    "buildIntent.status": "pending", isResumedFromReplay: { $ne: true } };
  if (mutation.kind === "buildIntentPending") return { userId, gameId: mutation.gameId, buildIntent: { $exists: false } };
  if (mutation.kind === "buildIntentBind") return { userId, gameId: mutation.gameId, "buildIntent.gameKey": { $exists: false }, ...bindGuard(mutation) };
  return { userId, gameId: mutation.gameId, ...LIVE_GAME_MATCH, isResumedFromReplay: { $ne: true } };
}
/** @param {Extract<BuildStateMutation,{kind:"buildIntentBind"}>} mutation */
function bindGuard(mutation) {
  if (mutation.guard === "empty") return { buildIntent: null };
  return { "buildIntent.updatedAt": mutation.guard === "updatedAt" ? mutation.updatedAt : { $exists: false } };
}
/** Every game command shares the admitted owner transaction; no upsert.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<BuildStateMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session */
function applyBuildState(db, owner, mutation, session) {
  const filter = buildStateFilter(owner.userId, mutation), options = { ...(session ? { session } : {}), upsert: false };
  return mutation.kind === "buildIntentDismiss"
    ? db.games.updateMany(filter, withUpdatedAt(mutation.pipeline), options)
    : db.games.updateOne(filter, withUpdatedAt(mutation.pipeline), options);
}
function invalid() { return Object.assign(new Error("game_stats_neutral_operation_invalid"), { code: "game_stats_neutral_operation_invalid", status: 503 }); }
module.exports = { immutableBuildState, applyBuildState, buildStateFilter };
