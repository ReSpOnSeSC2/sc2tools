"use strict";

const { randomUUID } = require("crypto");
const { config } = require("./twitchAutomationPolicy");
const KINDS = ["prediction", "marker"];
const TERMINAL = ["disabled", "skipped", "resolved", "canceled", "created", "error"];
const TRANSITIONS = {
  waiting: ["creating", "skipped", "canceled"],
  pending: ["creating", "skipped", "canceled"],
  creating: ["active", "created", "unknown", "error"],
  active: ["locking", "resolving", "canceling", "unknown"],
  locking: ["locked", "unknown", "error"],
  locked: ["resolving", "canceling", "unknown"],
  resolving: ["resolved", "unknown", "error"],
  canceling: ["canceled", "unknown", "error"],
  unknown: ["active", "locked", "resolved", "canceled", "created", "unknown", "error"],
};
/** @param {string} code @returns {never} */
function invalid(code) { throw Object.assign(new Error(code), { status: 400, code }); }
/** @param {unknown} value */
function key(value) { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\p{Cc}]/u.test(value); }
/** @param {string} kind @param {string} from @param {string} to */
function transition(kind, from, to) {
  if (!KINDS.includes(kind) || !(/** @type {Record<string,string[]>} */ (TRANSITIONS))[from]?.includes(to)) invalid("invalid_twitch_transition");
  if (kind === "marker" && !["pending", "creating", "created", "unknown", "error", "skipped", "canceled"].includes(to)) invalid("invalid_marker_transition");
}

/** Derive indexed recovery time from durable states. Unknown inserts with no
 * provider ID deliberately have no automatic retry: POST may have succeeded. */
function nextCheckStage() {
  /** @param {string} kind */
  const next = kind => ({ $switch: { branches: [
    { case: { $in: [`$${kind}.status`, ["creating", "locking", "resolving", "canceling"]] }, then: `$${kind}.leaseUntil` },
    { case: { $eq: [`$${kind}.status`, "pending"] }, then: "$createdAt" },
    { case: { $eq: [`$${kind}.status`, "waiting"] }, then: "$deadlineAt" },
    ...(kind === "prediction" ? [{ case: { $in: ["$prediction.status", ["active", "locked"]] }, then: { $ifNull: ["$settlement.requestedAt", "$deadlineAt"] } }] : []),
    { case: { $eq: [`$${kind}.status`, "unknown"] }, then: `$${kind}.retryAt` },
  ], default: null } });
  return { $set: { nextCheckAt: { $min: [next("prediction"), next("marker")] } } };
}

/** Journal only: no provider credentials, responses, viewer names or points.
 * Every mutation is owner/game CAS; leases never permit replaying an uncertain
 * create. Provider connection leases serialize separate games/rematch checks. */
class TwitchAutomationReceipts {
  /** @param {{collection:import('mongodb').Collection<any>,now?:()=>number}} deps */
  constructor({ collection, now = Date.now }) { this.rows = collection; this.now = now; }

  async ensureIndexes() {
    await this.rows.createIndex({ userId: 1, gameKey: 1 }, { unique: true });
    await this.rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.rows.createIndex({ nextCheckAt: 1 });
    await this.rows.createIndex({ userId: 1, opponentKey: 1, createdAt: -1 });
  }

  /** A caller holds its provider connection lease across rematch check/reserve.
   * @param {string} userId @param {string} gameKey
   * @param {{accountId:string,connectionRevision:string,opponentKey:string,prediction:'pending'|'disabled'|'skipped',marker:'waiting'|'pending'|'disabled'|'skipped',reason?:string,matchStartedAt?:Date}} input */
  async reserve(userId, gameKey, input) {
    if (![userId, gameKey, input.accountId, input.connectionRevision, input.opponentKey].every(key) || gameKey.length > 120 ||
      !["pending", "disabled", "skipped"].includes(input.prediction) || !["waiting", "pending", "disabled", "skipped"].includes(input.marker)) invalid("invalid_twitch_receipt");
    const now = new Date(this.now());
    const doc = { userId, gameKey, accountId: input.accountId, connectionRevision: input.connectionRevision, opponentKey: input.opponentKey,
      createdAt: now, updatedAt: now, deadlineAt: new Date(this.now() + config.limits.resultTimeoutMs),
      expiresAt: new Date(this.now() + config.limits.receiptTtlMs),
      prediction: { status: input.prediction, revision: 0 }, marker: { status: input.marker, revision: 0 },
      ...(input.matchStartedAt instanceof Date && Number.isFinite(input.matchStartedAt.getTime()) ? { matchStartedAt: input.matchStartedAt } : {}),
      ...([input.prediction, input.marker].includes("pending") ? { nextCheckAt: now } : input.marker === "waiting" ? { nextCheckAt: new Date(this.now() + config.limits.resultTimeoutMs) } : {}),
      reason: typeof input.reason === "string" ? input.reason.slice(0, 80) : null };
    try { await this.rows.updateOne({ userId, gameKey }, { $setOnInsert: doc }, { upsert: true, maxTimeMS: 1500 }); }
    catch (error) { if (/** @type {any} */ (error)?.code !== 11000) throw error; }
    return this.read(userId, gameKey);
  }
  /** @param {string} userId @param {string} gameKey */
  read(userId, gameKey) { return this.rows.findOne({ userId, gameKey }, { projection: { _id: 0 }, maxTimeMS: 1500 }); }
  /** @param {string} userId @param {string} opponentKey @param {string} exceptGame */
  recentOpponent(userId, opponentKey, exceptGame) {
    return this.rows.findOne({ userId, opponentKey, gameKey: { $ne: exceptGame }, createdAt: { $gte: new Date(this.now() - config.limits.rematchMs) },
      "prediction.status": { $nin: ["disabled", "skipped", "error"] } }, { projection: { _id: 0, gameKey: 1, createdAt: 1 }, sort: { createdAt: -1 }, maxTimeMS: 1500 });
  }

