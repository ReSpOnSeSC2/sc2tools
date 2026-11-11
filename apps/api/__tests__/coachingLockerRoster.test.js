// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { CoachingService } = require("../src/services/coaching");
const { buildCoachingRouter } = require("../src/routes/coaching");

let mongo, client, db, coaching;

function fixture() {
  return {
    v: 1, setup: true,
    coaches: [
      { id: "c2", name: "Coach Two", userId: "coach-2" },
      { id: "c1", name: "Coach One", userId: "coach-1" },
    ],
    students: [
      { id: "s1", name: "Alex", coachId: "c1", userId: "student-1", note: "Focus", shelf: [{ id: "i1", asset: "f1" }] },
      { id: "s2", name: "Jordan", coachId: "c2", userId: "student-2", note: "Private", worksheets: [{ id: "w1", body: "Private" }] },
      { id: "s3", name: "Blair", coachId: "c1", userId: "student-3", note: "Macro", focus: { title: "Practice" } },
    ].map((student) => ({
      ...student,
      practiceSharing: {
        version: 1, policyVersion: "practice-replays-v1", status: "pending",
        studentUserId: student.userId, coachUserId: student.coachId === "c1" ? "coach-1" : "coach-2",
        requestedAt: new Date("2026-10-01T12:00:00Z"), respondedAt: null, revokedAt: null, grantId: null,
      },
    })),
    assets: { f1: { data: "data:text/plain,fixture" } },
    customBuilds: [{ id: "b1", name: "Build" }],
    wsTemplates: [{ id: "t1", name: "Plan" }],
    shelfLibrary: [{ id: "l1", name: "Replay library" }],
    futureField: { rows: [1, "future", null] },
  };
}

function app(userId, source = "clerk") {
  const server = express();
  server.use(express.json());
  server.use("/v1", buildCoachingRouter({
    auth: (req, _res, next) => { req.auth = { userId, source }; next(); },
    isAdmin: () => false,
    coaching,
  }));
  return server;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  const raw = client.db("locker_roster");
  db = { coaching: raw.collection("coaching"), users: raw.collection("users"), deviceTokens: raw.collection("device_tokens") };
  coaching = new CoachingService({ db });
});

afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all(Object.values(db).map((collection) => collection.deleteMany({})));
  await db.coaching.insertOne({ _id: "locker", rev: 1, state: fixture() });
  await db.users.insertMany(["coach-1", "coach-2", "student-1", "student-2", "student-3"].map((userId) => ({ userId, email: userId + "@example.test" })));
});

test("preserves order and unrelated fields when a coach saves and restores an exported Locker shape", async () => {
  const api = request(app("coach-1"));
  const snapshot = (await api.get("/v1/coaching/state").expect(200)).body;
  expect(snapshot.state.students.map((student) => student.id)).toEqual(["s1", "s3"]);
  const edited = structuredClone(snapshot);
  edited.state.students[0].note = "New focus";
  await api.put("/v1/coaching/state").send(edited).expect(200);
  const expected = fixture();
  expected.students[0].note = "New focus";
  expect((await coaching.getDoc()).state).toEqual(expected);
  await api.put("/v1/coaching/state").send({ rev: 2, state: snapshot.state }).expect(200);
  expect((await coaching.getDoc()).state).toEqual(fixture());
});

test.each([["coach-1", ["s1", "s3"]], ["student-1", ["s1"]]])("scopes conflict responses for %s", async (userId, visible) => {
  const api = request(app(userId));
  const snapshot = (await api.get("/v1/coaching/state").expect(200)).body;
  const conflict = await api.put("/v1/coaching/state").send({ ...snapshot, rev: 0 }).expect(409);
  expect(conflict.headers["cache-control"]).toContain("no-store");
  expect(conflict.body.state.students.map((student) => student.id)).toEqual(visible);
  expect(JSON.stringify(conflict.body)).not.toContain("student-2");
});

test("accepts private account lookup in the request body for signed-in coaching staff only", async () => {
  const api = request(app("coach-1"));
  await api.post("/v1/coaching/users").send({ q: "st" }).expect(400);
  const result = await api.post("/v1/coaching/users").send({ q: "student-2@" }).expect(200);
  expect(result.body.users).toHaveLength(1);
  expect(result.body.users[0].email).toBe("student-2@example.test");
  expect(result.headers["cache-control"]).toContain("no-store");
  await request(app("student-1")).post("/v1/coaching/users").send({ q: "student" }).expect(404);
  await request(app("coach-1", "device")).post("/v1/coaching/users").send({ q: "student" }).expect(404);
});

