"use strict";
const { BSON } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { MMR_FLOOR, MMR_CEILING } = require("../util/mmrBracketing");

const MAX_ID_BYTES = 16 * 1024;
/** @typedef {{kind:"pulseGameStamp",id:any,field:"mmr"|"league",value:number|null}} PulseStampMutation */

/** Exact BSON identity is captured before owner/provider/floor awaits.
 * A malformed or oversized identity never becomes a broader query.
 * @param {any} id */
function copyPulseId(id) {
  if (id === undefined || BSON.calculateObjectSize({ id }) > MAX_ID_BYTES) throw invalid();
  const bytes = BSON.serialize({ id }), copied = BSON.deserialize(bytes);
  if (!isDeepStrictEqual(id, copied.id) || !isDeepStrictEqual(bytes, BSON.serialize(copied))) throw invalid();
  return copied.id;
}

/** Only the two server-owned Pulse fields can use count-neutral carry.
 * No query, membership/date patch, options or caller-provided field path.
 * @param {PulseStampMutation} input @param {Record<string,any>} [options]
 * @returns {Readonly<PulseStampMutation>} */
function immutablePulseStamp(input, options = {}) {
  if (!stampFields(input) || Object.keys(options).length || !validValue(input.field, input.value)) throw invalid();
  return Object.freeze({ kind: "pulseGameStamp", id: copyPulseId(input.id), field: input.field, value: input.value });
}
/** @param {PulseStampMutation} input */
function stampFields(input) {
  return !!input && Object.getPrototypeOf(input) === Object.prototype && input.kind === "pulseGameStamp"
    && ["kind", "id", "field", "value"].every(key => Object.hasOwn(input, key))
    && Object.keys(input).length === 4;
}
/** @param {string} field @param {number|null} value */
function validValue(field, value) {
  if (field !== "mmr" && field !== "league") return false;
  if (value === null) return true;
  return Number.isInteger(value) && (field === "mmr" ? value >= MMR_FLOOR && value <= MMR_CEILING : value >= 0 && value <= 6);
}

/** Keep the original Mongo numeric/one-shot predicate. Each field remains an
 * independent stamp, and a completed provider miss consumes only its marker.
 * @param {import('../db/connect').DbContext} db
 * @param {import('./gameStatsWrites').GameStatsOwner} owner
 * @param {Readonly<PulseStampMutation>} mutation
 * @param {import('mongodb').ClientSession|undefined} session */
async function applyPulseStamp(db, owner, mutation, session) {
  const field = mutation.field === "mmr" ? "opponent.mmr" : "opponent.leagueId";
  const marker = mutation.field === "mmr" ? "opponent.mmrLookupAttempted" : "opponent.leagueLookupAttempted";
  /** @type {Record<string,boolean|number|string>} */
  const set = { [marker]: true };
  if (mutation.value !== null) set[field] = mutation.value;
  if (mutation.field === "mmr" && mutation.value !== null) set["opponent.mmrSource"] = "pulse";
  const result = await db.games.updateOne({ userId: owner.userId, _id: { $eq: mutation.id },
    [field]: { $not: { $type: "number" } }, [marker]: { $ne: true } },
  { $set: set }, { ...(session ? { session } : {}), upsert: false });
  if (result.acknowledged !== true) throw Object.assign(new Error("game_stats_pulse_write_unacknowledged"), { status: 503 });
  return result;
}
function invalid() { return Object.assign(new Error("game_stats_neutral_operation_invalid"), { status: 503 }); }

module.exports = { immutablePulseStamp, copyPulseId, applyPulseStamp, MAX_ID_BYTES };
