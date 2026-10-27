"use strict";
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { SessionResolutionGate } = require("../src/services/sessionResolutionGate");
const { OwnerRevisions } = require("../src/util/gameVisibility");

/** @param {Record<string,unknown>|null} row
 * @param {Record<string,unknown>|null} [token]
 * @param {InstanceType<typeof SessionResolutionGate>} [gate] */
function setup(row, token = null, gate) {
  const users = { findOne: jest.fn(async () => row) }, overlayTokens = { findOne: jest.fn(async () => token) };
  const revisions = new OwnerRevisions();
  return { users, overlayTokens, revisions, service: new SessionPolicyService({ users, overlayTokens }, { revisions, gate }) };
}
/** @template [T=void] @param {T} [_sample]
 * @returns {{promise:Promise<T>,resolve:(value:T)=>void}} */
function deferred(_sample) {
  /** @type {(value:T)=>void} */ let resolve = () => {};
  /** @type {Promise<T>} */ const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test.each([15, 480])("explicit%d wins without any token read", async sessionGapMinutes => {
  const f = setup({ userId: "a", sessionGapMinutes });
  expect(await f.service.resolve("a")).toEqual({ gapMinutes: sessionGapMinutes, source: "preference", storedGapMinutes: sessionGapMinutes });
  expect(f.users.findOne).toHaveBeenCalledTimes(1); expect(f.overlayTokens.findOne).not.toHaveBeenCalled();
});
test.each([null, { _id: "revoked", revokedAt: new Date() }, { _id: "pending", _rotationPending: true }])("Auto depends on ANY persisted token record %j", async token => {
  const f = setup({ userId: "a", sessionGapMinutes: null }, token);
  expect(await f.service.resolve("a")).toEqual({ gapMinutes: token ? 240 : 90, source: token ? "auto-overlay" : "auto-player", storedGapMinutes: null });
  expect(f.overlayTokens.findOne).toHaveBeenCalledWith({ userId: "a" }, { projection: { _id: 1 } });
});
test.each([14, 481, 90.5, "90", false])("corrupt persisted preference%j is an error, never invented Auto", async sessionGapMinutes => {
  const f = setup({ userId: "a", sessionGapMinutes });
  await expect(f.service.resolve("a")).rejects.toMatchObject({ code: "session_policy_invalid" });
  expect(f.overlayTokens.findOne).not.toHaveBeenCalled();
});
test("missing owner, active erasure and failed reads do not invent policy", async () => {
  await expect(setup(null).service.resolve("a")).rejects.toMatchObject({ code: "account_deleted" });
  await expect(setup({ userId: "a", _gdprMutation: {} }).service.resolve("a")).rejects.toMatchObject({ code: "gdpr_operation_busy" });
  const f = setup({ userId: "a" }); f.overlayTokens.findOne.mockRejectedValueOnce(new Error("unavailable"));
  await expect(f.service.resolve("a")).rejects.toThrow("unavailable");
  expect(await f.service.resolve("a")).toMatchObject({ gapMinutes: 90 });
});
test("fresh known Profile value skips user IO and cannot join a previous preference", async () => {
  const f = setup(null);
  expect(await f.service.resolve("a", { ownerKnown: true, storedGapMinutes: 15 })).toMatchObject({ gapMinutes: 15 });
  expect(await f.service.resolve("a", { ownerKnown: true, storedGapMinutes: 480 })).toMatchObject({ gapMinutes: 480 });
  expect(f.users.findOne).not.toHaveBeenCalled(); expect(f.overlayTokens.findOne).not.toHaveBeenCalled();
});
test("held policy IO retires across unknown write and A->B->A generation", async () => {
  const f = setup({ userId: "a" }), held = deferred(/** @type {Record<string,unknown>|null} */ (null)), entered = deferred();
  f.users.findOne.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
  const old = f.service.resolve("a");
  await entered.promise;
  f.service.invalidate("a"); f.revisions.invalidate("a");
  f.service.invalidate("a"); f.revisions.invalidate("a");
  held.resolve({ userId: "a", sessionGapMinutes: 15 });
  await expect(old).rejects.toBeDefined();
  expect(await f.service.resolve("a", { ownerKnown: true, storedGapMinutes: 480 })).toMatchObject({ gapMinutes: 480 });
});
test("TTL15s remains exact", async () => {
  let now = 0; const gate = new SessionResolutionGate({ now: () => now });
  const f = setup({ userId: "a", sessionGapMinutes: 90 }, null, gate);
  await f.service.resolve("a"); now = 14999; await f.service.resolve("a"); expect(f.users.findOne).toHaveBeenCalledTimes(1);
  now = 15000; await f.service.resolve("a"); expect(f.users.findOne).toHaveBeenCalledTimes(2);
});
test("evicted revision identities cannot be rebound to a newer owner's token", () => {
  const f = setup(null), lease = f.service.lease("a");
  for (let i = 0; i < 4097; i++) f.revisions.get(`owner-${i}`);
  f.service.lease("a");
  expect(() => f.service.assertCurrent(lease)).toThrow("session_policy_changed");
});
