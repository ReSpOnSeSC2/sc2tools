// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GdprService } = require("../src/services/gdpr");
let mongo, client, users;
const owner = "admission-owner";
const writer = id => ({ id, leaseUntil: new Date(Date.now() + 60_000) });
const isClaim = update => !!update?.$set?._gdprMutation;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri()); users = client.db("gdpr_admission").collection("users");
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => { jest.restoreAllMocks(); await users.deleteMany({}); });

test("the last writer releasing between a failed CAS and reread retries the guarded claim", async () => {
  await users.insertOne({ userId: owner, _dataMutations: [writer("first")] });
  const update = users.updateOne.bind(users); let claims = 0;
  jest.spyOn(users, "updateOne").mockImplementation(async (filter, mutation, options) => {
    const result = await update(filter, mutation, options);
    if (isClaim(mutation) && ++claims === 1) {
      expect(result.matchedCount).toBe(0);
      await update({ userId: owner }, { $unset: { _dataMutations: "" } });
    }
    return result;
  });
  const service = new GdprService({ users }); let fence;
  try {
    fence = await service._acquireMutationFence(owner, "test-only");
    expect(claims).toBe(2);
    expect((await users.findOne({ userId: owner }))._gdprMutation.id).toBe(fence.id);
  } finally { if (fence) await service._releaseMutationFence(owner, fence); }
});

test("an exclusive lock appearing after the failed CAS remains authoritative", async () => {
  await users.insertOne({ userId: owner, _dataMutations: [writer("first")] });
  const update = users.updateOne.bind(users); let claims = 0;
  const competing = { id: "competing-exclusive", leaseUntil: new Date(Date.now() + 60_000) };
  jest.spyOn(users, "updateOne").mockImplementation(async (filter, mutation, options) => {
    const result = await update(filter, mutation, options);
    if (isClaim(mutation) && ++claims === 1) await update({ userId: owner }, { $unset: { _dataMutations: "" }, $set: { _gdprMutation: competing } });
    return result;
  });
  await expect(new GdprService({ users })._acquireMutationFence(owner, "test-only")).rejects.toThrow("gdpr_operation_busy");
  expect(claims).toBe(1); expect((await users.findOne({ userId: owner }))._gdprMutation).toEqual(competing);
});

test("a writer reappearing after the empty reread cannot be bypassed by the retry", async () => {
  await users.insertOne({ userId: owner, _dataMutations: [writer("first")] });
  const update = users.updateOne.bind(users), read = users.findOne.bind(users);
  let claims = 0, reads = 0, entered, release;
  const blockedAgain = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  jest.spyOn(users, "updateOne").mockImplementation(async (filter, mutation, options) => {
    const result = await update(filter, mutation, options);
    if (isClaim(mutation)) {
      claims++;
      if (claims === 1) await update({ userId: owner }, { $unset: { _dataMutations: "" } });
      if (claims === 2) { expect(result.matchedCount).toBe(0); entered(); await hold; }
    }
    return result;
  });
  jest.spyOn(users, "findOne").mockImplementation(async (...args) => {
    const snapshot = await read(...args);
    if (++reads === 1) await update({ userId: owner }, { $set: { _dataMutations: [writer("second")] } });
    return snapshot;
  });
  const service = new GdprService({ users }); let fence;
  // Attach rejection handling immediately; the red baseline must not leave an
  // unhandled rejection while this test waits for the second guarded claim.
  const pending = service._acquireMutationFence(owner, "test-only").then(value => ({ value }), error => ({ error }));
  const result = await Promise.race([blockedAgain.then(() => "blocked"), pending.then(() => "settled")]);
  try {
    expect(result).toBe("blocked");
    expect((await read({ userId: owner }))._gdprMutation).toBeUndefined();
    expect((await read({ userId: owner }))._dataMutations[0].id).toBe("second");
  } finally {
    await update({ userId: owner }, { $unset: { _dataMutations: "" } }); release();
    const outcome = await pending; fence = outcome.value;
    if (fence) await service._releaseMutationFence(owner, fence);
  }
  expect(fence).toBeDefined(); expect(claims).toBe(3);
});

test("a missing owner cannot be recreated or admitted by the retry", async () => {
  await expect(new GdprService({ users })._acquireMutationFence(owner, "test-only")).rejects.toThrow("gdpr_operation_busy");
  expect(await users.countDocuments({})).toBe(0);
});
