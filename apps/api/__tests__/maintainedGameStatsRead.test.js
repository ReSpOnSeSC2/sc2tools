// @ts-nocheck
"use strict";

const { ObjectId, Long, Timestamp } = require("mongodb");
const { readyStatsFromOwnerRow, REQUIRED_MAINTENANCE_VERSION } = require("../src/services/maintainedGameStatsRead");
const { qualifiedTotal, MAX_STATS_BYTES } = require("../src/services/gameStatsMaintenance");
const revision = "11111111-2222-4333-8444-555555555555";
const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const played = new Date("2026-10-28T09:00:00Z");
function ready() {
  const id = new ObjectId();
  return { _id: id, userId: "owner", gameStatsProtocolVersion: 2, gameStatsWriterStatus: "transactional",
    gameStatsRevision: revision, gameStatsMutationEpoch: epoch, gameStats: { total: 2, latest: played },
    gameStatsMaintenance: { version: REQUIRED_MAINTENANCE_VERSION, status: "ready", ownerId: id, revision, epoch } };
}
const read = row => readyStatsFromOwnerRow(row, "owner", true);

test("fresh qualified proof returns only a copied total/latest DTO and ignores advisory dataRev", () => {
  const row = ready(); row.dataRev = "untrusted advisory"; row.gameStatsMaintenance.internal = "private";
  const stats = read(row);
  expect(stats).toEqual({ total: 2, latest: played });
  expect(Object.keys(stats)).toEqual(["total", "latest"]); expect(stats.latest).not.toBe(row.gameStats.latest);
  stats.latest.setTime(0); expect(row.gameStats.latest).toEqual(played);
});
test("legacy maintenance1 qualifies for neither the new writer delta base nor the reader", () => {
  const row = ready(); row.gameStatsMaintenance.version = 1;
  expect(read(row)).toBeNull();
  expect(qualifiedTotal(row, { userId: "owner", id: row._id, epoch, compatibility: false })).toBeNull();
  row.gameStatsMaintenance.version = REQUIRED_MAINTENANCE_VERSION;
  expect(qualifiedTotal(row, { userId: "owner", id: row._id, epoch, compatibility: false })).toBe(2);
});
test.each([undefined, null, false, 1, "true"])("unknown transaction capability %p never authorizes maintained stats", capability => {
  expect(readyStatsFromOwnerRow(ready(), "owner", capability)).toBeNull();
});
test.each([undefined, null, {}, [], "owner"])("missing/malformed owner row %p is an explicit miss", value => {
  expect(read(value)).toBeNull();
});
test.each([
  row => { delete row._id; }, row => { row._id = null; },
  row => { row.userId = "other"; }, row => { row.userId = ["owner"]; },
  row => { row._id = new ObjectId(); }, row => { row.gameStatsMaintenance.ownerId = String(row._id); },
  row => { row.gameStatsProtocolVersion = 1; }, row => { row.gameStatsProtocolVersion = "2"; },
  row => { row.gameStatsWriterStatus = "unsupported"; }, row => { delete row.gameStats; },
  row => { delete row.gameStatsMaintenance; }, row => { row.gameStatsMaintenance = []; },
  row => { row.gameStatsMaintenance.version = "2"; }, row => { row.gameStatsMaintenance.version = 3; },
  row => { row.gameStatsMaintenance.status = "unsupported_latest"; }, row => { row.gameStatsMaintenance.status = "unretained"; },
  row => { row.gameStatsMaintenance.revision = "different"; },
  row => { row.gameStatsRevision = row.gameStatsMaintenance.revision = "malformed-but-equal"; },
  row => { delete row.gameStats.latest; }, row => { row.gameStats.total = -1; },
  row => { row.gameStats.total = Number.MAX_SAFE_INTEGER + 1; }, row => { row.gameStats.total = NaN; },
  row => { row.gameStats.total = Long.fromNumber(2); }, row => { row.gameStats.total = "2"; },
  row => { row.gameStats.total = 0; }, row => { row.gameStats.latest = new Date(NaN); },
])("invalid owner/maintenance/DTO shape fails closed (%#)", alter => {
  const row = ready(); alter(row); expect(read(row)).toBeNull();
});
test("BSON-equivalent owner IDs qualify without accepting a coerced string owner", () => {
  const row = ready(); row.gameStatsMaintenance.ownerId = new ObjectId(row._id.toHexString());
  expect(read(row)).toEqual({ total: 2, latest: played });
  row.gameStatsMaintenance.ownerId = row._id.toHexString(); expect(read(row)).toBeNull();
});
test.each([undefined, null, false, 0, "", {}, { id: "expired", leaseUntil: new Date(0) }])("even falsy/expired GDPR field %p forbids reuse", fence => {
  const row = ready(); row._gdprMutation = fence; expect(read(row)).toBeNull();
});
test("ordinary admission leases do not block a valid committed tuple", () => {
  const row = ready(); row._dataMutations = [{ id: "ordinary", leaseUntil: new Date(0) }];
  expect(read(row)).toEqual({ total: 2, latest: played });
});
test("epoch absence qualifies only when absent on both proof and owner", () => {
  const row = ready(); delete row.gameStatsMutationEpoch; delete row.gameStatsMaintenance.epoch;
  expect(read(row)).toEqual({ total: 2, latest: played });
  row.gameStatsMaintenance.epoch = undefined; expect(read(row)).toBeNull();
  delete row.gameStatsMaintenance.epoch; row.gameStatsMutationEpoch = undefined; expect(read(row)).toBeNull();
});
test("an inherited epoch cannot stand in for actual metadata authority", () => {
  const row = ready(); delete row.gameStatsMaintenance.epoch;
  Object.setPrototypeOf(row.gameStatsMaintenance, { epoch }); expect(read(row)).toBeNull();
});
test.each([null, "", "malformed", revision, undefined])("a replaced or malformed epoch %p cannot retain the old proof", replacement => {
  const row = ready(); row.gameStatsMutationEpoch = replacement; expect(read(row)).toBeNull();
});
test.each([0, 2])("total%d/latestnull preserves the authoritative missing/falsy-date contract", total => {
  const row = ready(); row.gameStats = { total, latest: null };
  expect(read(row)).toEqual({ total, latest: null });
});
test.each(["2026-10-28", [played], { date: played }, false, 0, "", Timestamp.fromNumber(7), Long.fromNumber(9)])("raw legacy latest %p is returned to fallback without conversion", latest => {
  const row = ready(); row.gameStats.latest = latest;
  expect(read(row)).toBeNull(); expect(row.gameStats.latest).toBe(latest);
});
test("oversize or unserializable candidate cannot be retained", () => {
  const row = ready(); row.gameStats.extra = "x".repeat(MAX_STATS_BYTES);
  expect(read(row)).toBeNull();
  delete row.gameStats.extra; row.gameStats.circular = row.gameStats; expect(read(row)).toBeNull();
});
test("a throwing malformed proof is a miss without swallowing actual external query errors", () => {
  const row = ready(); Object.defineProperty(row, "gameStatsMaintenance", { get() { throw new Error("malformed proof"); } });
  expect(read(row)).toBeNull();
});
