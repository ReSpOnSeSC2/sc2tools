// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const { prepareBuildOrderRequest, chargeBuildOrderQuota } = require("../src/services/buildOrderExportPolicy");

const pepper = Buffer.alloc(32, 0x11), now = 1_800_000_000_000;
const last = { _id: new ObjectId("000000000000000000000123"), date: new Date("2026-01-01T00:00:00Z") };
const request = (query = {}, owner = "owner-A", format = "ndjson", at = now) => prepareBuildOrderRequest(owner, query, format, pepper, at);

test("cursor binds canonical effective filters, not aliases, ordering or raw search", () => {
  const first = request({ result: " victory ", search: "  PrIvAtE\tSearch ", matchup: "pvt", race: "Protoss", map: " MAP ",
    mmr_min: "-200000", accounts: ["1-S2-1-12", "2-S2-1-34"], regions: "NA,EU", map_exact: '["Map B","Map A"]' });
  const token = first.next(last);
  const again = request({ result: "win", search: "private search", matchup: "PvT", race: "P", map: "map", mmr_min: "-100000",
    accounts: ["2-S2-1-34", "1-S2-1-12"], regions: "EU,NA", map_exact: '["Map A","Map B"]', continuation_token: token });
  expect(again.scope).toBe(first.scope); expect(again.position.id).toEqual(last._id);
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  expect(JSON.stringify(payload)).not.toMatch(/owner-A|private|Search|Map A|Map B|synthetic-export-signing-secret/i);
  expect(payload).toMatchObject({ v: 1, i: now, e: now + 24 * 60 * 60 * 1000, f: "ndjson" });
  expect(again.match).not.toHaveProperty("continuation_token");
});

test("different effective RegExp/search/date/build/account scopes cannot reuse a cursor", () => {
  const token = request({ search: "alpha", since: "2026-01-01", build: "Build A" }).next(last);
  for (const query of [
    { search: "beta", since: "2026-01-01", build: "Build A" },
    { search: "alpha", since: "2026-01-02", build: "Build A" },
    { search: "alpha", since: "2026-01-01", build: "Build B" },
    { search: "alpha", since: "2026-01-01", build: "Build A", accounts: "1-S2-1-12" },
  ]) expect(() => request({ ...query, continuation_token: token })).toThrow(expect.objectContaining({ code: "invalid_export_cursor" }));
  expect(() => request({ search: "alpha", since: "2026-01-01", build: "Build A", continuation_token: token }, "owner-B")).toThrow("invalid_export_cursor");
  expect(() => request({ search: "alpha", since: "2026-01-01", build: "Build A", continuation_token: token }, "owner-A", "csv")).toThrow("invalid_export_cursor");
});

test("region permutations preserve the exact effective fallback match and signed cursor scope", () => {
  const first = request({ regions: "NA,EU,PTR" }), token = first.next(last);
  for (const regions of ["PTR,NA,EU", "EU,PTR,NA", ["NA", "PTR", "EU", "NA"]]) {
    const changed = request({ regions, continuation_token: token });
    expect(changed.match).toEqual(first.match);
    expect(changed.scope).toBe(first.scope); expect(changed.position.id).toEqual(last._id);
  }
  expect(() => request({ regions: "NA,EU", continuation_token: token })).toThrow("invalid_export_cursor");
});

test.each([last.date, "2026-01-01T00:00:00Z", 1767225600000, null])("typed position survives and expiry never renews: %p", date => {
  const first = request(), token = first.next({ ...last, date });
  const second = request({ continuation_token: token }, "owner-A", "ndjson", now + 23 * 60 * 60 * 1000);
  expect(second.position.date).toEqual(date);
  const next = second.next({ ...last, date });
  expect(JSON.parse(Buffer.from(next.split(".")[0], "base64url")).e).toBe(now + 24 * 60 * 60 * 1000);
  expect(() => request({ continuation_token: next }, "owner-A", "ndjson", now + 24 * 60 * 60 * 1000)).toThrow(expect.objectContaining({ status: 410, code: "export_cursor_expired" }));
});