test("fences the React roster to Clerk staff and rejects another roster's account", async () => {
  const path = "/v1/coaching/state?roster=1";
  await request(app("student-1")).get(path).expect(404);
  await request(app("coach-1", "device")).get(path).expect(404);
  const api = request(app("coach-1"));
  const snapshot = (await api.get(path).expect(200)).body;
  snapshot.state.students.push({ id: "new-student", name: "Already linked", userId: "student-2" });
  const response = await api.put(path).send(snapshot).expect(409);
  expect(response.body).toMatchObject({ error: "account_unavailable" });
  expect((await coaching.getDoc()).rev).toBe(1);
});


test("Shelf CAS writes only visible shelves and the shared library, retaining every other field", async () => {
  const path = "/v1/coaching/state?shelf=1";
  const api = request(app("coach-1"));
  const snapshot = (await api.get(path).expect(200)).body;
  const edited = structuredClone(snapshot);
  edited.state.students[0].name = "Unauthorized Roster edit";
  edited.state.students[0].shelf.unshift({ id: "new", t: "Lesson", ty: "notes", future: [1, 2] });
  edited.state.students.push({ id: "s2", shelf: [{ id: "foreign" }] }, { id: "s4", shelf: [] });
  edited.state.shelfLibrary.unshift({ id: "shared", t: "Macro resource", ty: "notes" });
  edited.state.customBuilds = []; edited.state.wsTemplates = []; edited.state.futureField = null;
  await api.put(path).send(edited).expect(200, { ok: true, rev: 2 });
  const expected = fixture();
  expected.students[0].shelf = edited.state.students[0].shelf;
  expected.shelfLibrary = edited.state.shelfLibrary;
  expect((await coaching.getDoc()).state).toEqual(expected);
  await api.put(path).send(snapshot).expect(409);
  await api.put(path).send({ ...snapshot, rev: "2" }).expect(400);
  await api.put(path).send({ ...snapshot, rev: 2 }).expect(200, { ok: true, rev: 3 });
  expect((await coaching.getDoc()).state).toEqual(fixture());
});

test("student Shelf reads are private and a foreign attachment ID in notes or a new card grants no access", async () => {
  const path = "/v1/coaching/state?shelf=1";
  const seed = fixture();
  seed.students[0].note = "Asset key f2 in a note is ordinary text.";
  seed.students[1].shelf = [{ id: "foreign", ty: "replay", asset: "f2" }];
  seed.assets.f2 = { n: "Private.SC2Replay", mime: "application/octet-stream", b64: "YWJj", size: 3 };
  await db.coaching.updateOne({ _id: "locker" }, { $set: { state: seed } });
  const student = request(app("student-1"));
  const view = await student.get(path).expect(200);
  expect(view.headers["cache-control"]).toContain("no-store");
  expect(view.body.state.students.map(row => row.id)).toEqual(["s1"]);
  expect(view.body.state).not.toHaveProperty("shelfLibrary");
  expect(view.body.state.assets).toEqual({ f1: seed.assets.f1 });
  await student.put(path).send(view.body).expect(404);
  await request(app("coach-1", "device")).get(path).expect(404);
  const api = request(app("coach-1"));
  const edited = (await api.get(path).expect(200)).body;
  expect(edited.state.assets).toEqual({ f1: seed.assets.f1 });
  edited.state.students[0].shelf.unshift({ id: "new", asset: "f2" });
  await api.put(path).send(edited).expect(400);
  const upload = "5106f8f2-0fbb-4c3f-924f-42697fb6502f";
  edited.state.students[0].shelf[0].asset = upload;
  edited.state.assets[upload] = { n: "Drill.pdf", mime: "application/pdf", b64: "YWJj", size: 4 };
  await api.put(path).send(edited).expect(400);
  edited.state.assets[upload].size = 3;
  await api.put(path).send(edited).expect(200);
  const updated = (await student.get(path).expect(200)).body;
  expect(updated.state.assets[upload]).toEqual(edited.state.assets[upload]);
  expect(updated.state.assets).not.toHaveProperty("f2");
});


test("the Shelf preimage can restore records that predate both Shelf fields", async () => {
  const seed = fixture();
  delete seed.shelfLibrary;
  delete seed.students[0].shelf;
  await db.coaching.updateOne({ _id: "locker" }, { $set: { state: seed } });
  const path = "/v1/coaching/state?shelf=1";
  const api = request(app("coach-1"));
  const original = (await api.get(path).expect(200)).body;
  const update = structuredClone(original);
  update.state.shelfLibrary = [{ id: "l2", ty: "notes", t: "First library card" }];
  update.state.students[0].shelf = [{ id: "n2", ty: "notes", t: "First shelf card" }];
  await api.put(path).send(update).expect(200);
  await api.put(path).send({ ...original, rev: 2 }).expect(200);
  expect((await coaching.getDoc()).state).toEqual(seed);
});
