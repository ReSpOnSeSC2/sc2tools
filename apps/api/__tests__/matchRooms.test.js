// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { randomBytes } = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { sha256 } = require("../src/util/hash");
const { MatchRoomsService, LIFE_MS } = require("../src/services/matchRooms");
const { buildMatchRoomsRouter } = require("../src/routes/matchRooms");
const { sanitiseRequestUrl, sanitiseRequestForLog } = require("../src/middleware/requestLogging");

const config = { format: 3, preset: "standard", maps: ["Alpha", "Bravo", "Charlie", "Delta"], practice: false };
const seatKey = (host, seat) => sha256("match-room/seat-" + seat + ":" + host);
const newAttempt = () => randomBytes(24).toString("hex");

let mongo;
let ctx;
let now;
let api;
let service;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  ctx = await connect({ uri: mongo.getUri(), dbName: "match_rooms" });
});
afterAll(async () => {
  await ctx?.client.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await ctx.matchRooms.deleteMany({});
  now = Date.now();
  service = new MatchRoomsService(ctx.matchRooms, { now: () => now, capacity: 2 });
  const app = express();
  app.use("/v1", buildMatchRoomsRouter(service));
  api = request(app);
});

async function create() {
  const res = await postRoom(newAttempt()).expect(201);
  return { ...res.body, path: "/v1/match-rooms/" + res.body.id };
}

function postRoom(attempt, options = config) {
  return api.post("/v1/match-rooms").send({ ...options, attempt });
}

function mutate(room, key, rev, action) {
  return api.post(room.path + "/actions").send({ key, rev, action });
}

test("stores only digests and reads a redacted, no-store public DTO", async () => {
  const room = await create();
  const stored = await ctx.matchRooms.findOne({ _id: sha256(room.id) });
  expect(stored.expiresAt.getTime() - now).toBe(LIFE_MS);
  expect(stored.credentials.host).toBe(sha256(room.hostKey));
  expect(JSON.stringify(stored)).not.toContain(room.hostKey);
  expect(JSON.stringify(stored)).not.toContain(room.id);
  const res = await api.get(room.path).expect(200).expect("Cache-Control", "no-store")
    .expect("X-Robots-Tag", "noindex, nofollow");
  expect(res.body).toMatchObject({ rev: 0, phase: "lobby", config });
  for (const key of ["_id", "credentials", "seed", "steps", "slot", "creationSalt", "creationDigest"]) {
    expect(res.body).not.toHaveProperty(key);
  }
  await api.get(room.path + "?rev=0").expect(204);
  await api.get(room.path + "?rev=0&rev=1").expect(400);
  const indexes = await ctx.matchRooms.indexes();
  expect(indexes).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    expect.objectContaining({ key: { slot: 1 }, unique: true, sparse: true }),
    expect.objectContaining({ key: { creationDigest: 1 }, unique: true }),
  ]));
});

test("one revision wins concurrent writes from the two seats", async () => {
  const room = await create();
  const results = await Promise.all(["a", "b"].map(seat =>
    mutate(room, seatKey(room.hostKey, seat), 0, { type: "name", value: "Seat " + seat })));
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const res = await api.get(room.path).expect(200);
  expect(res.body.rev).toBe(1);
  expect(Object.values(res.body.names).filter(Boolean)).toHaveLength(1);
  await mutate(room, room.id, 1, { type: "name", value: "Watch" }).expect(403);
});

test("a stale revision rejects a write that would otherwise be legal", async () => {
  const room = await create();
  await mutate(room, seatKey(room.hostKey, "a"), 0, { type: "name", value: "Blue" }).expect(200);
  await mutate(room, seatKey(room.hostKey, "b"), 0, { type: "name", value: "Red" })
    .expect(409, { error: { code: "match_room_changed" } });
  const res = await api.get(room.path).expect(200);
  expect(res.body).toMatchObject({ rev: 1, names: { a: "Blue", b: "" } });
});

