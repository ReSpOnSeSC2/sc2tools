"use strict";

const { readPrivateFacet } = require("./privateSearchReader");
const { validText, validId } = require("./privateSearchText");
const { record, array } = require("./privateSearchDecode");
/** @typedef {import('mongodb').Collection} Collection */
/** @typedef {{users:Collection,pendingIdentityDeletions:Collection}} IdentityContext */
/** @typedef {{signal:AbortSignal,check:()=>void,clerkUserId?:string}} ReadScope */

/** @param {string} code @param {number} [status] */
const identityError = (code, status = 401) => Object.assign(new Error(code), { code, status });
/** @param {string} field */
const bounded = field => ({ $cond: [{ $eq: [{ $type: field }, "string"] },
  { $cond: [{ $lte: [{ $strLenCP: field }, 200] }, field, null] }, null] });

/** Scalar bounded metadata only; any _gdprMutation field presence rejects.
 * @param {string} owner */
function ownerShape(owner) {
  return { pipeline: [{ $match: { userId: owner } }, { $limit: 2 }, { $project: {
    _id: 0, userId: bounded("$userId"), clerkUserId: bounded("$clerkUserId"),
    mutationPresent: { $ne: [{ $type: "$_gdprMutation" }, "missing"] },
  } }, { $facet: { rows: [{ $limit: 2 }] } }], options: { hint: "userId_1" } };
}

/** @param {string} key */
function tombstoneShape(key) {
  return { pipeline: [{ $match: { _id: key } }, { $limit: 1 },
    { $project: { _id: 0, present: { $literal: true } } }, { $facet: { rows: [{ $limit: 1 }] } }],
  options: { hint: "_id_" } };
}

/** @param {unknown} envelopes @param {number} maximum */
function guardRows(envelopes, maximum) {
  const [raw] = array(envelopes, 1, 1);
  return array(record(raw, ["rows"]).rows, maximum);
}

/** @param {unknown} envelopes @param {string} owner @param {string} [expectedClerk] */
function ownerIdentity(envelopes, owner, expectedClerk) {
  const rows = guardRows(envelopes, 2);
  if (rows.length !== 1) throw identityError("private_search_invalid_owner");
  const user = record(rows[0], ["userId", "clerkUserId", "mutationPresent"]);
  if (user.userId !== owner || !validText(user.clerkUserId, 200)) throw identityError("private_search_invalid_owner");
  if (expectedClerk !== undefined && expectedClerk !== user.clerkUserId) {
    throw identityError("private_search_invalid_owner");
  }
  if (typeof user.mutationPresent !== "boolean") throw identityError("private_search_invalid_owner");
  if (user.mutationPresent) throw identityError("gdpr_operation_busy", 503);
  return user.clerkUserId;
}

/** @param {unknown} envelopes */
function tombstonePresent(envelopes) {
  try {
    const rows = guardRows(envelopes, 1);
    if (rows.length && record(rows[0], ["present"]).present !== true) throw new TypeError();
    return rows.length !== 0;
  } catch { throw identityError("private_search_unavailable", 503); }
}

/** Read-only identity checks use the same raw-byte/cursor-lifetime boundary.
 * Users and tombstones are separate read points, not an atomic snapshot. */
class PrivateSearchIdentity {
  /** @param {IdentityContext} ctx @param {(clerkUserId:string)=>string} identityKeyFor */
  constructor(ctx, identityKeyFor) { this.ctx = ctx; this.identityKeyFor = identityKeyFor; }

  /** @param {string} owner @param {ReadScope} scope */
  async assertActive(owner, scope) {
    if (!validId(owner, 200)) throw identityError("private_search_invalid_owner");
    const raw = await readPrivateFacet(this.ctx.users, ownerShape(owner), scope.signal, scope.check);
    let clerkUserId;
    try { clerkUserId = ownerIdentity(raw.envelopes, owner, scope.clerkUserId); }
    catch (error) {
      if (error instanceof TypeError) throw identityError("private_search_invalid_owner");
      throw error;
    }
    let key;
    try { key = this.identityKeyFor(clerkUserId); }
    catch { throw identityError("private_search_unavailable", 503); }
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw identityError("private_search_unavailable", 503);
    const deleted = await readPrivateFacet(this.ctx.pendingIdentityDeletions,
      tombstoneShape(key), scope.signal, scope.check);
    if (tombstonePresent(deleted.envelopes)) throw identityError("account_deleted");
  }
}

module.exports = { PrivateSearchIdentity };
