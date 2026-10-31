// @ts-nocheck
"use strict";
const { ObjectId } = require("mongodb");
const { randomUUID: uuid } = require("crypto");
const { takeRepairLivenessIssuer } = require("../src/services/gdprRepairLiveness");
const { immutableNeutralMutation } = require("../src/services/gameStatsCountNeutral");
const opponentGame = require("../src/services/gameStatsOpponentGame");
const { stamped, original } = require("./helpers/corpusStamp");

const { immutableOpponentGameMutation, applyOpponentGameMutation, issueOpponentIdentityRepair, issuedOpponentRepair,
  opponentRepairAuthority, applyOpponentGameIdentityRepair, repairContextOwner, OPPONENT_REPAIR_KIND } = opponentGame;
const userId = "opponent-game-owner";
const region = extra => ({ kind: "opponentGameRegion", gameId: "g1", region: "EU", ...extra });
const identity = extra => ({ kind: "opponentGameIdentity", pulseId: "p1", region: "EU", pulseCharacterId: "77", ...extra });
const invalid = { code: "game_stats_neutral_operation_invalid", status: 503 };
let issuer;
beforeAll(() => { issuer = takeRepairLivenessIssuer(); });
function repairContext(kind = "repair_opponents") {
  const fenceId = uuid(), captured = { userId, id: new ObjectId(), epoch: uuid(), compatibility: false };
  const owner = Object.freeze({ ...captured, epoch: fenceId });
  return { owner, context: { owner, fenceId, kind, handle: issuer.issue(captured, fenceId, kind) } };
}
function fakeDb() {
  const result = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  return { games: { updateOne: jest.fn(async () => result), updateMany: jest.fn(async () => result) } };
}
const reject = (input, options) => expect(() => immutableOpponentGameMutation(input, options)).toThrow(expect.objectContaining(invalid));

test("region and identity accept exactly their closed shapes", () => {
  expect(immutableOpponentGameMutation(region())).toEqual(region());
  for (const input of [identity(), identity({ region: undefined }), identity({ pulseCharacterId: undefined })]) {
    for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
    expect(immutableOpponentGameMutation(input)).toEqual(input);
  }
  reject({ kind: "opponentGameRegion", gameId: "g1" }); reject({ kind: "opponentGameIdentity", pulseId: "p1" });
  reject({ gameId: "g1", region: "EU" }); reject({ ...region(), kind: "opponentGameRegionX" });
});

test.each(["filter", "update", "$set", "pipeline", "session", "upsert", "options", "fenceId", "repairFenceId", "countNeutral",
  "owner", "handle", "work", "opponent.region", "pulseId"])("an extra %s key rejects for both kinds", key => {
  reject(region({ [key]: key === "pulseId" ? "p1" : true }));
  if (key !== "pulseId") reject(identity({ [key]: true }));
});

test("symbols, accessors, class instances, null prototypes and arrays reject without invoking getters", () => {
  const getter = jest.fn(() => "g1");
  for (const [factory, field] of [[region, "gameId"], [region, "region"], [identity, "pulseId"], [identity, "region"]]) {
    const input = factory(); Object.defineProperty(input, field, { enumerable: true, get: getter }); reject(input);
  }
  expect(getter).not.toHaveBeenCalled();
  reject({ ...region(), [Symbol("extra")]: true });
  class Region { constructor() { Object.assign(this, region()); } }
  reject(new Region()); reject(Object.assign(Object.create(null), region())); reject([region()]); reject(null); reject("region");
});

test("region gameId must be a nonempty string while region strings stay literal", () => {
  for (const gameId of ["", 1, null, { $ne: null }, ["g"]]) reject(region({ gameId }));
  for (const value of ["", "$literal", " EU "]) expect(immutableOpponentGameMutation(region({ region: value })).region).toBe(value);
  for (const value of [1, null, undefined, { $set: "x" }]) reject(region({ region: value }));
});

