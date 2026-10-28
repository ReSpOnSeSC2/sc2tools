"use strict";

const { DEVICE_TOUCH_MS } = require("./deviceLiveness");

/** @param {any} options */
function qualifiedSnapshotOptions(options) {
  return !!options?.session && options.readPreference === "primary" && options.readConcern?.level === "majority";
}

/** Unwired cache-only reader. The production authoritative Pairings method is
 * unchanged. Keep its predicate/projection/touch semantics while the lease
 * supplies a stronger cold-read session; no row or timestamp becomes a DTO.
 * @param {any} collection @param {import('./deviceLiveness').DeviceLiveness} liveness
 * @param {string} tokenHash @param {any} options */
async function readDeviceAuthSnapshot(collection, liveness, tokenHash, options) {
  if (!qualifiedSnapshotOptions(options)) {
    throw new Error("device_auth_snapshot_requires_lease");
  }
  const row = await collection.findOne({ tokenHash, revokedAt: null }, {
    projection: { _id: 1, userId: 1, lastSeenAt: 1 }, session: options.session,
    readPreference: "primary", readConcern: { level: "majority" },
    maxTimeMS: options.maxTimeMS, timeoutMS: options.timeoutMS,
  });
  if (!row) return { hit: null, observedLastSeenAtMs: null };
  const now = new Date(liveness.now()), cutoff = new Date(now.getTime() - DEVICE_TOUCH_MS);
  const seen = row.lastSeenAt instanceof Date ? row.lastSeenAt.getTime() : NaN;
  if (!(row.lastSeenAt instanceof Date) || !Number.isFinite(seen) || row.lastSeenAt <= cutoff) {
    void liveness.touch(row.userId, tokenHash, () => collection.updateOne({
      _id: row._id, userId: row.userId, tokenHash, revokedAt: null, $or: [
        { lastSeenAt: { $lte: cutoff } }, { $expr: { $ne: [{ $type: "$lastSeenAt" }, "date"] } },
      ],
    }, { $set: { lastSeenAt: now } }, { upsert: false }));
  }
  return { hit: { userId: row.userId, deviceId: String(row._id) },
    observedLastSeenAtMs: Number.isFinite(seen) ? seen : null };
}

module.exports = { readDeviceAuthSnapshot };
