// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildDailyCrowdRouter } = require("../src/routes/dailyCrowd");
const { DailyCrowdService, BUCKET_CAP } = require("../src/services/dailyCrowd");
const { currentDay, createDailySchedule, DAY_MS } = require("../src/services/dailySchedule");
const { sanitiseRequestForLog, sanitiseResponseForLog } = require("../src/middleware/requestLogging");
const { privateSearchHttpOptions, beforeSendPrivateSearch } = require("../src/middleware/privateSearchTelemetry");

const pack = "a".repeat(64);
const other = "b".repeat(64);
const practicePacks = "cdef012".split("").map(char => char.repeat(64));
const now = currentDay() * DAY_MS + DAY_MS / 2;
const day = currentDay(now);
const ballot = (attempt, answers = [0, 1, 2, 3, 4]) => ({
  day, pack, attempt: attempt.toString(16).padStart(32, "0"), answers,
});

let mongo;
let db;
let api;
let crowd;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "daily_crowd" });
});

afterAll(async () => {
  await db?.client.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await db.dailyTally.deleteMany({});
  crowd = new DailyCrowdService(db.dailyTally, { now: () => now, schedule: async () => pack });
  const app = express();
  app.use("/v1", buildDailyCrowdRouter(crowd));
  api = request(app);
});

const submit = value => api.post("/v1/daily/calls").send(value);

test("caps parsing, admits only five enum answers for the current recorded pack, and caches no response", async () => {
  for (const body of [
    { ...ballot(1), accountId: "ignored" }, ballot(1, [0, 1, 2, 3]), ballot(1, [0, 1, 2, 3, 5]),
    ballot(1, [0, 1, 2, 3, "4"]),
  ]) {
    const rejected = await submit(body).expect(400);
    expect(rejected.headers["cache-control"]).toBe("no-store");
  }
  await submit({ ...ballot(1), day: day + 1 }).expect(404);
  await submit({ ...ballot(1), day: day - 1 }).expect(404);
  await submit({ ...ballot(1), pack: other }).expect(404);
  await submit({ ...ballot(1), answers: "x".repeat(2000) }).expect(413);
  expect(await db.dailyTally.countDocuments()).toBe(0);
});

test("does not accept a day that rolls over while waiting for the schedule", async () => {
  let time = now;
  const service = new DailyCrowdService(db.dailyTally, { now: () => time, schedule: async () => {
    time += DAY_MS;
    return pack;
  } });
  await expect(service.submit(ballot(1))).rejects.toMatchObject({ status: 404 });
  expect(await db.dailyTally.countDocuments()).toBe(0);
});

test("keeps the same vote through concurrent retries and ignores changed calls on the same attempt", async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => submit(ballot(1))));
  expect(responses.map(response => response.status)).toEqual(Array(6).fill(200));
  await submit(ballot(1, [4, 3, 2, 1, 0])).expect(200, { state: "waiting" });
  const rows = await db.dailyTally.find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ total: 1, counts: { 0: 1, 6: 1, 12: 1, 18: 1, 24: 1 } });
  expect(rows[0]._schemaVersion).toBe(1);
  expect(rows[0].receipts).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(JSON.stringify(rows)).not.toContain(ballot(1).attempt);
  expect(rows[0].expiresAt).toEqual(new Date((day + 2) * DAY_MS));
  expect(await db.dailyTally.indexes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    expect.objectContaining({ key: { day: 1, pack: 1 } }),
  ]));
});

test("only reveals the exact aggregate at twenty votes and below capacity on each bucket", async () => {
  await Promise.all(Array.from({ length: 19 }, (_, index) => crowd.submit(ballot(index))));
  expect(await crowd.submit(ballot(0))).toEqual({ state: "waiting" });
  const result = await crowd.submit(ballot(20, [4, 3, 2, 1, 0]));
  expect(result).toEqual({
    state: "ready", total: 20,
    fights: [[19, 0, 0, 0, 1], [0, 19, 0, 1, 0], [0, 0, 20, 0, 0], [0, 1, 0, 19, 0], [1, 0, 0, 0, 19]],
  });
  await db.dailyTally.updateMany({}, { $set: { total: BUCKET_CAP } });
  await expect(crowd.record("full", "old", ballot(20))).resolves.toBeUndefined();
  await db.dailyTally.updateOne({ _id: "full" }, { $set: { total: BUCKET_CAP } });
  await expect(crowd.record("full", "new", ballot(21))).rejects.toMatchObject({ status: 503 });
  await expect(crowd.record("full", "old", ballot(20))).resolves.toBeUndefined();
});