  /** Persist the desired final state before contacting Twitch. A result or
   * cancellation received during CREATE survives that lease and any restart.
   * Cancel wins over an unconfirmed result; terminal provider receipts stay
   * immutable. A not-yet-dispatched prediction is canceled without a POST.
   * @param {string} userId @param {string} gameKey
   * @param {{action:'cancel'|'resolve',outcome?:'win'|'loss',reason:'verified_result'|'short_game'|'result_timeout'|'dock_cancel'|'game_ended_before_create'}} request */
  async requestSettlement(userId, gameKey, request) {
    if (!["cancel", "resolve"].includes(request.action) || request.action === "resolve" && !["win", "loss"].includes(request.outcome || "")
      || !["verified_result", "short_game", "result_timeout", "dock_cancel", "game_ended_before_create"].includes(request.reason)) invalid("invalid_twitch_settlement");
    const now = new Date(this.now());
    const desired = { action: request.action, ...(request.action === "resolve" ? { outcome: request.outcome } : {}), reason: request.reason, requestedAt: now };
    return this.rows.findOneAndUpdate({ userId, gameKey, "prediction.status": { $nin: TERMINAL },
      ...(request.action === "resolve" ? { settlement: { $exists: false } } : { "settlement.action": { $ne: "cancel" } }) }, [
      { $set: { settlement: { $literal: desired }, updatedAt: now,
        "prediction.status": { $cond: [{ $eq: ["$prediction.status", "pending"] }, "canceled", "$prediction.status"] },
        "prediction.retryAt": { $cond: [{ $and: [{ $eq: ["$prediction.status", "unknown"] }, { $eq: [{ $type: "$prediction.predictionId" }, "string"] }] }, now, "$prediction.retryAt"] } } },
      nextCheckStage(),
    ], { returnDocument: "after", projection: { _id: 0 }, maxTimeMS: 1500 });
  }

  /** @param {string} userId @param {string} gameKey @param {'prediction'|'marker'} kind @param {string} from @param {string} to */
  async claim(userId, gameKey, kind, from, to) {
    transition(kind, from, to);
    if (!["creating", "locking", "resolving", "canceling", "unknown"].includes(to)) invalid("invalid_twitch_claim");
    const now = new Date(this.now()), leaseId = randomUUID();
    // Uncertain CREATE is never claimable as pending again. Only recovery can
    // mark an expired in-flight insert unknown, without another provider POST.
    const doc = await this.rows.findOneAndUpdate({ userId, gameKey, [`${kind}.status`]: from,
      ...(["locking", "resolving", "canceling"].includes(to) ? { [`${kind}.predictionId`]: { $type: "string" } } : {}),
      $or: [{ [`${kind}.leaseUntil`]: { $exists: false } }, { [`${kind}.leaseUntil`]: { $lte: now } }] }, [
      { $set: { [`${kind}.status`]: to, [`${kind}.leaseId`]: leaseId,
        [`${kind}.leaseUntil`]: new Date(this.now() + config.limits.leaseMs), [`${kind}.revision`]: { $add: [`$${kind}.revision`, 1] }, updatedAt: now } },
      nextCheckStage(),
    ], { returnDocument: "after", maxTimeMS: 1500 });
    return doc ? { userId, gameKey, kind, status: to, leaseId, revision: doc[kind].revision } : null;
  }