test("identity pulseId keeps every literal string by identity and rejects non-strings", () => {
  for (const pulseId of ["", "$weird.key", "  spaced  ", "\uD800lone"]) {
    expect(immutableOpponentGameMutation(identity({ pulseId })).pulseId).toBe(pulseId);
  }
  const missing = identity(); delete missing.pulseId; reject(missing);
  for (const pulseId of [undefined, null, 1, {}, { $ne: null }, ["p1"]]) reject(identity({ pulseId }));
});

test("patch fields must be present strings, and are never trimmed or coerced", () => {
  for (const extra of [{ region: undefined }, { region: null }, { pulseCharacterId: undefined }, { pulseCharacterId: null },
    { region: 1 }, { pulseCharacterId: 77 }]) reject(identity(extra));
  reject({ kind: "opponentGameIdentity", pulseId: "p1" });
  expect(immutableOpponentGameMutation(identity({ region: " eu ", pulseCharacterId: "007" }))).toMatchObject({ region: " eu ", pulseCharacterId: "007" });
});

test("non-empty options reject, even for an issued descriptor", () => {
  const issued = immutableOpponentGameMutation(region());
  for (const options of [{ fenceId: uuid() }, { session: {} }, Object.create(null), null]) {
    reject(region(), options); reject(issued, options);
  }
  expect(immutableOpponentGameMutation(issued, {})).toBe(issued);
});

test("issued descriptors are frozen fresh literals returned as-is on re-validation", () => {
  const input = identity(), issued = immutableOpponentGameMutation(input);
  expect(issued).not.toBe(input); expect(Object.isFrozen(issued)).toBe(true);
  expect(Object.getPrototypeOf(issued)).toBe(Object.prototype);
  input.pulseId = "changed"; input.region = "NA";
  expect(issued).toEqual(identity());
  expect(immutableNeutralMutation(issued)).toBe(issued); expect(immutableOpponentGameMutation(issued)).toBe(issued);
  const other = immutableOpponentGameMutation(region());
  expect(immutableNeutralMutation(other, {})).toBe(other);
});

test("the public validators never accept the repair kind or a nested identity", () => {
  const { context, owner } = repairContext(), repair = issueOpponentIdentityRepair(context, owner, identity());
  for (const input of [{ kind: OPPONENT_REPAIR_KIND, identity: identity() }, repair, { kind: "opponentGameIdentity", identity: identity() }]) {
    expect(() => immutableNeutralMutation(input)).toThrow(expect.objectContaining(invalid)); reject(input);
  }
});

test("the region body is the original filter and $set with an explicit no-upsert option", async () => {
  const db = fakeDb(), session = { id: "session" }, owner = { userId, id: new ObjectId(), compatibility: false };
  const mutation = immutableOpponentGameMutation(region({ region: "$literal" }));
  await applyOpponentGameMutation(db, owner, mutation, session); await applyOpponentGameMutation(db, owner, mutation);
  expect(db.games.updateOne.mock.calls).toEqual([
    [{ userId, gameId: "g1" }, { $set: { "opponent.region": "$literal" } }, { session, upsert: false }],
    [{ userId, gameId: "g1" }, { $set: { "opponent.region": "$literal" } }, { upsert: false }]]);
  expect(db.games.updateMany).not.toHaveBeenCalled();
});

