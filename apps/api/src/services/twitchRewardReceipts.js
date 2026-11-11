"use strict";

const { sha256 } = require("../util/hash");
const { KEEP_MS, PENDING_MS, NEXT_GAME_MS } = require("./twitchRewardPolicy");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const RUNNING_MS = 2 * 60_000;

class TwitchRewardReceipts {
  /** @param {import('mongodb').Collection<any>} rows @param {()=>number} [now] */
  constructor(rows, now = Date.now) { this.rows = rows; this.now = now; }

  async ensureIndexes() {
    await this.rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.rows.createIndex({ kind: 1, state: 1, receivedAt: 1 });
    await this.rows.createIndex({ userId: 1, kind: 1, receivedAt: -1 });
  }

  /** @param {string} userId @param {NonNullable<ReturnType<import('./twitchRewardPolicy').signedRedemption>>} redemption @param {string} settingsKey @param {string} action */
  async accept(userId, redemption, settingsKey, action) {
    const _id = sha256(JSON.stringify(["twitch-redemption", userId, redemption.broadcasterId, redemption.redemptionId]));
    const now = this.now();
    const receivedAt = new Date(now);
    const data = stampVersion({ _id, kind: "redemption", state: "pending", userId, ...redemption, settingsKey,
      action, receivedAt, deadlineAt: new Date(now + PENDING_MS), expiresAt: new Date(now + KEEP_MS) }, COLLECTIONS.TWITCH_REWARD_RECEIPTS);
    try { await this.rows.insertOne(data); return true; }
    catch (error) { if (/** @type {any} */ (error)?.code === 11000) return false; throw error; }
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

  pending() {
    return this.rows.find({ kind: "redemption", state: "pending" }).sort({ receivedAt: 1 }).limit(12).toArray();
  }

  /** @param {string} userId */
  waiting(userId) {
    return this.rows.findOne({ kind: "redemption", state: "awaiting_game", userId }, { sort: { receivedAt: 1 } });
  }

  expiredWaiting() {
    return this.rows.find({ kind: "redemption", state: "awaiting_game", deadlineAt: { $lte: new Date(this.now()) } })
      .sort({ receivedAt: 1 }).limit(12).toArray();
  }

  /** @param {any} row */
  async claim(row) {
    const result = await this.rows.updateOne({ _id: row._id, state: row.state }, {
      $set: { state: "dispatching", dispatchDeadline: new Date(this.now() + RUNNING_MS) },
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
      $unset: { input: "", name: "", login: "", viewerId: "", gameKey: "", settingsKey: "", dispatchDeadline: "" },
    });
  }

  async recoverUnknown() {
    await this.rows.updateMany({ kind: "redemption", state: "dispatching", dispatchDeadline: { $lte: new Date(this.now()) } }, {
      $set: { state: "unknown", reason: "dispatch_unconfirmed", settlement: "unconfirmed", completedAt: new Date(this.now()) },
      $unset: { input: "", name: "", login: "", viewerId: "", gameKey: "", settingsKey: "", dispatchDeadline: "" },
    });
  }

  /** @param {string} userId */
  async recent(userId) {
    return this.rows.find({ kind: "redemption", userId }, { projection: {
      _id: 0, rewardId: 1, rewardTitle: 1, action: 1, receivedAt: 1, state: 1, reason: 1, settlement: 1,
    } }).sort({ receivedAt: -1 }).limit(20).toArray();
  }
}

module.exports = { TwitchRewardReceipts };
