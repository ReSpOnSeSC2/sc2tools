"use strict";

const { types } = require("util");
const { gameWrite } = require("../util/userRevision");
const { dataFields } = require("./gameStatsCustomBuildEof");
const { immutableNeutralOwner } = require("./gameStatsCountNeutral");
const { immutableOpponentGameMutation, repairContextOwner } = require("./gameStatsOpponentGame");
const { writeOpponentGameIdentityRepair } = require("./gameStatsWrites");
const { assertRepairLiveness, REPAIR_LIVENESS_KINDS } = require("./gdprRepairLiveness");

/** Every producer input the opponent and game-stamp paths consume, except
 * playedAt, which is cloned when it is a Date. */
const STAMP_FIELDS = ["pulseId", "gameId", "toonHandle", "pulseCharacterId", "pulseLookupAttempted", "displayName",
  "race", "mmr", "leagueId", "result", "opening", "region"];
const OWNER_FIELDS = ["userId", "id", "epoch", "compatibility"];
const nativeGetTime = Date.prototype.getTime;

/** @typedef {Readonly<{ok:true,owner:Readonly<import('./gameStatsWrites').GameStatsOwner>}>
 * | Readonly<{ok:true,repair:Readonly<import('./gameStatsOpponentGame').OpponentRepairContext>}>
 * | Readonly<{ok:false,error:unknown}>} GameStampAdmission */

/** Copy the consumed inputs before the producer's first await.
 * @template {Record<string,any>} T @param {T} game @returns {Readonly<T>} */
function snapshotStampGame(game) {
  /** @type {Record<string,any>} */
  const copy = {};
  for (const field of STAMP_FIELDS) copy[field] = game[field];
  const playedAt = game.playedAt;
  copy.playedAt = types.isDate(playedAt) ? new Date(Reflect.apply(nativeGetTime, playedAt, [])) : playedAt;
  return /** @type {Readonly<T>} */ (Object.freeze(copy));
}

/** The region stamp no-ops that are decidable before any IO.
 * @param {Record<string,any>} game */
function regionStampPossible(game) {
  return typeof game.gameId === "string" && game.gameId.length > 0 && typeof game.region !== "string";
}

/** One producer-owned admission before the original IO. Only omission of
 * statsOwner permits a capture; admission never throws and is never charged
 * to the writer's pending slots or drain. Ordinary producers never accept a
 * repair context.
 * @param {Pick<import('./gameStatsWrites').GameStatsWrites,'capture'>} writer @param {string} userId
 * @param {Record<string,any>|undefined} options @param {boolean} possible @returns {Promise<GameStampAdmission>} */
function gameStampAdmission(writer, userId, options, possible) {
  return stampAdmission(writer, userId, options, possible, false);
}

/** The backfill entry, which the two genuine repair producers drive, is the
 * only one that may carry a repair context instead of a statsOwner.
 * @param {Pick<import('./gameStatsWrites').GameStatsWrites,'capture'>} writer @param {string} userId
 * @param {Record<string,any>} options @returns {Promise<GameStampAdmission>} */
function backfillStampAdmission(writer, userId, options) {
  return stampAdmission(writer, userId, options, true, true);
}

/** @param {Pick<import('./gameStatsWrites').GameStatsWrites,'capture'>} writer @param {string} userId
 * @param {Record<string,any>|undefined} options @param {boolean} possible @param {boolean} repairable
 * @returns {Promise<GameStampAdmission>} */
async function stampAdmission(writer, userId, options, possible, repairable) {
  try {
    if (!possible) return unavailable(failure("opponent_game_stamp_not_possible"));
    if (options === undefined) return await capturedAdmission(writer, userId);
    return await suppliedAdmission(writer, userId, options, repairable);
  } catch (error) {
    return unavailable(error);
  }
}

/** @param {Pick<import('./gameStatsWrites').GameStatsWrites,'capture'>} writer @param {string} userId
 * @param {Record<string,any>} options @param {boolean} repairable @returns {GameStampAdmission|Promise<GameStampAdmission>} */
function suppliedAdmission(writer, userId, options, repairable) {
  if (!plainOptions(options)) return unavailable(failure("opponent_game_stamp_options_invalid"));
  const owner = Object.getOwnPropertyDescriptor(options, "statsOwner"), repair = Object.getOwnPropertyDescriptor(options, "repair");
  if (repair && (owner || !repairable)) return unavailable(failure("opponent_game_stamp_options_invalid"));
  if (repair) return repairAdmission(repair, userId);
  if (owner) return Object.hasOwn(owner, "value") ? ownerAdmission(owner.value, userId) : unavailable(failure("game_stats_owner_unavailable"));
  return capturedAdmission(writer, userId);
}

/** @param {unknown} options */
function plainOptions(options) {
  return !!options && typeof options === "object" && Object.getPrototypeOf(options) === Object.prototype;
}

