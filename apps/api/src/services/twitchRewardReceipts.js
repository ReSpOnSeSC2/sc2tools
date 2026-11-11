"use strict";

const { sha256 } = require("../util/hash");
const { KEEP_MS, PENDING_MS, NEXT_GAME_MS } = require("./twitchRewardPolicy");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const RUNNING_MS = 2 * 60_000;
const MAX_OWNER_PENDING = 8;
const OWNER_ORDER = /** @type {const} */ ({ userId: 1, receivedAt: 1, _id: 1 });
const VIEWER_FIELDS = { input: "", name: "", login: "", viewerId: "", pendingSlot: "" };
const PENDING = { kind: "redemption", state: "pending" };

/** @param {unknown} error */
const duplicate = error => /** @type {{code?:number}} */ (error)?.code === 11000;

/** @param {Record<string,any>} receipt */
function omitViewer(receipt) {
  const result = { ...receipt };
  for (const field of Object.keys(VIEWER_FIELDS)) delete result[field];
  return result;
}
const REWARD_ACTIVITY_PROJECTION = Object.freeze({
  _id: 0, rewardId: 1, rewardTitle: 1, action: 1, receivedAt: 1, state: 1, reason: 1, settlement: 1,
});

class TwitchRewardReceipts {
  /** @param {import('mongodb').Collection<any>} rows @param {()=>number} [now] */
  constructor(rows, now = Date.now) { this.rows = rows; this.now = now; }

  async ensureIndexes() {
    await this.rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.rows.createIndex({ kind: 1, state: 1, receivedAt: 1 });
    await this.rows.createIndex({ userId: 1, kind: 1, receivedAt: -1 });
    await this.rows.createIndex({ userId: 1, pendingSlot: 1 }, {
      unique: true, partialFilterExpression: { pendingSlot: { $exists: true } },
    });
    await this.rows.createIndex({ kind: 1, state: 1, unavailable: 1, ...OWNER_ORDER });
    await this.rows.createIndex({ kind: 1, state: 1, unavailable: 1, deadlineAt: 1 });
    await this.rows.createIndex({ kind: 1, state: 1, dispatchDeadline: 1 });
  }

  /**
   * Keep the durable receipt for every redemption. A full owner queue
   * admits only redacted metadata for the configured unavailable refund.
   * @param {string} userId @param {NonNullable<ReturnType<import('./twitchRewardPolicy').signedRedemption>>} redemption
   * @param {string} settingsKey @param {string} action @param {boolean} [settleUnavailable]
   */
  async accept(userId, redemption, settingsKey, action, settleUnavailable = false) {
    const _id = sha256(JSON.stringify(["twitch-redemption", userId, redemption.broadcasterId, redemption.redemptionId]));
    if (await this.rows.findOne({ _id }, { projection: { _id: 1 } })) return false;
    const now = this.now();
    const data = stampVersion({ _id, ...PENDING, userId, ...redemption, settingsKey, action,
      settleUnavailable: settleUnavailable && redemption.providerStatus === "unfulfilled",
      receivedAt: new Date(now), deadlineAt: new Date(now + PENDING_MS), expiresAt: new Date(now + KEEP_MS) }, COLLECTIONS.TWITCH_REWARD_RECEIPTS);
    const slots = await this.availableSlots(userId);
    // Different redemptions try different seats during a simultaneous burst.
    const first = parseInt(_id.slice(0, 8), 16) % (slots.length || 1);
    for (let offset = 0; offset < slots.length; offset++) {
      try {
        await this.rows.insertOne({ ...data, pendingSlot: slots[(first + offset) % slots.length] });
        return true;
      } catch (error) {
        if (!duplicate(error)) throw error;
        if (/** @type {{keyPattern?:{_id?:number}}} */ (error).keyPattern?._id) return false;
      }
    }
    const unavailable = omitViewer({ ...data, reason: "queue_full" });
    if (data.settleUnavailable) unavailable.unavailable = true;
    else {
      unavailable.state = "skipped";
      unavailable.settlement = "none";
      unavailable.completedAt = new Date(now);
      delete unavailable.settingsKey;
    }
    try { await this.rows.insertOne(unavailable); return true; }
    catch (error) { if (duplicate(error)) return false; throw error; }
  }

  /** Include old unslotted pending receipts until they drain.
   * @param {string} userId */
  async availableSlots(userId) {
    const pending = await this.rows.find({ ...PENDING, userId, unavailable: null },
      { projection: { _id: 0, pendingSlot: 1 }, maxTimeMS: 2000 }).limit(MAX_OWNER_PENDING).toArray();
    const occupied = new Set(pending.map(row => row.pendingSlot));
    return Array.from({ length: MAX_OWNER_PENDING }, (_, index) => index)
      .filter(slot => !occupied.has(slot)).slice(0, MAX_OWNER_PENDING - pending.length);
  }

  /** @param {any} row @param {number} seconds */
  async admitViewer(row, seconds) {
    const _id = sha256(JSON.stringify(["twitch-cooldown", row.userId, row.broadcasterId, row.rewardId, row.viewerId]));
    const now = this.now(), until = new Date(now + seconds * 1000);
    try {
      const result = await this.rows.updateOne({ _id, expiresAt: { $lte: new Date(now) } }, {
        $setOnInsert: stampVersion({ kind: "cooldown", userId: row.userId }, COLLECTIONS.TWITCH_REWARD_RECEIPTS),
        $set: { expiresAt: until },
      }, { upsert: true });
      return result.modifiedCount === 1 || result.upsertedCount === 1;
    } catch (error) { if (/** @type {any} */ (error)?.code === 11000) return false; throw error; }
  }

