"use strict";

const { SessionResolutionGate } = require("./sessionResolutionGate");
const { validGap } = require("./sessions");

/** @typedef {{gapMinutes:number,source:'preference'|'auto-overlay'|'auto-player',storedGapMinutes:number|null}} SessionPolicy */
/** Read-only adapter: real Mongo collections and unit doubles provide exactly
 * the document lookup this service consumes, with unknown values narrowed below.
 * @typedef {{findOne:(filter:{userId:string},options?:{projection:Record<string,0|1>})=>Promise<Record<string,unknown>|null>}} PolicyReadCollection */
/** @typedef {{users:PolicyReadCollection,overlayTokens:PolicyReadCollection}} PolicyDatabase */

class SessionPolicyService {
  /** One policy-specific instance of the existing bounded gate implementation.
   * @param {PolicyDatabase} db
   * @param {{revisions:import('../util/gameVisibility').OwnerRevisions,gate?:InstanceType<typeof SessionResolutionGate>}} opts */
  constructor(db, opts) {
    this.db = db; this.revisions = opts.revisions;
    this.gate = opts.gate || new SessionResolutionGate();
  }

  /** Capture once before policy IO and retain this exact identity until response.
   * @param {string} owner */
  lease(owner) { return { owner, token: this.revisions.get(owner) }; }

  /** @param {ReturnType<SessionPolicyService['lease']>} lease */
  assertCurrent(lease) {
    if (!this.revisions.current(lease.owner, lease.token)) throw Object.assign(new Error("session_policy_changed"), { status: 409, code: "session_policy_changed" });
  }

  /** @param {string} owner */
  invalidate(owner) { this.gate.invalidate(owner, { discardPending: true }); }

  /** Retire short reuse on a bounded revision-map global clear/overflow too. */
  invalidateAll() {
    for (const owner of this.gate.lanes.keys()) this.gate.invalidate(owner, { discardPending: true });
  }

  /** @param {string} owner
   * @param {{storedGapMinutes?:unknown,ownerKnown?:boolean}} [known]
   * @returns {Promise<SessionPolicy>} */
  async resolve(owner, known = {}) {
    const lease = this.lease(owner);
    if (known.ownerKnown && known.storedGapMinutes !== null && known.storedGapMinutes !== undefined && !validGap(known.storedGapMinutes)) throw Object.assign(new Error("session_policy_invalid"), { status: 503, code: "session_policy_invalid" });
    // A fresh Profile read that observes a different preference cannot join a
    // policy task from its previous value. Fixed namespace, bounded scalar input;
    // the existing four-key/task limits still apply and no query keys are used.
    const key = known.ownerKnown ? `session-policy:v1:stored:${known.storedGapMinutes ?? "auto"}` : "session-policy:v1:read";
    const value = await this.gate.resolve(owner, key, { reuseRecent: true }, async () => {
      let stored = known.storedGapMinutes;
      if (!known.ownerKnown) {
        const row = await this.db.users.findOne({ userId: owner }, { projection: { _id: 0, userId: 1, sessionGapMinutes: 1, _gdprMutation: 1 } });
        if (!row) throw Object.assign(new Error("account_deleted"), { status: 401, code: "account_deleted" });
        if (row._gdprMutation) throw Object.assign(new Error("gdpr_operation_busy"), { status: 503, code: "gdpr_operation_busy" });
        stored = row.sessionGapMinutes;
      }
      if (stored !== null && stored !== undefined && !validGap(stored)) throw Object.assign(new Error("session_policy_invalid"), { status: 503, code: "session_policy_invalid" });
      if (typeof stored === "number" && validGap(stored)) return { gapMinutes: stored, source: /** @type {const} */ ("preference"), storedGapMinutes: stored };
      // ANY persisted credential record, including revoked/rotation-pending;
      // this is an indexed existence read, not resolve/list/create credentials.
      const hasOverlay = !!await this.db.overlayTokens.findOne({ userId: owner }, { projection: { _id: 1 } });
      return { gapMinutes: hasOverlay ? 240 : 90, source: /** @type {'auto-overlay'|'auto-player'} */ (hasOverlay ? "auto-overlay" : "auto-player"), storedGapMinutes: null };
    });
    this.assertCurrent(lease);
    return { ...value };
  }

  /** Positive analysis overrides retain existing rounding/clamping behavior.
   * The internal lease/id are never part of the public three-scalar DTO.
   * @param {string} owner @param {unknown} override */
  async momentum(owner, override) {
    const lease = this.lease(owner);
    const policy = typeof override === "number" && Number.isFinite(override) && override > 0
      ? { gapMinutes: Math.max(15, Math.min(480, Math.round(override))) }
      : await this.resolve(owner);
    this.assertCurrent(lease);
    return { sessionGapMinutes: policy.gapMinutes, sessionPolicyGeneration: lease.token.id, lease };
  }
}

module.exports = { SessionPolicyService };
