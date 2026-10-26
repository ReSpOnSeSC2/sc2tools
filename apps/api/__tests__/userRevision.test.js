// @ts-nocheck
"use strict";
const { UserRevision, validRevision } = require("../src/util/userRevision");
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
function setup(options = {}) {
  let row = { userId: "a", clerkUserId: "clerk-a" };
  const users = { findOne: jest.fn(async () => row), findOneAndUpdate: jest.fn(async (_filter, update, opts) => {
    expect(opts.upsert).toBe(false);
    if (!row || (row.dataRev !== undefined && (!validRevision(row.dataRev) || row.dataRev === Number.MAX_SAFE_INTEGER))) return null;
    row = { ...row, dataRev: (row.dataRev || 0) + update.$inc.dataRev }; return row;
  }) };
  const revisions = new UserRevision(users, { enabled: true, ...options });
  return { users, revisions, set: (value) => { row = value; } };
}
test("disabled writes preserve exact result/error with no new commands or state", async () => {
  const { users, revisions } = setup({ enabled: false }); const value = {};
  expect(await revisions.run("a", async () => value)).toBe(value);
  const error = new Error("write"); await expect(revisions.run("a", async () => { throw error; })).rejects.toBe(error);
  expect(users.findOne).not.toHaveBeenCalled(); expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  expect(revisions.owners.size).toBe(0);
});
test("legacy absent revision seeds as zero without a write; first change increments", async () => {
  const { users, revisions } = setup(); const first = await revisions.snapshot("a");
  expect(first.rev).toBe(0); expect(revisions.current(first)).toBe(true);
  await revisions.run("a", async () => "unchanged", () => false);
  expect(users.findOneAndUpdate).not.toHaveBeenCalled(); expect(revisions.current(first)).toBe(false);
  await revisions.run("a", async () => 3); expect((await revisions.snapshot("a")).rev).toBe(1);
});
test.each([null, "3", -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid revision %j cannot cache", async (dataRev) => {
  const { set, revisions } = setup(); set({ userId: "a", dataRev });
  expect(revisions.current(await revisions.snapshot("a"))).toBe(false);
});
test("unknown write and revision failure preserve original error and retire late fills", async () => {
  const { users, revisions } = setup({ logger: { warn: () => { throw new Error("logger"); } } });
  const first = await revisions.snapshot("a"); users.findOneAndUpdate.mockRejectedValue(new Error("lost ack"));
  const error = new Error("original write");
  await expect(revisions.run("a", async () => { throw error; })).rejects.toBe(error);
  expect(revisions.current(first)).toBe(false); expect(revisions.current(await revisions.snapshot("a"))).toBe(false);
  expect(revisions.counters.revision_failure).toBe(1);
});
test("a failed invalidator cannot change the write outcome or permit a retained fill", async () => {
  const { revisions } = setup(); revisions.addInvalidator(() => { throw new Error("cache unavailable"); });
  await expect(revisions.run("a", async () => 7)).resolves.toBe(7);
  expect(revisions.current(await revisions.snapshot("a"))).toBe(false);
});
test("revision IO has four permits and no standalone fallback queue", async () => {
  const { users, revisions } = setup(); const gate = deferred();
  users.findOneAndUpdate.mockImplementation(async () => { await gate.promise; return { dataRev: 1 }; });
  const writes = Array.from({ length: 5 }, (_, index) => revisions.run(`owner-${index}`, async () => index));
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
  expect(revisions.counters.revision_active).toBe(4); expect(users.findOneAndUpdate).toHaveBeenCalledTimes(4);
  expect(revisions.counters.revision_failure).toBe(1); gate.resolve();
  expect(await Promise.all(writes)).toEqual([0, 1, 2, 3, 4]); expect(revisions.counters.revision_active).toBe(0);
});
test("an old seed cannot overwrite a bump; concurrent scopes keep reads uncached", async () => {
  const { users, revisions } = setup(); const read = deferred(); users.findOne.mockReturnValueOnce(read.promise);
  const old = revisions.snapshot("a"); const end1 = revisions.begin("a"), end2 = revisions.begin("a");
  await end1(); expect(revisions.current(await revisions.snapshot("a"))).toBe(false);
  await end2(); read.resolve({ userId: "a", dataRev: 0 });
  expect(revisions.current(await old)).toBe(false); expect((await revisions.snapshot("a")).rev).toBe(2);
});
test("generation identity remains original when a guard observes a retired token or newer persisted revision", async () => {
  const { users, revisions } = setup(); const gate = deferred(); users.findOne.mockReturnValueOnce(gate.promise);
  const reading = revisions.snapshot("a"); revisions.retire("a"); gate.resolve({ userId: "a", dataRev: 0 });
  expect(revisions.sameGeneration(await reading)).toBe(false);
  const first = await revisions.snapshot("a"); users.findOne.mockResolvedValue({ userId: "a", dataRev: 4 });
  const newer = await revisions.snapshot("a");
  expect(revisions.sameGeneration(first)).toBe(false); expect(revisions.sameGeneration(newer)).toBe(false);
  expect(revisions.current(await revisions.snapshot("a"))).toBe(true);
});
test("erasure never resurrects a user and deletion guard precedes a hit", async () => {
  const { users, set, revisions } = setup(); const first = await revisions.snapshot("a");
  set(null); await revisions.run("a", async () => undefined); revisions.forget("a");
  await expect(revisions.snapshot("a")).rejects.toMatchObject({ status: 401, code: "account_deleted" });
  expect(users.findOneAndUpdate.mock.calls[0][2].upsert).toBe(false); expect(revisions.current(first)).toBe(false);
  const deleted = setup({ isDeleted: async () => true });
  await expect(deleted.revisions.snapshot("a")).rejects.toMatchObject({ status: 401 });
});
test("active-state exhaustion bypasses globally without unbounded owner state or ABA", async () => {
  const { revisions } = setup({ maxOwners: 1 }); const end = revisions.begin("a"); const oldEpoch = revisions.epoch;
  const extra = revisions.begin("b"); expect(revisions.owners.size).toBe(1); expect(revisions.overflow).toBe(1);
  expect(revisions.epoch).not.toBe(oldEpoch); await extra(false); await end(false);
  const before = await revisions.snapshot("a"); revisions.state("b");
  expect(revisions.current(before)).toBe(false); expect(revisions.owners.size).toBe(1);
});
test("overflow value and an active GDPR fence cannot be retained", async () => {
  const { set, revisions } = setup(); set({ userId: "a", dataRev: Number.MAX_SAFE_INTEGER });
  await revisions.run("a", async () => true); expect(revisions.counters.revision_failure).toBe(1);
  set({ userId: "a", _gdprMutation: { kind: "restore" } });
  await expect(revisions.snapshot("a")).rejects.toMatchObject({ status: 503 });
});