test("tampered/noncanonical tokens and malformed query primitives fail before IO", () => {
  const token = request().next(last), [text, signature] = token.split(".");
  for (const changed of ["", `${text}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`, `${text}=.${signature}`, token + ".extra", "x".repeat(2049)]) {
    expect(() => request({ continuation_token: changed })).toThrow("invalid_export_cursor");
  }
  for (const changed of [null, 1, {}, [token]]) {
    expect(() => request({ continuation_token: changed })).toThrow("invalid_export_cursor");
  }
  for (const query of [{ search: ["private"] }, { search: {} }, { since: 1 }, { map_exact: "[]" }, { accounts: {} }, { sort: "date_asc" }, { limit: "2001" }, { search: "x".repeat(2049) }]) {
    expect(() => request(query)).toThrow("invalid_export_options");
  }
});

describe("atomic durable rolling-hour admission against disposable Mongo", () => {
  let mongo, client, users;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); users = client.db("build-export-quota").collection("users"); await users.createIndex({ userId: 1 }, { unique: true }); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  const charge = owner => chargeBuildOrderQuota(users, owner, new AbortController().signal);

  test("five concurrent admissions initialize absent state exactly three times without lost increments", async () => {
    await users.insertOne({ userId: "race", preferences: { retained: true } });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => charge("race")));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(3);
    expect(outcomes.filter(result => result.status === "rejected").map(result => result.reason.code)).toEqual(["export_rate_limited", "export_rate_limited"]);
    const row = await users.findOne({ userId: "race" });
    expect(row.buildOrderExportQuota.v).toBe(1); expect(row.buildOrderExportQuota.t).toHaveLength(3);
    expect(row.buildOrderExportQuota.t.every(at => at instanceof Date && at.getTime() <= Date.now())).toBe(true);
    expect(row.preferences).toEqual({ retained: true });
  });

  test("rolling hour expires old admissions without resetting the other live admissions", async () => {
    const at = Date.now();
    await users.insertOne({ userId: "rolling", buildOrderExportQuota: { v: 1, t: [new Date(at - 2 * 3600_000), new Date(at - 1800_000), new Date(at - 600_000)] } });
    await charge("rolling");
    const saved = await users.findOne({ userId: "rolling" });
    expect(saved.buildOrderExportQuota.t).toHaveLength(3);
    expect(saved.buildOrderExportQuota.t.slice(0, 2)).toEqual([new Date(at - 1800_000), new Date(at - 600_000)]);
    await expect(charge("rolling")).rejects.toMatchObject({ status: 429 });
  });

  test.each([null, {}, { v: 2, t: [] }, { v: 1, t: "bad" }, { v: 1, t: ["2026-01-01"] },
    { v: 1, t: [new Date(Date.now() + 86400_000)] }, { v: 1, t: Array(4).fill(new Date(0)) }, { v: 1, t: [], extra: true }])("malformed present quota is never silently initialized: %p", async quota => {
    const userId = new ObjectId().toHexString(); await users.insertOne({ userId, buildOrderExportQuota: quota });
    await expect(charge(userId)).rejects.toMatchObject({ code: "export_rate_limited" });
    expect((await users.findOne({ userId })).buildOrderExportQuota).toEqual(quota);
  });

  test("GDPR-locked and absent users are not charged or upserted", async () => {
    await users.insertOne({ userId: "blocked", _gdprMutation: { operation: "delete" } });
    await expect(charge("blocked")).rejects.toMatchObject({ status: 429 });
    await expect(charge("absent")).rejects.toMatchObject({ status: 429 });
    expect(await users.findOne({ userId: "absent" })).toBeNull();
    expect(await users.findOne({ userId: "blocked" })).not.toHaveProperty("buildOrderExportQuota");
  });

  test("indeterminate acknowledgement is not retried/refunded and cannot admit metadata", async () => {
    await users.insertOne({ userId: "ack" });
    const command = jest.fn(async (...args) => { await users.findOneAndUpdate(...args); throw Error("private mongodb URL/token"); });
    await expect(chargeBuildOrderQuota({ findOneAndUpdate: command }, "ack", new AbortController().signal)).rejects.toMatchObject({ status: 503, message: "export_unavailable" });
    expect(command).toHaveBeenCalledTimes(1); expect(command.mock.calls[0][2]).toMatchObject({ upsert: false });
    expect((await users.findOne({ userId: "ack" })).buildOrderExportQuota.t).toHaveLength(1);
  });
});
