"use strict";

const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { withUpdatedAt } = require("../util/corpusUpdatedAt");
const { tagClassificationPipeline } = require("./buildIntentGuards");

/** @typedef {{you:Readonly<import('./buildIntentGuards').AxisOutcome>,
 * opponent:Readonly<import('./buildIntentGuards').AxisOutcome>,payloadBuild:string|null,
 * payloadStrategy:string|null,policyBuild:string|null,policyStrategy:string|null,
 * clearStaging:boolean}} CustomBuildIngestTagDecision */
/** @typedef {{kind:"customBuildIngestTag",gameId:string,expectedRevision:string|null,
 * decision:Readonly<CustomBuildIngestTagDecision>}} CustomBuildIngestTagMutation */
/** @typedef {{_id:unknown}|null} CustomBuildIngestTagResult */
/** @typedef {{expectedRevision?:string|null,
 * statsOwner?:import('./gameStatsWrites').GameStatsOwner}} TagSingleGameOptions */

const DECISION_FIELDS = ["you", "opponent", "payloadBuild", "payloadStrategy", "policyBuild", "policyStrategy", "clearStaging"];
const GAME_FIELDS = ["gameId", "myRace", "myBuild", "buildLog", "oppBuildLog", "spatial", "presetEvidence", "durationSec", "gameVersion", "gameBuild", "date"];

/** @param {any} input @param {string[]} allowed @param {string[]} required */
function dataFields(input, allowed, required) {
  return !!input && Object.getPrototypeOf(input) === Object.prototype
    && Reflect.ownKeys(input).every(key => typeof key === "string" && allowed.includes(key))
    && required.every(key => Object.hasOwn(input, key))
    && Object.values(Object.getOwnPropertyDescriptors(input)).every(field => Object.hasOwn(field, "value"));
}

/** @param {any} axis */
function validAxis(axis) {
  if (!dataFields(axis, ["mode", "name", "slug"], ["mode"])) return false;
  if (axis.mode === "set") return dataFields(axis, ["mode", "name", "slug"], ["mode", "name", "slug"])
    && typeof axis.name === "string" && typeof axis.slug === "string";
  return dataFields(axis, ["mode"], ["mode"]) && ["unset", "keep"].includes(axis.mode);
}

/** @param {any} value */
function nullableString(value) { return value === null || typeof value === "string"; }

/** @param {any} decision */
function validDecision(decision) {
  return dataFields(decision, DECISION_FIELDS, DECISION_FIELDS)
    && validAxis(decision.you) && validAxis(decision.opponent)
    && nullableString(decision.payloadBuild) && nullableString(decision.payloadStrategy)
    && nullableString(decision.policyBuild) && nullableString(decision.policyStrategy)
    && typeof decision.clearStaging === "boolean";
}

/** @param {CustomBuildIngestTagMutation} input */
function validMutation(input) {
  return dataFields(input, ["kind", "gameId", "expectedRevision", "decision"], ["kind", "gameId", "expectedRevision", "decision"])
    && input.kind === "customBuildIngestTag" && typeof input.gameId === "string"
    && nullableString(input.expectedRevision) && validDecision(input.decision);
}

/** Only the server-owned decision enters the writer; no filter, expression,
 * session, repair authority or caller-declared neutrality is accepted.
 * @param {CustomBuildIngestTagMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<CustomBuildIngestTagMutation>} */
function immutableCustomBuildIngestTag(input, options = {}) {
  if (!validMutation(input) || !dataFields(options, [], [])) throw failure("game_stats_neutral_operation_invalid");
  const copied = BSON.deserialize(BSON.serialize(input));
  if (!isDeepStrictEqual(input, copied)) throw failure("game_stats_neutral_operation_invalid");
  Object.freeze(copied.decision.you); Object.freeze(copied.decision.opponent);
  Object.freeze(copied.decision);
  return Object.freeze(/** @type {CustomBuildIngestTagMutation} */ (copied));
}

/** Copy only consumed payload data before the owner/library/policy awaits.
 * structuredClone retains explicit undefined and Date values, unlike a whole
 * raw-game BSON round trip. This private snapshot is never returned to callers.
 * @param {Record<string,any>} game @returns {Record<string,any>} */
function snapshotTagGame(game) {
  /** @type {Record<string,any>} */ const data = {};
  for (const field of GAME_FIELDS) data[field] = game[field];
  data.opponent = game.opponent && typeof game.opponent === "object"
    ? { race: game.opponent.race, strategy: game.opponent.strategy } : game.opponent;
  return Object.freeze(structuredClone(data));
}

/** The original optional revision fence and two-axis pipeline, in the same
 * owner-first session. Never add a membership predicate or upsert here.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<CustomBuildIngestTagMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session
 * @returns {Promise<CustomBuildIngestTagResult>} */
async function applyCustomBuildIngestTag(db, owner, mutation, session) {
  const written = await db.games.findOneAndUpdate(
    { userId: owner.userId, gameId: mutation.gameId,
      ...(mutation.expectedRevision !== null ? { _customBuildRevision: mutation.expectedRevision } : {}) },
    withUpdatedAt(tagClassificationPipeline(mutation.decision)),
    { projection: { _id: 1 }, upsert: false, ...(session ? { session } : {}) },
  );
  if (mutation.expectedRevision !== null && !written) {
    throw Object.assign(new Error("custom_build_tag_superseded"), { code: "custom_build_tag_superseded" });
  }
  return written;
}

/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { immutableCustomBuildIngestTag, applyCustomBuildIngestTag, snapshotTagGame };
