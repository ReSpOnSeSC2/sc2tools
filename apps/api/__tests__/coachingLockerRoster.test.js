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