/** Exactly one bounded capture with immediate outcome handlers.
 * @param {Pick<import('./gameStatsWrites').GameStatsWrites,'capture'>} writer @param {string} userId
 * @returns {Promise<GameStampAdmission>} */
function capturedAdmission(writer, userId) {
  return writer.capture(userId).then(owner => ownerAdmission(owner, userId), error => unavailable(error));
}

/** @param {unknown} owner @param {string} userId @returns {GameStampAdmission} */
function ownerAdmission(owner, userId) {
  try {
    return Object.freeze({ ok: /** @type {true} */ (true), owner: copiedOwner(owner, userId) });
  } catch (error) {
    return unavailable(error);
  }
}

/** A genuine repair context becomes ready only with a live handle bound to
 * its full owner/epoch/fence/kind tuple. It never captures.
 * @param {PropertyDescriptor} descriptor @param {string} userId @returns {GameStampAdmission} */
function repairAdmission(descriptor, userId) {
  try {
    if (!Object.hasOwn(descriptor, "value")) return unavailable(failure("game_stats_repair_authority_unavailable"));
    const context = /** @type {import('./gameStatsOpponentGame').OpponentRepairContext} */ (descriptor.value);
    const owner = copiedOwner(repairContextOwner(context), userId);
    if (owner.id === null || owner.epoch !== context.fenceId || !REPAIR_LIVENESS_KINDS.includes(context.kind)) {
      return unavailable(failure("game_stats_repair_authority_unavailable"));
    }
    assertRepairLiveness(context.handle, owner, context.fenceId, context.kind);
    return Object.freeze({ ok: /** @type {true} */ (true), repair: Object.freeze({ owner, fenceId: context.fenceId,
      kind: context.kind, handle: context.handle }) });
  } catch (error) {
    return unavailable(error);
  }
}

/** @param {unknown} owner @param {string} userId @returns {Readonly<import('./gameStatsWrites').GameStatsOwner>} */
function copiedOwner(owner, userId) {
  if (!dataFields(owner, OWNER_FIELDS, ["userId", "id", "compatibility"])) throw failure("game_stats_owner_unavailable");
  const copied = immutableNeutralOwner(/** @type {import('./gameStatsWrites').GameStatsOwner} */ (owner));
  if (copied.userId !== userId) throw failure("game_stats_owner_unavailable");
  return copied;
}

/** The descriptor and the admitted owner resolve before any UserRevision work.
 * @param {import('./gameStatsWrites').GameStatsWrites} writer @param {import('../util/userRevision').UserRevision|null} revisions
 * @param {string} userId @param {string} gameId @param {string} region @param {GameStampAdmission|undefined} admission
 * @returns {Promise<void>} */
async function stampOpponentGameRegion(writer, revisions, userId, gameId, region, admission) {
  const mutation = immutableOpponentGameMutation({ kind: "opponentGameRegion", gameId, region });
  const ready = admitted(admission);
  if (!("owner" in ready)) throw failure("opponent_game_region_repair_rejected");
  const owner = ready.owner;
  await gameWrite(revisions, userId, () => writer.write(owner, mutation));
}

/** Ordinary heals use the generic writer; fenced heals only the repair path.
 * @param {import('./gameStatsWrites').GameStatsWrites} writer @param {import('../util/userRevision').UserRevision|null} revisions
 * @param {string} userId @param {unknown} pulseId @param {{region?:string,pulseCharacterId?:string}} patch
 * @param {GameStampAdmission|undefined} admission @returns {Promise<import('mongodb').UpdateResult>} */
async function healOpponentGameIdentity(writer, revisions, userId, pulseId, patch, admission) {
  const mutation = immutableOpponentGameMutation(/** @type {import('./gameStatsOpponentGame').OpponentGameIdentityMutation} */ (
    { kind: "opponentGameIdentity", pulseId, ...patch }));
  const ready = admitted(admission);
  if ("repair" in ready) {
    const repair = ready.repair;
    return gameWrite(revisions, userId, () => writeOpponentGameIdentityRepair(writer, repair, /** @type {any} */ (mutation)));
  }
  const owner = ready.owner;
  return gameWrite(revisions, userId, () => writer.write(owner, mutation));
}

/** Missing and unavailable admissions throw their recorded reason.
 * @param {GameStampAdmission|undefined} admission */
function admitted(admission) {
  if (!admission) throw failure("opponent_game_stamp_admission_required");
  if (!admission.ok) throw admission.error;
  return admission;
}

/** @param {unknown} error @returns {GameStampAdmission} */
function unavailable(error) { return Object.freeze({ ok: /** @type {false} */ (false), error }); }

/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

module.exports = { snapshotStampGame, regionStampPossible, gameStampAdmission, backfillStampAdmission, stampOpponentGameRegion,
  healOpponentGameIdentity };
