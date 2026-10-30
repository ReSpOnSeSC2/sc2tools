// @ts-nocheck
"use strict";
const { ObjectId, BSON } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const { takeRepairLivenessIssuer, assertRepairLiveness, REPAIR_LIVENESS_KINDS } = require("../src/services/gdprRepairLiveness");

const userId = "liveness-owner";
let issuer;
const captured = (extra = {}) => ({ userId, id: new ObjectId(), epoch: uuid(), compatibility: false, ...extra });
const bound = (owner, fenceId) => ({ ...owner, epoch: fenceId });
function issued(kind = "repair_opponents", owner = captured()) {
  const fenceId = uuid();
  return { owner, fenceId, kind, handle: issuer.issue(owner, fenceId, kind) };
}
const rejects = (handle, owner, fenceId, kind) => {
  let error;
  try { assertRepairLiveness(handle, owner, fenceId, kind); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "game_stats_repair_authority_unavailable", status: 503 });
  return error;
};

beforeAll(() => { issuer = takeRepairLivenessIssuer(); });

test("the issuer is taken once per module registry; an isolated registry can take its own", () => {
  expect(Object.isFrozen(issuer)).toBe(true);
  expect(Object.keys(issuer).sort()).toEqual(["fail", "issue", "release"]);
  expect(() => takeRepairLivenessIssuer()).toThrow("gdpr_liveness_issuer_taken");
  let isolated;
  jest.isolateModules(() => { isolated = require("../src/services/gdprRepairLiveness").takeRepairLivenessIssuer(); });
  expect(Object.isFrozen(isolated)).toBe(true); expect(isolated).not.toBe(issuer);
  expect(REPAIR_LIVENESS_KINDS).toEqual(["repair_opponents", "admin_rebuild_opponents"]); expect(Object.isFrozen(REPAIR_LIVENESS_KINDS)).toBe(true);
});

test("only genuine repair kinds with a non-null owner id and a UUID fence get an opaque frozen handle", () => {
  for (const kind of REPAIR_LIVENESS_KINDS) {
    const { handle } = issued(kind);
    expect(Object.getPrototypeOf(handle)).toBeNull(); expect(Object.isFrozen(handle)).toBe(true);
    expect(Reflect.ownKeys(handle)).toEqual([]);
  }
  const owner = captured(), fenceId = uuid();
  for (const kind of ["repair_custom-builds", "restore", "snapshot", "delete_all", "", undefined]) expect(issuer.issue(owner, fenceId, kind)).toBeUndefined();
  for (const value of [null, undefined, { ...owner, id: null }, { ...owner, id: undefined }, { ...owner, userId: "" },
    { ...owner, compatibility: "false" }, { ...owner, id: () => 1 }]) expect(issuer.issue(value, fenceId, "repair_opponents")).toBeUndefined();
  for (const id of ["", "not-a-uuid", `${uuid()}x`, 7, null]) expect(issuer.issue(owner, id, "repair_opponents")).toBeUndefined();
});

test("the exact bound tuple passes, including a value-equal ObjectId copy and a compatibility owner", () => {
  const genuine = issued();
  expect(() => assertRepairLiveness(genuine.handle, bound(genuine.owner, genuine.fenceId), genuine.fenceId, genuine.kind)).not.toThrow();
  const copy = { ...bound(genuine.owner, genuine.fenceId), id: new ObjectId(genuine.owner.id.toHexString()) };
  expect(() => assertRepairLiveness(genuine.handle, copy, genuine.fenceId, genuine.kind)).not.toThrow();
  const compat = issued("admin_rebuild_opponents", captured({ compatibility: true, epoch: undefined }));
  expect(() => assertRepairLiveness(compat.handle, bound(compat.owner, compat.fenceId), compat.fenceId, compat.kind)).not.toThrow();
});

test("forged, serialized, cloned and non-object handles are rejected", () => {
  const { owner, fenceId, kind, handle } = issued(), current = bound(owner, fenceId);
  const forged = [Object.freeze(Object.create(null)), {}, JSON.parse(JSON.stringify(handle ?? {})), structuredClone(handle),
    BSON.deserialize(BSON.serialize({ handle })).handle, undefined, null, "handle", 1, Symbol("handle")];
  for (const value of forged) expect(rejects(value, current, fenceId, kind).cause).toBeUndefined();
});

test("every tuple component is compared exactly", () => {
  const { owner, fenceId, kind, handle } = issued(), current = bound(owner, fenceId);
  const mismatches = [[{ ...current, userId: "foreign" }, fenceId, kind], [{ ...current, id: new ObjectId() }, fenceId, kind],
    [{ ...current, epoch: undefined }, fenceId, kind], [{ ...current, epoch: uuid() }, fenceId, kind], [owner, fenceId, kind],
    [{ ...current, compatibility: true }, fenceId, kind], [current, uuid(), kind], [current, fenceId, "admin_rebuild_opponents"],
    [current, fenceId, "repair_custom-builds"], [null, fenceId, kind], [{ ...current, id: () => 1 }, fenceId, kind]];
  for (const [candidate, id, fixedKind] of mismatches) rejects(handle, candidate, id, fixedKind);
  expect(() => assertRepairLiveness(handle, current, fenceId, kind)).not.toThrow();
});

test("mutating the issued owner object never rebinds the handle", () => {
  const owner = captured(), fenceId = uuid(), handle = issuer.issue(owner, fenceId, "repair_opponents"), original = bound(owner, fenceId);
  const hex = owner.id.toHexString(); owner.id.buffer.fill(0); owner.userId = "other"; owner.epoch = uuid();
  rejects(handle, bound(owner, fenceId), fenceId, "repair_opponents");
  expect(() => assertRepairLiveness(handle, { ...original, id: new ObjectId(hex) }, fenceId, "repair_opponents")).not.toThrow();
});

test("the first terminal reason is sticky and lifecycle calls on unknown handles are no-ops", () => {
  const first = issued(), current = bound(first.owner, first.fenceId), e1 = new Error("first"), e2 = new Error("second");
  expect(issuer.fail(first.handle, e1)).toBe(e1); expect(issuer.fail(first.handle, e2)).toBe(e2); issuer.release(first.handle);
  expect(rejects(first.handle, current, first.fenceId, first.kind).cause).toBe(e1);
  const second = issued(); issuer.release(second.handle); issuer.fail(second.handle, e1);
  expect(rejects(second.handle, bound(second.owner, second.fenceId), second.fenceId, second.kind).cause)
    .toMatchObject({ code: "gdpr_repair_fence_released" });
  const unknown = Object.freeze(Object.create(null)), reason = new Error("ignored");
  for (const value of [undefined, null, unknown, {}, "x"]) {
    expect(issuer.fail(value, reason)).toBe(reason); expect(() => issuer.release(value)).not.toThrow();
  }
  expect(rejects(unknown, current, first.fenceId, first.kind).cause).toBeUndefined();
});

test("handles for the same tuple are distinct and closing one never affects the other", () => {
  const owner = captured(), fenceId = uuid(), current = bound(owner, fenceId);
  const one = issuer.issue(owner, fenceId, "repair_opponents"), two = issuer.issue(owner, fenceId, "repair_opponents");
  expect(one).not.toBe(two);
  issuer.fail(one, new Error("lost"));
  rejects(one, current, fenceId, "repair_opponents");
  expect(() => assertRepairLiveness(two, current, fenceId, "repair_opponents")).not.toThrow();
  issuer.release(two); rejects(two, current, fenceId, "repair_opponents");
  expect(issuer.issue(owner, fenceId, "repair_opponents")).not.toBe(one);
});
