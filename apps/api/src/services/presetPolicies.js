"use strict";
const { BUNDLED_POLICY, validatePolicy } = require("./presetPolicy");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");
const ACTIVE_ID = "preset-policy:active";

/** Global, declarative data only: no user/actor IDs, private build snapshots,
 * tokens or replay references. Actor attribution lives in the erased-aware
 * admin audit. Active CAS + immutable revision are committed together.
 */
class PresetPoliciesService {
  /** @param {import('../db/connect').DbContext} db */
  constructor(db) {
    this.db = db;
    /** @type {{value:any,expires:number}|null} */ this.cache = null;
    /** @type {Promise<any>|null} */ this.loading = null;
    this.epoch = 0;
  }
  /** @param {boolean} [fresh] */
  async current(fresh = false) {
    if (!fresh && this.cache && this.cache.expires > Date.now()) return structuredClone(this.cache.value);
    if (!fresh && this.loading) return structuredClone(await this.loading);
    const read = async () => {
      const epoch = this.epoch;
      const row = await this.db.siteConfig.findOne({ _id: /** @type {any} */ (ACTIVE_ID) }, { projection: { policy: 1 } });
      const value = row ? validatePolicy(row.policy) : structuredClone(BUNDLED_POLICY);
      if (epoch === this.epoch) this.cache = { value, expires: Date.now() + 30000 };
      return value;
    };
    if (fresh) return read();
    const pending = read(); this.loading = pending;
    try { return structuredClone(await pending); }
    finally { if (this.loading === pending) this.loading = null; }
  }
  /** @param {string} expectedHash @param {any[]} entries */
  async save(expectedHash, entries) {
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw problem(400, "invalid_policy_hash");
    const session = this.db.client.startSession();
    /** @type {any} */ let nextPolicy;
    try {
      await session.withTransaction(async () => {
        const row = await this.db.siteConfig.findOne({ _id: /** @type {any} */ (ACTIVE_ID) }, { session });
        const previous = row ? validatePolicy(row.policy) : BUNDLED_POLICY;
        if (previous.hash !== expectedHash) throw problem(409, "preset_policy_changed");
        nextPolicy = validatePolicy({ schemaVersion: 1, evaluatorVersion: 1, revision: previous.revision + 1, entries }, false);
        const now = new Date();
        const saved = await this.db.siteConfig.updateOne({ _id: /** @type {any} */ (ACTIVE_ID), ...(row ? { "policy.hash": expectedHash } : { policy: { $exists: false } }) },
          { $set: stampVersion({ kind: "preset_policy_active", policy: nextPolicy, updatedAt: now }, COLLECTIONS.SITE_CONFIG) }, { session, upsert: !row });
        if (!saved.matchedCount && !saved.upsertedCount) throw problem(409, "preset_policy_changed");
        await this.db.siteConfig.insertOne(stampVersion({ _id: /** @type {any} */ (`preset-policy:revision:${nextPolicy.revision}`), kind: "preset_policy_revision", revision: nextPolicy.revision, policy: nextPolicy, createdAt: now }, COLLECTIONS.SITE_CONFIG), { session });
      });
      this.epoch++;
      this.cache = { value: nextPolicy, expires: Date.now() + 30000 };
      return structuredClone(nextPolicy);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 11000) throw problem(409, "preset_policy_changed");
      throw error;
    } finally { await session.endSession(); }
  }
  /** @param {number} [before] */
  async history(before) {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw problem(400, "invalid_policy_revision");
    const rows = await this.db.siteConfig.find({ kind: "preset_policy_revision", ...(before ? { revision: { $lt: before } } : {}) }, { projection: { _id: 0, revision: 1, createdAt: 1, "policy.hash": 1 } }).sort({ revision: -1 }).limit(21).toArray();
    return { items: rows.slice(0, 20).map((row) => ({ revision: row.revision, hash: row.policy.hash, createdAt: row.createdAt })), nextBefore: rows.length > 20 ? rows[19].revision : null };
  }
  /** Revert is a new reviewed revision, never a history rewrite.
   * @param {string} expectedHash @param {number} revision */
  async revert(expectedHash, revision) {
    return this.save(expectedHash, (await this.revision(revision)).entries);
  }
  /** Read before reviewing/reverting a historical policy; never activates it.
   * @param {number} revision */
  async revision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw problem(400, "invalid_policy_revision");
    const row = revision === 0 ? { policy: BUNDLED_POLICY } : await this.db.siteConfig.findOne({ _id: /** @type {any} */ (`preset-policy:revision:${revision}`) });
    if (!row) throw problem(404, "preset_policy_revision_not_found");
    return validatePolicy(row.policy);
  }
}
/** @param {number} status @param {string} code */
function problem(status, code) { return Object.assign(new Error(code), { status, code }); }
module.exports = { PresetPoliciesService };
