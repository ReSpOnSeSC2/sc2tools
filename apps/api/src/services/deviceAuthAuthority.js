"use strict";

const { Timestamp } = require("mongodb");
const { sha256 } = require("../util/hash");
const { AUTHORITY_KEY, OWNER_NAMESPACE, PROTOCOL_VERSION, PENDING_LIMIT } = require("./deviceCredentialWrites");

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const KINDS = new Set(["issue", "revoke-hash", "revoke-id", "erase"]);

/** Reader-only filter. This helper cannot create or activate authority. */
function deviceAuthGrantFilter() {
  return { _id: AUTHORITY_KEY, key: AUTHORITY_KEY, protocolVersion: PROTOCOL_VERSION,
    ownerHashNamespace: OWNER_NAMESPACE, mode: "active", grantsEverEnabled: true,
    expiresAt: { $exists: false }, owner: { $exists: false },
    incarnation: { $regex: UUID }, generation: { $regex: UUID }, denyAll: { $in: [false, true] },
    $expr: { $cond: [{ $isArray: "$pending" }, { $lte: [{ $size: "$pending" }, PENDING_LIMIT] }, false] } };
}

/** @param {unknown} value */
function validUuid(value) { return typeof value === "string" && UUID.test(value); }

/** @param {any} entry */
function validPending(entry) {
  return !!entry && validUuid(entry.operationId) && typeof entry.ownerHash === "string"
    && /^[\da-f]{64}$/.test(entry.ownerHash) && KINDS.has(entry.kind)
    && ["draining", "writing", "uncertain"].includes(entry.phase);
}

/** @param {any} row @param {string} nonce */
function validIdentity(row, nonce) {
  return !!row && row._id === AUTHORITY_KEY && row.key === AUTHORITY_KEY
    && row.protocolVersion === PROTOCOL_VERSION && row.ownerHashNamespace === OWNER_NAMESPACE
    && validUuid(row.incarnation) && validUuid(row.generation)
    && validUuid(row.grantProbeNonce) && row.grantProbeNonce === nonce;
}

/** @param {any} row */
function validMode(row) {
  return row.mode === "active" && row.grantsEverEnabled === true && typeof row.denyAll === "boolean"
    && !Object.hasOwn(row, "expiresAt") && !Object.hasOwn(row, "owner");
}

/** @param {any} row @param {string} nonce */
function validDeviceAuthGrant(row, nonce) {
  if (!validIdentity(row, nonce) || !validMode(row)) return false;
  return Array.isArray(row.pending) && row.pending.length <= PENDING_LIMIT
    && new Set(row.pending.map((/** @type {any} */ entry) => entry?.operationId)).size === row.pending.length
    && row.pending.every(validPending);
}

/** This namespace is identical to the writer and independent of pepper.
 * @param {unknown} owner */
function deviceAuthOwnerHash(owner) {
  return typeof owner === "string" && owner.length > 0 && owner.length <= 256
    ? sha256(`${OWNER_NAMESPACE}\0${owner}`) : null;
}

/** Copy only a command operationTime, never gossip clusterTime.
 * @param {unknown} value */
function copyDeviceAuthOperationTime(value) {
  if (!(value instanceof Timestamp) || value.isZero()) return null;
  return Timestamp.fromBits(value.getLowBits(), value.getHighBits());
}

module.exports = { deviceAuthGrantFilter, validDeviceAuthGrant, deviceAuthOwnerHash, copyDeviceAuthOperationTime };
