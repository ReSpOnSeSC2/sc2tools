// @ts-nocheck
"use strict";
const { ObjectId } = require("mongodb");
const { immutableSelection, qualifiedTotal, PROTOCOL_VERSION, MAINTENANCE_VERSION, MAX_STATS_BYTES } = require("../src/services/gameStatsMaintenance");
const revision = "11111111-2222-4333-8444-555555555555";
const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const owner = { userId: "owner", id: new ObjectId(), epoch, compatibility: false };
function before() {
  return { _id: owner.id, gameStatsMutationEpoch: epoch, gameStatsProtocolVersion: PROTOCOL_VERSION,
    gameStatsWriterStatus: "transactional", gameStatsRevision: revision,
    gameStats: { total: 1, latest: null },
    gameStatsMaintenance: { version: MAINTENANCE_VERSION, ownerId: owner.id, revision, epoch, status: "ready" } };
}

test("selection is copied, BSON-safe, bounded and not a caller-controlled query", () => {
  const ids = [new ObjectId()], selected = immutableSelection({ ids });
  const original = selected._id.$in[0].toHexString(); ids[0].id.fill(0); ids.push(new ObjectId());
  expect(selected._id.$in).toHaveLength(1); expect(selected._id.$in[0].toHexString()).toBe(original);
  expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected._id.$in)).toBe(true);
  expect(immutableSelection({ ids: [] })).toEqual({ _id: { $in: [] } });
});
test.each([undefined, {}, { ids: [], gameIds: [] }, { gameIds: [null] }, { ids: Array.from({ length: 101 }, (_, n) => n) }])("selection %p fails before transaction admission", value => {
  expect(() => immutableSelection(value)).toThrow(/game_stats_selection/);
});

test("a positive count with null latest is a valid legacy contract", () => {
  expect(qualifiedTotal(before(), owner)).toBe(1);
  const row = before(); row.gameStats.total = 0; expect(qualifiedTotal(row, owner)).toBe(0);
});
test.each([
  row => { delete row.gameStats; },
  row => { row.gameStatsProtocolVersion = 1; },
  row => { row.gameStatsWriterStatus = "unsupported"; },
  row => { row.gameStatsMaintenance.version = 0; },
  row => { row.gameStatsMaintenance.revision = "different"; },
  row => { row.gameStatsRevision = row.gameStatsMaintenance.revision = "matching-but-malformed"; },
  row => { row.gameStatsMaintenance.ownerId = new ObjectId(); },
  row => { row.gameStatsMaintenance.epoch = null; },
  row => { row.gameStatsMutationEpoch = null; },
  row => { row.gameStats.total = -1; },
  row => { row.gameStats.total = Number.MAX_SAFE_INTEGER + 1; },
  row => { delete row.gameStats.latest; },
  row => { row.gameStats.latest = "truthy but ready is false"; },
  row => { row.gameStats.latest = new Date(NaN); },
  row => { row.gameStats.total = 0; row.gameStats.latest = new Date(); },
  row => { row.gameStatsMaintenance.status = "unsupported_latest"; },
  row => { row.gameStatsMaintenance.status = "unretained"; },
])("corrupt authority/status shape cannot supply a delta base (%#)", alter => {
  const row = before(); alter(row); expect(qualifiedTotal(row, owner)).toBeNull();
});
test("unsupported raw latest can supply only its qualified total; its value is not converted", () => {
  const row = before(); row.gameStats.latest = [new Date("2030-01-01"), "legacy"];
  row.gameStatsMaintenance.status = "unsupported_latest";
  expect(qualifiedTotal(row, owner)).toBe(1); expect(row.gameStats.latest[1]).toBe("legacy");
  row.gameStats.latest = "x".repeat(MAX_STATS_BYTES); expect(qualifiedTotal(row, owner)).toBeNull();
});
test.each([0, false, "", NaN])("falsy raw %p cannot masquerade as the original non-null latest result", latest => {
  const row = before(); row.gameStats.latest = latest; row.gameStatsMaintenance.status = "unsupported_latest";
  expect(qualifiedTotal(row, owner)).toBeNull();
});
test("unsupported driver values which BSON would normalize cannot supply retained authority", () => {
  for (const latest of [new Date(NaN), { value: undefined }]) {
    const row = before(); row.gameStats.latest = latest; row.gameStatsMaintenance.status = "unsupported_latest";
    expect(qualifiedTotal(row, owner)).toBeNull();
  }
});
test("missing epoch requires both prior and metadata to lack the field, never null", () => {
  const row = before(), legacyOwner = { ...owner }; delete legacyOwner.epoch;
  delete row.gameStatsMutationEpoch; delete row.gameStatsMaintenance.epoch;
  expect(qualifiedTotal(row, legacyOwner)).toBe(1);
  row.gameStatsMaintenance.epoch = null; expect(qualifiedTotal(row, legacyOwner)).toBeNull();
});