test("bounds anonymous POSTs independently", async () => {
  for (let index = 0; index < 8; index++) await submit(ballot(index)).expect(200);
  const limited = await submit(ballot(9)).expect(429);
  expect(limited.headers["cache-control"]).toBe("no-store");
  expect(limited.body).toEqual({ error: { code: "rate_limited" } });
});

test("reports schedule failure as retryable without exposing its details or writing a ballot", async () => {
  crowd.schedule = async () => { throw new Error("private fixture"); };
  const response = await submit(ballot(1)).expect(503);
  expect(response.body).toEqual({ error: { code: "daily_calls_unavailable" } });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(await db.dailyTally.countDocuments()).toBe(0);
  await api.get("/v1/daily/calls").expect(404);
});

test("retains only anonymous route metadata in app logs and keeps ballots out of Sentry", () => {
  const url = "/v1/daily/calls?attempt=raw-receipt";
  const req = { method: "POST", id: "caller", originalUrl: url, socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "127.0.0.1", "user-agent": "device" } };
  expect(sanitiseRequestForLog(req)).toEqual({ method: "POST", url: "/v1/daily/calls" });
  const res = { req: { url }, statusCode: 200, headersSent: true, getHeader: () => "caller" };
  expect(sanitiseResponseForLog(res)).toEqual({ statusCode: 200 });
  expect(privateSearchHttpOptions().ignoreIncomingRequestBody(url)).toBe(true);
  expect(privateSearchHttpOptions().ignoreIncomingRequests(url)).toBe(true);
  expect(beforeSendPrivateSearch({ request: { url, data: ballot(1) } })).toBeNull();
});

test("pins only today's recorded digest, rechecks at midnight, and keeps the source fixed", async () => {
  let time = now;
  let todayPack = pack;
  const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
    version: 1, days: { [day]: todayPack, [day + 1]: other }, practice: practicePacks,
  })));
  const load = createDailySchedule({ fetchImpl, now: () => time });
  expect(await load(day - 1)).toBeNull();
  expect(await load(day + 1)).toBeNull();
  expect(await Promise.all([load(day), load(day)])).toEqual([pack, pack]);
  expect(await load(day)).toBe(pack);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith("https://sc2tools.com/daily/v1/index.json",
    expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  todayPack = other;
  time += 30_001;
  expect(await load(day)).toBeNull();
  time += DAY_MS;
  expect(await load(day)).toBeNull();
  expect(await load(day + 1)).toBe(other);
});

test("rejects practice aliases and unavailable or oversized schedules", async () => {
  const practice = createDailySchedule({ now: () => now, fetchImpl: async () =>
    new Response(JSON.stringify({ version: 1, days: { [day]: pack }, practice: [pack, ...practicePacks.slice(1)] })) });
  expect(await practice(day)).toBeNull();
  const invalid = createDailySchedule({ now: () => now, fetchImpl: async () =>
    new Response(JSON.stringify({ version: 1, days: { [day]: pack }, practice: [] })) });
  await expect(invalid(day)).rejects.toThrow("daily_schedule_invalid");
  const large = createDailySchedule({ now: () => now, fetchImpl: async () => new Response(" ".repeat(40_001)) });
  await expect(large(day)).rejects.toThrow("daily_schedule_too_large");
  const missing = createDailySchedule({ now: () => now, fetchImpl: async () => new Response(null, { status: 503 }) });
  await expect(missing(day)).rejects.toThrow("daily_schedule_unavailable");
});