  /** Select a single FIFO row per owner and advance by owner key, wrapping
   * once. Each lookup skips the entire previous owner's queue by index.
   * @param {string|null} [after] @param {number} [limit] @param {boolean} [unavailable] @param {string[]} [excluded]
   */
  async pending(after = null, limit = 6, unavailable = false, excluded = []) {
    let lower = after;
    let wrapped = after === null;
    const selected = [];
    while (selected.length < limit) {
      const userId = {
        ...(lower ? { $gt: lower } : {}),
        ...(wrapped && after ? { $lte: after } : {}),
        ...(excluded.length ? { $nin: excluded } : {}),
      };
      const next = await this.rows.findOne({ ...PENDING, unavailable: unavailable ? true : null,
        ...(Object.keys(userId).length ? { userId } : {}) },
        { sort: OWNER_ORDER, maxTimeMS: 2000 });
      if (next) { selected.push(next); lower = next.userId; }
      else if (wrapped) break;
      else { lower = null; wrapped = true; }
    }
    return selected;
  }

  /** Expiry strips input independently of provider access or queue position.
   * Old receipts have no settlement flag and still get the existing policy check. */
  async redactExpiredPending() {
    const now = new Date(this.now());
    const refund = { $and: [{ $eq: ["$providerStatus", "unfulfilled"] },
      { $ne: [{ $ifNull: ["$settleUnavailable", true] }, false] }] };
    await this.rows.updateMany({ ...PENDING, unavailable: null,
      $or: [{ deadlineAt: { $lte: now } }, { deadlineAt: null }] }, [
      { $set: {
        state: { $cond: [refund, "pending", "skipped"] },
        unavailable: { $cond: [refund, true, "$$REMOVE"] },
        reason: "redemption_expired",
        settlement: { $cond: [refund, "$$REMOVE", "none"] },
        completedAt: { $cond: [refund, "$$REMOVE", now] },
        settingsKey: { $cond: [refund, "$settingsKey", "$$REMOVE"] },
      } },
      { $unset: Object.keys(VIEWER_FIELDS) },
    ]);
  }

  /** @param {string} userId */
  waiting(userId) {
    return this.rows.findOne({ kind: "redemption", state: "awaiting_game", userId }, { sort: { receivedAt: 1 } });
  }

  expiredWaiting() {
    return this.rows.find({ kind: "redemption", state: "awaiting_game", unavailable: null,
      deadlineAt: { $lte: new Date(this.now()) } }, { maxTimeMS: 2000 })
      .sort({ deadlineAt: 1 }).limit(12).toArray();
  }

  /** @param {any} row */
  async claim(row) {
    const now = this.now();
    const pending = row.state === "pending" ? row.unavailable === true
      ? { unavailable: true } : { unavailable: null, deadlineAt: { $gt: new Date(now) } } : {};
    const result = await this.rows.updateOne({ _id: row._id, state: row.state, ...pending }, {
      $set: { state: "dispatching", dispatchDeadline: new Date(now + RUNNING_MS) },
      // Only the winner's in-memory action needs viewer input. Recovery
      // already treats an abandoned dispatch as unconfirmed.
      $unset: VIEWER_FIELDS,
    });
    return result.modifiedCount === 1;
  }

  /** @param {any} row @param {string|null} gameKey */
  async waitForGame(row, gameKey) {
    await this.rows.updateOne({ _id: row._id, state: "dispatching" }, {
      $set: { state: "awaiting_game", gameKey, deadlineAt: row.state === "awaiting_game" ? row.deadlineAt : new Date(this.now() + NEXT_GAME_MS) },
      $unset: { dispatchDeadline: "", input: "", name: "", login: "", viewerId: "" },
    });
  }

  /** @param {any} row @param {string} state @param {string} reason @param {string} settlement */
  async finish(row, state, reason, settlement = "none") {
    await this.rows.updateOne({ _id: row._id, state: "dispatching" }, {
      $set: { state, reason, settlement, completedAt: new Date(this.now()) },
      $unset: { ...VIEWER_FIELDS, unavailable: "", gameKey: "", settingsKey: "", dispatchDeadline: "" },
    });
  }

  async recoverUnknown() {
    await this.rows.updateMany({ kind: "redemption", state: "dispatching", dispatchDeadline: { $lte: new Date(this.now()) } }, {
      $set: { state: "unknown", reason: "dispatch_unconfirmed", settlement: "unconfirmed", completedAt: new Date(this.now()) },
      $unset: { ...VIEWER_FIELDS, unavailable: "", gameKey: "", settingsKey: "", dispatchDeadline: "" },
    });
  }

  /** @param {string} userId */
  async recent(userId) {
    return this.rows.find({ kind: "redemption", userId }, { projection: REWARD_ACTIVITY_PROJECTION })
      .sort({ receivedAt: -1 }).limit(20).toArray();
  }
}

module.exports = { TwitchRewardReceipts, REWARD_ACTIVITY_PROJECTION };
