"use strict";

const { ObjectId } = require("mongodb");
const { DeviceLiveness } = require("../src/services/deviceLiveness");
const { DevicePairingsService } = require("../src/services/devicePairings");
const { readDeviceAuthSnapshot } = require("../src/services/deviceAuthTokenRead");
const { deferred } = require("./helpers/deviceAuthFixture");

/** @param {any} seen */
function setup(seen) {
  const row = { _id: new ObjectId(), userId: "owner-a", lastSeenAt: seen };
  /** @type {any} */ const collection = { findOne: jest.fn(async () => row), updateOne: jest.fn(async () => ({ acknowledged: true })) };
  const liveness = new DeviceLiveness({ now: () => 100000 });
  const options = { session: {}, readPreference: "primary", readConcern: { level: "majority" }, maxTimeMS: 1000, timeoutMS: 1000 };
  return { row, collection, liveness, options };
}

test("cache-only read has the exact original predicate/projection and a private timestamp", async () => {
  const f = setup(new Date(99999));
  const value = await readDeviceAuthSnapshot(f.collection, f.liveness, "hashed-token", f.options);
  expect(f.collection.findOne).toHaveBeenCalledWith({ tokenHash: "hashed-token", revokedAt: null }, {
    projection: { _id: 1, userId: 1, lastSeenAt: 1 }, ...f.options,
  });
  expect(value).toEqual({ hit: { userId: "owner-a", deviceId: String(f.row._id) }, observedLastSeenAtMs: 99999 });
  expect(f.collection.updateOne).not.toHaveBeenCalled();
});

test.each([undefined, null, "legacy", new Date(NaN), new Date(40000)])(
  "missing, malformed or equality-due timestamp %s keeps the original touch predicate", async seen => {
    const f = setup(seen);
    await readDeviceAuthSnapshot(f.collection, f.liveness, "hash", f.options);
    await Promise.all(f.liveness.touches.values());
    expect(f.collection.updateOne).toHaveBeenCalledWith({ _id: f.row._id, userId: "owner-a", tokenHash: "hash", revokedAt: null,
      $or: [{ lastSeenAt: { $lte: new Date(40000) } }, { $expr: { $ne: [{ $type: "$lastSeenAt" }, "date"] } }] },
    { $set: { lastSeenAt: new Date(100000) } }, { upsert: false });
  },
);

test("touch stores captured now and returns before a held best-effort command completes", async () => {
  const f = setup(null), gate = deferred(); f.collection.updateOne.mockImplementationOnce(() => gate.promise);
  const result = await readDeviceAuthSnapshot(f.collection, f.liveness, "hash", f.options);
  expect(result.observedLastSeenAtMs).toBeNull(); expect(f.liveness.touches.size).toBe(1);
  expect(f.collection.updateOne.mock.calls[0][1]).toEqual({ $set: { lastSeenAt: new Date(100000) } });
  gate.resolve({ acknowledged: true }); await Promise.all(f.liveness.touches.values());
});

test("failed touch is not memoized and retries from a later original-shaped lookup", async () => {
  const f = setup(null); f.collection.updateOne.mockRejectedValueOnce(new Error("unknown touch"));
  await readDeviceAuthSnapshot(f.collection, f.liveness, "hash", f.options); await Promise.all(f.liveness.touches.values());
  await readDeviceAuthSnapshot(f.collection, f.liveness, "hash", f.options); await Promise.all(f.liveness.touches.values());
  expect(f.collection.findOne).toHaveBeenCalledTimes(2); expect(f.collection.updateOne).toHaveBeenCalledTimes(2);
});

test("public authoritative method remains an independent query with its original options and DTO", async () => {
  const f = setup(new Date(99999));
  const pairings = new DevicePairingsService(/** @type {any} */ ({ deviceTokens: f.collection }), { liveness: f.liveness });
  expect(await pairings.findTokenByHash("hash")).toEqual({ userId: "owner-a", deviceId: String(f.row._id) });
  expect(f.collection.findOne).toHaveBeenCalledWith({ tokenHash: "hash", revokedAt: null }, {
    projection: { _id: 1, userId: 1, lastSeenAt: 1 },
  });
  expect(f.collection.updateOne).not.toHaveBeenCalled();
});

test("missing cache read session cannot silently become an unqualified cold snapshot", async () => {
  const f = setup(new Date(99999));
  await expect(readDeviceAuthSnapshot(f.collection, f.liveness, "hash", {})).rejects.toThrow("requires_lease");
  expect(f.collection.findOne).not.toHaveBeenCalled();
});