  /** @param {{userId:string,gameKey:string,kind:'prediction'|'marker',status:string,leaseId:string,revision:number}} ticket
   * @param {string} status @param {{predictionId?:string,winId?:string,lossId?:string,markerId?:string,positionSeconds?:number,reason?:string,retryAt?:Date}} [fields] */
  async finish(ticket, status, fields = {}) {
    transition(ticket.kind, ticket.status, status);
    const allowed = ticket.kind === "prediction" ? ["predictionId", "winId", "lossId", "reason", "retryAt"] : ["markerId", "positionSeconds", "reason", "retryAt"];
    if (Object.keys(fields).some(field => !allowed.includes(field))) invalid("invalid_twitch_receipt_fields");
    if (ticket.status !== "creating" && ["predictionId", "winId", "lossId", "markerId"].some(field => Object.hasOwn(fields, field))) invalid("twitch_receipt_ids_are_immutable");
    if (fields.retryAt && (ticket.kind !== "prediction" || status !== "unknown" || ticket.status === "creating" && !key(fields.predictionId))) invalid("unknown_twitch_create_cannot_retry");
    /** @type {Record<string,any>} */ const set = {};
    for (const [name, value] of Object.entries(fields)) {
      if (name === "retryAt" ? !(value instanceof Date) || !Number.isFinite(value.getTime()) : name === "positionSeconds" ? !Number.isInteger(value) || Number(value) < 0 : !key(value)) invalid("invalid_twitch_receipt_fields");
      set[`${ticket.kind}.${name}`] = { $literal: value };
    }
    if (ticket.kind === "prediction" && status === "active" && ticket.status === "creating" && ![fields.predictionId, fields.winId, fields.lossId].every(key)) invalid("prediction_receipt_ids_required");
    if (ticket.kind === "marker" && status === "created" && ticket.status === "creating" && !key(fields.markerId)) invalid("marker_receipt_id_required");
    const now = new Date(this.now());
    return this.rows.findOneAndUpdate({ userId: ticket.userId, gameKey: ticket.gameKey,
      [`${ticket.kind}.status`]: ticket.status, [`${ticket.kind}.leaseId`]: ticket.leaseId,
      ...(["active", "locked", "resolved", "canceled"].includes(status) && ticket.status === "unknown" ? { [`${ticket.kind}.predictionId`]: { $type: "string" } } : {}),
      ...(["active", "locked"].includes(status) && ticket.status === "unknown" ? { "prediction.winId": { $type: "string" }, "prediction.lossId": { $type: "string" } } : {}),
      ...(fields.retryAt && ticket.status !== "creating" ? { [`${ticket.kind}.predictionId`]: { $type: "string" } } : {}),
      [`${ticket.kind}.revision`]: ticket.revision, [`${ticket.kind}.leaseUntil`]: { $gt: now } }, [
      { $set: { ...set, [`${ticket.kind}.status`]: status, [`${ticket.kind}.revision`]: ticket.revision + 1, updatedAt: now } },
      { $unset: [`${ticket.kind}.leaseId`, `${ticket.kind}.leaseUntil`] }, nextCheckStage(),
    ], { returnDocument: "after", projection: { _id: 0 }, maxTimeMS: 1500 });
  }

  /** A loading event alone must never produce a late start marker. @param {string} userId @param {string} gameKey */
  async expireWaitingMarker(userId, gameKey) {
    const now = new Date(this.now());
    return this.rows.findOneAndUpdate({ userId, gameKey, deadlineAt: { $lte: now }, "marker.status": "waiting" }, [
      { $set: { "marker.status": "skipped", "marker.reason": "start_not_received", updatedAt: now } }, nextCheckStage(),
    ], { returnDocument: "after", projection: { _id: 0 }, maxTimeMS: 1500 });
  }

  /** Reconnect may renew a grant for the same verified broadcaster. This never
   * transfers a receipt to a different provider identity or changes its IDs.
   * @param {string} userId @param {string} gameKey @param {string} accountId @param {string} previousRevision @param {string} revision */
  async renewConnection(userId, gameKey, accountId, previousRevision, revision) {
    if (![accountId, previousRevision, revision].every(key)) invalid("invalid_twitch_receipt");
    return this.rows.findOneAndUpdate({ userId, gameKey, accountId, connectionRevision: previousRevision },
      { $set: { connectionRevision: revision, updatedAt: new Date(this.now()) } }, { returnDocument: "after", projection: { _id: 0 }, maxTimeMS: 1500 });
  }

  /** A crash before dispatch must not send a late stream marker on recovery.
   * @param {string} userId @param {string} gameKey */
  async abandonPendingMarker(userId, gameKey) {
    return this.rows.findOneAndUpdate({ userId, gameKey, "marker.status": "pending" }, [
      { $set: { "marker.status": "skipped", "marker.reason": "start_not_dispatched", updatedAt: new Date(this.now()) } }, nextCheckStage(),
    ], { returnDocument: "after", projection: { _id: 0 }, maxTimeMS: 1500 });
  }

  /** @param {number} [limit] */
  due(limit = config.limits.recoveryBatch) {
    const bound = Math.max(1, Math.min(config.limits.recoveryBatch, Number.isInteger(limit) ? limit : config.limits.recoveryBatch));
    return this.rows.find({ nextCheckAt: { $lte: new Date(this.now()) } }, { projection: { _id: 0 }, maxTimeMS: 1500 }).sort({ nextCheckAt: 1 }).limit(bound).toArray();
  }
}

module.exports = { TwitchAutomationReceipts, TRANSITIONS, TERMINAL, transition };
