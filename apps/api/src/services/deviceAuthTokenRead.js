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
  return readDeviceTokenCore(collection, liveness, tokenHash, options, true);
}

/** @overload
 * @param {any} collection @param {import('./deviceLiveness').DeviceLiveness} liveness
 * @param {string} tokenHash @param {any} [options] @param {false} [snapshot]
 * @returns {Promise<{userId:string,deviceId:string}|null>} */
/** @overload
 * @param {any} collection @param {import('./deviceLiveness').DeviceLiveness} liveness
 * @param {string} tokenHash @param {any} options @param {true} snapshot
 * @returns {Promise<{hit:{userId:string,deviceId:string}|null,observedLastSeenAtMs:number|null}>} */
/** Shared private lookup body. The public path passes no read options and
 * preserves its original Mongo predicate/projection and touch scheduling.
 * @param {any} collection @param {import('./deviceLiveness').DeviceLiveness} liveness
 * @param {string} tokenHash @param {any} [options] @param {boolean} [snapshot] */
async function readDeviceTokenCore(collection, liveness, tokenHash, options, snapshot = false) {
  const row = await collection.findOne({ tokenHash, revokedAt: null }, tokenReadOptions(options));
  if (!row) return snapshot ? { hit: null, observedLastSeenAtMs: null } : null;
  const now = new Date(liveness.now()), cutoff = new Date(now.getTime() - DEVICE_TOUCH_MS);
  const seen = row.lastSeenAt instanceof Date ? row.lastSeenAt.getTime() : NaN;
  if (!(row.lastSeenAt instanceof Date) || !Number.isFinite(seen) || row.lastSeenAt <= cutoff) {
    void liveness.touch(row.userId, tokenHash, () => collection.updateOne({
      _id: row._id, userId: row.userId, tokenHash, revokedAt: null, $or: [
        { lastSeenAt: { $lte: cutoff } }, { $expr: { $ne: [{ $type: "$lastSeenAt" }, "date"] } },
      ],
    }, { $set: { lastSeenAt: now } }, { upsert: false }));
  }
  const hit = { userId: row.userId, deviceId: String(row._id) };
  return snapshot ? { hit, observedLastSeenAtMs: Number.isFinite(seen) ? seen : null } : hit;
}

/** @param {any} options */
function tokenReadOptions(options) {
  return { projection: { _id: 1, userId: 1, lastSeenAt: 1 },
    ...(options ? { session: options.session, readPreference: "primary",
      readConcern: { level: "majority" }, maxTimeMS: options.maxTimeMS, timeoutMS: options.timeoutMS } : {}),
  };
}

module.exports = { readDeviceAuthSnapshot, readDeviceTokenCore };