test("reads at the deadline commit the timed move once and reject a stale manual veto", async () => {
  const room = await create();
  await mutate(room, seatKey(room.hostKey, "a"), 0, { type: "ready", value: true }).expect(200);
  const res = await mutate(room, seatKey(room.hostKey, "b"), 1, { type: "ready", value: true }).expect(200);
  now = res.body.deadline;
  const results = await Promise.all([api.get(room.path + "?rev=2"), api.get(room.path + "?rev=2"),
    mutate(room, seatKey(room.hostKey, res.body.turn.seat), 2, { type: "veto", map: 0 })]);
  expect(results.map(result => result.status)).toEqual([200, 200, 409]);
  expect(results[0].body.moves).toEqual(results[1].body.moves);
  expect(results[0].body.moves).toMatchObject([{ automatic: true }]);
  await api.get(room.path + "?rev=3").expect(204);
});

test("hard caps simultaneous creates, then releases a deleted or expired slot", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => postRoom(newAttempt())));
  expect(results.map(result => result.status).sort()).toEqual([201, 201, 503, 503, 503]);
  const room = results.find(result => result.status === 201).body;
  const path = "/v1/match-rooms/" + room.id;
  await api.delete(path).send({ key: seatKey(room.hostKey, "a") }).expect(403);
  await api.delete(path).send({ key: room.hostKey }).expect(204);
  await api.get(path).expect(404);
  const replacement = await create();
  now += LIFE_MS;
  await api.get(replacement.path).expect(404);
  await create();
});

test("concurrent creation retries recover one invite even when the room cap is full", async () => {
  const attempt = newAttempt();
  const [first, retry] = await Promise.all([postRoom(attempt).expect(201), postRoom(attempt).expect(201)]);
  expect(retry.body).toEqual(first.body);
  expect(await ctx.matchRooms.countDocuments()).toBe(1);
  const stored = await ctx.matchRooms.findOne({ _id: sha256(first.body.id) });
  expect(JSON.stringify(stored)).not.toContain(attempt);
  await create();
  await postRoom(attempt).expect(201, first.body);
  await postRoom(newAttempt()).expect(503);
  await postRoom(attempt, { ...config, practice: true }).expect(409, { error: { code: "match_room_attempt_mismatch" } });
});

test("host deletion erases the room and delayed creation cannot revive its invite", async () => {
  const attempt = newAttempt();
  const { body: { id, hostKey } } = await postRoom(attempt).expect(201);
  const path = "/v1/match-rooms/" + id;
  await api.delete(path).send({ key: hostKey }).expect(204);
  await api.get(path).expect(404, { error: { code: "match_room_missing" } });
  await postRoom(attempt).expect(409, { error: { code: "match_room_attempt_closed" } });
  const retired = await ctx.matchRooms.findOne({ _id: sha256(id) });
  expect(Object.keys(retired).sort()).toEqual(["_id", "_schemaVersion", "creationDigest", "expiresAt"]);
  await ctx.matchRooms.deleteOne({ _id: sha256(id) }); // Simulate the short tombstone's TTL sweep.
  const later = await postRoom(attempt).expect(201);
  expect(later.body.id).not.toBe(id);
  expect(later.body.hostKey).not.toBe(hostKey);
  await api.get(path).expect(404);
});

test("limits per-IP creation before body parsing and hides malformed JSON details", async () => {
  const path = "/v1/match-rooms";
  const res = await api.post(path).type("json").send('{"key": "private",').expect(400);
  expect(JSON.stringify(res.body)).not.toContain("private");
  for (let index = 0; index < 9; index += 1) await api.post(path).send({}).expect(400);
  await api.post(path).send(config).expect(429).expect("Cache-Control", "no-store");
});

test("request logs redact the room locator and credentials", () => {
  const url = "/v1/match-rooms/secret-room/actions?rev=3&key=private";
  expect(sanitiseRequestUrl(url)).toBe("/v1/match-rooms/[redacted]/actions?rev=3&key=%5Bredacted%5D");
  const log = sanitiseRequestForLog({ url, headers: { authorization: "Bearer private", host: "api" } });
  expect(JSON.stringify(log)).not.toMatch(/private|secret-room/u);
});