test("real Mongo validates missing/numeric revisions and refuses malformed or overflowing $inc without upsert", async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server"), { MongoClient, BSON, Decimal128, Long, Double } = require("mongodb");
  const mongo = await MongoMemoryServer.create(), client = new MongoClient(mongo.getUri());
  try {
    await client.connect(); const users = client.db("revision_predicate").collection("users");
    const revisions = new UserRevision(users, { enabled: true });
    for (const [userId, dataRev] of [["missing", undefined], ["valid", 8], ["null", null], ["string", "8"], ["fraction", 1.5], ["negative", -1], ["max", Number.MAX_SAFE_INTEGER]]) {
      await users.insertOne({ userId, ...(dataRev === undefined ? {} : { dataRev }) });
      await revisions.run(userId, async () => true);
      expect((await users.findOne({ userId })).dataRev).toEqual(userId === "missing" ? 1 : userId === "valid" ? 9 : dataRev);
    }
    await revisions.run("erased", async () => true); expect(await users.findOne({ userId: "erased" })).toBeNull();
    expect(revisions.counters.revision_failure).toBe(6);
    for (const [userId, dataRev] of [["safe-long", Long.fromNumber(8)], ["safe-double", new Double(8)]]) {
      await users.insertOne({ userId, dataRev }); await revisions.run(userId, async () => true);
      expect((await users.findOne({ userId })).dataRev).toBe(9);
    }
    const unsupported = [["decimal", Decimal128.fromString("8")], ["unsafe-long", Long.fromString("9007199254740992")],
      ["unsafe-double", new Double(9007199254740992)], ["infinity", new Double(Infinity)], ["negative-infinity", new Double(-Infinity)], ["nan", new Double(NaN)]];
    for (const [userId, dataRev] of unsupported) {
      await users.insertOne({ userId, dataRev });
      const before = await users.findOne({ userId }, { promoteLongs: false, promoteValues: false });
      await revisions.run(userId, async () => true);
      const after = await users.findOne({ userId }, { promoteLongs: false, promoteValues: false });
      expect(BSON.serialize(after).equals(BSON.serialize(before))).toBe(true);
      expect(revisions.current(await revisions.snapshot(userId))).toBe(false);
    }
    expect(revisions.counters.revision_failure).toBe(6 + unsupported.length);
  } finally { await client.close(); await mongo.stop(); }
});
