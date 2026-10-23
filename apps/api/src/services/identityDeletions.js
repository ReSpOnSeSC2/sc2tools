"use strict";

const { createHmac } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { buildJobLock } = require("../util/jobLock");
const GUARD_MS = 30 * 24 * 60 * 60 * 1000;

class IdentityDeletionsService {
  /** @param {import('../db/connect').DbContext} db @param {{secret:Buffer|string, clerk:import('./clerkClient').ClerkClient, logger?:import('pino').Logger, now?:()=>Date}} opts */
  constructor(db, opts) {
    this.db = db; this.clerk = opts.clerk; this.secret = opts.secret; this.logger = opts.logger; this.now = opts.now || (() => new Date());
    this.rows = db.pendingIdentityDeletions || db.db.collection(COLLECTIONS.PENDING_IDENTITY_DELETIONS);
    this.lock = buildJobLock({ collection: db.db.collection("jobLocks"), key: "pendingIdentityDeletions", leaseMs: 5 * 60 * 1000, now: () => this.now().getTime() });
    /** @type {null|Promise<void>} */ this.indexes = null;
    /** @type {null|((userId:string,clerkUserId:string)=>Promise<unknown>)} */ this.retryDataPurge = null;
  }
  /** Domain separation; no plain Clerk ID survives successful deletion. @param {string} clerkUserId */
  keyFor(clerkUserId) { return createHmac("sha256", this.secret).update(`identity-deletion:${clerkUserId}`).digest("hex"); }
  async ensureIndexes() {
    if (!this.indexes) this.indexes = Promise.all([
      this.rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.rows.createIndex({ state: 1, nextAttemptAt: 1 }), this.lock.ensureIndexes(),
    ]).then(() => {}).catch((error) => { this.indexes = null; throw error; });
    await this.indexes;
  }
  /** @param {string} clerkUserId */
  async isDeleted(clerkUserId) { return Boolean(await this.rows.findOne({ _id: this.keyFor(clerkUserId) }, { projection: { _id: 1 } })); }
  /** @param {string} clerkUserId */
  async lookup(clerkUserId) { return this.rows.findOne({ _id: this.keyFor(clerkUserId) }); }
  /** Called after private purges, before removing the users row. Pending intents
   * do not expire: failed provider deletion remains retryable until it succeeds.
   * @param {string} userId @param {string} clerkUserId */
  async recordIntent(userId, clerkUserId) {
    await this.ensureIndexes(); const now = this.now();
    await this.rows.updateOne({ _id: this.keyFor(clerkUserId) }, { $setOnInsert: stampVersion({ userId, clerkUserId, state: "purging", createdAt: now, nextAttemptAt: now, attempts: 0 }, COLLECTIONS.PENDING_IDENTITY_DELETIONS) }, { upsert: true });
  }
  /** @param {string} clerkUserId */
  async activate(clerkUserId) { await this.rows.updateOne({ _id: this.keyFor(clerkUserId), state: "purging" }, { $set: { state: "pending", nextAttemptAt: this.now() } }); }
  /** Verified provider webhook, or a successful delete/404. Retain only a keyed
   * short-lived guard against already-issued JWTs and late webhook deliveries.
   * @param {string} clerkUserId */
  async acknowledge(clerkUserId) {
    await this.ensureIndexes(); const now = this.now();
    await this.rows.updateOne({ _id: this.keyFor(clerkUserId) }, {
      $set: stampVersion({ state: "complete", completedAt: now, expiresAt: new Date(now.getTime() + GUARD_MS) }, COLLECTIONS.PENDING_IDENTITY_DELETIONS),
      $unset: { userId: "", clerkUserId: "", nextAttemptAt: "", lastError: "", attempts: "" },
    }, { upsert: true });
  }
  /** @param {string} clerkUserId @returns {Promise<boolean>} true when provider identity is gone */
  async tryDelete(clerkUserId) {
    const row = await this.lookup(clerkUserId);
    if (!row) throw new Error("identity_deletion_not_requested");
    if (row.state === "complete") return true;
    if (row.state !== "pending" || await this.db.users.findOne({ userId: row.userId }, { projection: { _id: 1 } })) return false;
    try { await this.clerk.deleteUser(clerkUserId); await this.acknowledge(clerkUserId); return true; }
    catch {
      const attempts = (row?.attempts || 0) + 1;
      await this.rows.updateOne({ _id: this.keyFor(clerkUserId), state: { $ne: "complete" } }, { $set: {
        state: "pending", attempts, lastError: "provider_unavailable", nextAttemptAt: new Date(this.now().getTime() + Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempts - 1, 10))),
      } });
      this.logger?.warn({ code: "provider_unavailable" }, "identity_deletion_pending"); return false;
    }
  }
  async sweep() {
    await this.ensureIndexes(); const owner = await this.lock.acquire(); if (!owner) return { processed: 0, lockHeld: true };
    let processed = 0;
    try {
      for await (const row of this.rows.find({ state: { $in: ["purging", "pending"] }, nextAttemptAt: { $lte: this.now() } }).sort({ nextAttemptAt: 1 }).limit(25)) {
        if (!await this.lock.extend(owner)) throw new Error("identity_deletion_lease_lost");
        const user = await this.db.users.findOne({ userId: row.userId }, { projection: { _gdprMutation: 1 } });
        if (user?._gdprMutation?.leaseUntil > this.now()) continue;
        if (user) {
          try { if (this.retryDataPurge) await this.retryDataPurge(row.userId, row.clerkUserId); }
          catch {
            await this.rows.updateOne({ _id: row._id, state: { $ne: "complete" } }, { $set: { nextAttemptAt: new Date(this.now().getTime() + 60_000), lastError: "data_purge_unavailable" } });
            this.logger?.warn({ code: "data_purge_unavailable" }, "identity_deletion_pending");
          }
          continue;
        }
        if (row.state === "purging") await this.activate(row.clerkUserId);
        await this.tryDelete(row.clerkUserId); processed += 1;
      }
      return { processed, lockHeld: false };
    } finally { await this.lock.release(owner); }
  }
}
module.exports = { IdentityDeletionsService, GUARD_MS };
