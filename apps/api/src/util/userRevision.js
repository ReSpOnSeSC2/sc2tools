"use strict";

const { randomUUID } = require("crypto");
const { OwnerRevisions } = require("./gameVisibility");
const MAX_OWNERS = 4096;

/** Process-local game-write fence. dataRev is advisory, never a change feed. */
class UserRevision {
  /** @param {import('mongodb').Collection<any>} users
   * @param {{enabled?:boolean,isDeleted?:(id:string)=>Promise<boolean>,logger?:any,maxOwners?:number}} [opts] */
  constructor(users, opts = {}) {
    this.enabled = opts.enabled === true;
    this.users = users; this.isDeleted = opts.isDeleted; this.logger = opts.logger;
    this.maxOwners = opts.maxOwners ?? MAX_OWNERS;
    this.epoch = randomUUID(); this.overflow = 0; this.poisoned = false;
    this.tokens = new OwnerRevisions();
    /** @type {Map<string,{active:number,rev:number|null,dirty:boolean}>} */ this.owners = new Map();
    /** @type {Set<(owner:string|null)=>void>} */ this.invalidators = new Set();
    this.counters = { revision_failure: 0, revision_bump: 0, revision_overflow: 0, revision_active: 0,
      guard_active: 0, guard_rejected: 0 };
  }
  /** @param {(owner:string|null)=>void} callback */
  addInvalidator(callback) {
    if (this.invalidators.size >= 8) throw new Error("user_revision_invalidators_full");
    this.invalidators.add(callback);
  }
  /** @param {string|null} owner */
  retire(owner) {
    if (!this.enabled) return;
    if (owner === null) { this.epoch = randomUUID(); this.tokens.clear(); }
    else this.tokens.invalidate(owner);
    for (const callback of this.invalidators) {
      try { callback(owner); } catch {
        const state = owner === null ? null : this.owners.get(owner);
        if (state) state.dirty = true; else this.poisoned = true;
        this.counters.revision_failure += 1;
      }
    }
  }
  /** @param {string} owner */
  state(owner) {
    let state = this.owners.get(owner);
    if (state) { this.owners.delete(owner); this.owners.set(owner, state); return state; }
    if (this.owners.size >= this.maxOwners) {
      const victim = [...this.owners].find(([, value]) => value.active === 0);
      if (!victim) return null;
      this.owners.delete(victim[0]); this.retire(victim[0]);
    }
    state = { active: 0, rev: null, dirty: false };
    this.owners.set(owner, state); return state;
  }
  /** Start immediately before a semantic Mongo attempt; finish even on rejection.
   * @param {string} owner @returns {(changed?:boolean)=>Promise<void>} */
  begin(owner) {
    if (!this.enabled) return async () => {};
    const validOwner = typeof owner === "string" && owner.length > 0;
    const state = validOwner ? this.state(owner) : null;
    if (!state) { this.overflow += 1; this.counters.revision_overflow += 1; this.retire(null); }
    else { state.active += 1; this.retire(owner); }
    let finished = false;
    return async (changed = true) => {
      if (finished) return; finished = true;
      this.retire(state ? owner : null);
      let admitted = false;
      try {
        if (changed && validOwner) {
          // Revision persistence is advisory and has no unbounded waiter queue.
          // Under pressure retire locally and bypass reuse instead of adding IO.
          if (this.counters.revision_active >= 4) throw new Error("user_revision_busy");
          this.counters.revision_active += 1; admitted = true;
          // Match the BSON types that can decode to a supported JS revision.
          // Decimal128 is deliberately not repaired, even when it is integral.
          // $cond avoids evaluating arithmetic on malformed legacy fields.
          const row = await this.users.findOneAndUpdate({ userId: owner, $expr: {
            $cond: [{ $in: [{ $type: "$dataRev" }, ["int", "long", "double"]] }, { $and: [
              { $gte: ["$dataRev", 0] }, { $lt: ["$dataRev", Number.MAX_SAFE_INTEGER] },
              { $eq: [{ $mod: ["$dataRev", 1] }, 0] },
            ] }, { $eq: [{ $type: "$dataRev" }, "missing"] }],
          } }, { $inc: { dataRev: 1 } }, {
            upsert: false, returnDocument: "after", projection: { _id: 0, dataRev: 1 }, maxTimeMS: 2000,
          });
          if (!row || !validRevision(row.dataRev)) throw new Error("user_revision_unavailable");
          if (state) { state.rev = Math.max(state.rev ?? 0, row.dataRev); state.dirty = false; }
          this.counters.revision_bump += 1;
        }
      } catch {
        if (state) state.dirty = true;
        this.counters.revision_failure += 1;
        try { this.logger?.warn?.({ code: "user_revision_unavailable" }, "user_revision_persist_failed"); }
        catch { /* Logging remains advisory too. */ }
      } finally {
        if (admitted) this.counters.revision_active -= 1;
        if (state) state.active -= 1; else this.overflow -= 1;
        this.retire(state ? owner : null);
      }
    };
  }
  /** No-op when disabled, including zero additional database commands.
   * @template T @param {string} owner @param {()=>Promise<T>} work
   * @param {(result:T)=>boolean} [changed] @returns {Promise<T>} */
  async run(owner, work, changed = () => true) {
    if (!this.enabled) return work();
    const finish = this.begin(owner); let known = false; let didChange = true;
    try { const result = await work(); didChange = changed(result); known = true; return result; }
    finally { await finish(!known || didChange); }
  }
  /** Fresh owner/deletion guard before a retained response, including device auth.
   * @param {string} owner */
  async snapshot(owner) {
    if (!this.enabled) throw new Error("user_cache_disabled");
    // Independent of HTTP response leases: aborting a client cannot release
    // capacity while its Mongo/identity promise is still actually running.
    if (this.counters.guard_active >= 16) {
      this.counters.guard_rejected += 1; throw revisionError(503, "user_cache_guard_busy");
    }
    this.counters.guard_active += 1;
    try {
      const state = this.state(owner), epoch = this.epoch, token = this.tokens.get(owner);
      const row = await this.users.findOne({ userId: owner }, {
        projection: { _id: 0, userId: 1, clerkUserId: 1, dataRev: 1, _gdprMutation: 1 }, maxTimeMS: 2000,
      });
      if (!row || (typeof row.clerkUserId === "string" && this.isDeleted && await this.isDeleted(row.clerkUserId))) {
        this.retire(owner); throw revisionError(401, "account_deleted");
      }
      if (row._gdprMutation) { this.retire(owner); throw revisionError(503, "gdpr_operation_busy"); }
      const rev = row.dataRev === undefined ? 0 : row.dataRev;
      const unchanged = epoch === this.epoch && this.tokens.current(owner, token);
      if (state && unchanged && validRevision(rev)) {
        if (state.rev !== null && rev > state.rev) this.retire(owner);
        if (state.rev === null || rev >= state.rev) state.rev = rev;
      }
      // Preserve the identity captured before IO. Rebinding to a newer token
      // would let a request publish work from a generation retired mid-guard.
      return { owner, epoch, token, rev,
        cacheable: !!state && unchanged && epoch === this.epoch && this.tokens.current(owner, token)
          && !state.active && !state.dirty && !this.overflow && !this.poisoned
          && validRevision(rev) && state.rev === rev };
    } finally { this.counters.guard_active -= 1; }
  }
  /** Identity validity is separate from eligibility for retained reuse. Stable
   * dirty/active/invalid-revision reads may still do bounded uncached work.
   * @param {Awaited<ReturnType<UserRevision['snapshot']>>} snapshot */
  sameGeneration(snapshot) {
    return snapshot.epoch === this.epoch && this.tokens.current(snapshot.owner, snapshot.token);
  }
  /** @param {Awaited<ReturnType<UserRevision['snapshot']>>} snapshot */
  current(snapshot) {
    const state = this.owners.get(snapshot.owner);
    return snapshot.cacheable && this.sameGeneration(snapshot)
      && !!state && !state.active && !state.dirty && !this.overflow && !this.poisoned && state.rev === snapshot.rev;
  }
  /** @param {string} owner */
  forget(owner) { if (this.enabled) { this.retire(owner); this.owners.delete(owner); } }
}
/** @param {unknown} value */
function validRevision(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {number} status @param {string} code */
function revisionError(status, code) { return Object.assign(new Error(code), { status, code }); }

/** Optional injection keeps standalone services and disabled deployments exact.
 * @template T @param {UserRevision|null|undefined} revisions @param {string} owner
 * @param {()=>Promise<T>} work @param {(result:T)=>boolean} [changed] @returns {Promise<T>} */
function gameWrite(revisions, owner, work, changed) { return revisions ? revisions.run(owner, work, changed) : work(); }

module.exports = { UserRevision, validRevision, MAX_OWNERS, gameWrite };