test.each([[{ pulseCharacterId: undefined }, { "opponent.region": "EU" }], [{ region: undefined }, { "opponent.pulseCharacterId": "77" }],
  [{}, { "opponent.region": "EU", "opponent.pulseCharacterId": "77" }]])("the identity body is one fixed updateMany %#", async (drop, set) => {
  const db = fakeDb(), owner = { userId, id: new ObjectId(), compatibility: false }, input = identity({ pulseId: "" });
  for (const key of Object.keys(drop)) delete input[key];
  await applyOpponentGameMutation(db, owner, immutableOpponentGameMutation(input));
  expect(db.games.updateMany.mock.calls).toEqual([[{ userId, "opponent.pulseId": "" }, stamped({ $set: set }), { upsert: false }]]);
  const [[filter, update, options]] = db.games.updateMany.mock.calls;
  expect(JSON.stringify([filter, original(update), options])).not.toMatch(/mmr|league|LookupAttempted|_schemaVersion|date|"userId":"(?!opponent-game-owner)/);
  expect(db.games.updateOne).not.toHaveBeenCalled();
});

test("repair issue requires the exact genuine live context and a fresh identity descriptor", () => {
  const { context, owner } = repairContext(), mutation = issueOpponentIdentityRepair(context, owner, identity());
  expect(Object.isFrozen(mutation)).toBe(true); expect(mutation).toEqual({ kind: OPPONENT_REPAIR_KIND, identity: identity() });
  expect(issuedOpponentRepair(mutation)).toBe(mutation); expect(repairContextOwner(context)).toBe(owner);
  const missing = { ...context }; delete missing.handle;
  const bad = [{ ...context, extra: true }, missing, { ...context, kind: "restore" },
    { ...context, fenceId: uuid() }, { ...context, handle: Object.freeze(Object.create(null)) }, { ...context, handle: undefined }];
  for (const value of bad) expect(() => issueOpponentIdentityRepair(value, owner, identity())).toThrow();
  expect(() => issueOpponentIdentityRepair(context, { ...owner, id: null }, identity())).toThrow();
  expect(() => issueOpponentIdentityRepair(context, { ...owner, epoch: uuid() }, identity())).toThrow();
  expect(() => issueOpponentIdentityRepair(context, owner, region())).toThrow();
  expect(() => issuedOpponentRepair({ kind: OPPONENT_REPAIR_KIND, identity: identity() })).toThrow("game_stats_repair_authority_unavailable");
  const swapped = repairContext("admin_rebuild_opponents");
  expect(() => issueOpponentIdentityRepair({ ...swapped.context, kind: "repair_opponents" }, swapped.owner, identity())).toThrow();
  issuer.fail(context.handle, new Error("lost"));
  expect(() => issueOpponentIdentityRepair(context, owner, identity())).toThrow("game_stats_repair_authority_unavailable");
});

test("repair authority is the exact fenced predicate and rejects a value-different owner", () => {
  const { context, owner } = repairContext("admin_rebuild_opponents"), mutation = issueOpponentIdentityRepair(context, owner, identity());
  expect(opponentRepairAuthority(owner, mutation)).toEqual({ userId, _id: owner.id, gameStatsMutationEpoch: context.fenceId,
    "_gdprMutation.id": context.fenceId, "_gdprMutation.kind": "admin_rebuild_opponents" });
  for (const other of [{ ...owner, id: new ObjectId() }, { ...owner, userId: "other" }, { ...owner, compatibility: true }]) {
    expect(() => opponentRepairAuthority(other, mutation)).toThrow("game_stats_repair_authority_unavailable");
  }
  expect(() => opponentRepairAuthority(owner, { ...mutation })).toThrow("game_stats_repair_authority_unavailable");
});

test("the repair body checks liveness synchronously and never dispatches after closure", async () => {
  const { context, owner } = repairContext(), mutation = issueOpponentIdentityRepair(context, owner, identity()), db = fakeDb();
  await applyOpponentGameIdentityRepair(db, owner, mutation, { id: "s" });
  expect(db.games.updateMany).toHaveBeenCalledTimes(1);
  issuer.release(context.handle);
  expect(() => applyOpponentGameIdentityRepair(db, owner, mutation)).toThrow("game_stats_repair_authority_unavailable");
  expect(() => opponentRepairAuthority(owner, mutation)).toThrow("game_stats_repair_authority_unavailable");
  expect(db.games.updateMany).toHaveBeenCalledTimes(1);
});
