// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { CoachingService } = require("../src/services/coaching");
const { buildCoachingRouter } = require("../src/routes/coaching");

const STATE = "/v1/coaching/state";
const WORKSHEETS = `${STATE}?worksheets=1`;
const draft = { id: "draft-1", title: "Private coach draft", state: "draft", answers: {},
  blocks: [{ id: "q-draft", ty: "long", q: "Unpublished prompt", privateExtension: "keep" }] };
const sent = { id: "sent-1", title: "Practice review", state: "sent", answers: {}, blocks: [
  { id: "choice", ty: "mc", q: "Which cue?", opts: ["Nexus", "No Nexus"], cueMetadata: 2 },
  { id: "long", ty: "long", q: "What did you see?" }, { id: "replay", ty: "replay", q: "Attach a replay" },
] };
const completed = { ...sent, id: "completed-1", title: "Prior review", state: "submitted", answers: { long: "Prior student response" },
  submittedAt: "2026-11-07T20:00:00.000Z" };
const older = { id: "earlier-replay", name: "Earlier.SC2Replay", size: 3, b64: "REVG", at: "2026-11-05T01:00:00.000Z", build: "worksheet: Practice review", exported: true };
const attachment = { id: "new-replay", name: "Example.SC2Replay", size: 3, b64: "QUJD", at: "2026-11-07T23:00:00.000Z", build: "worksheet: Practice review", exported: false };

function fixture() {
  return {
    v: 1, setup: true, coaches: [{ id: "coach-b", name: "Coach B", userId: "coach-2" }, { id: "coach-a", name: "Coach A", userId: "coach-1" }],
    students: [{ id: "student-a", name: "Student A", coachId: "coach-a", userId: "student-1", focus: { title: "Review first" },
      worksheets: [structuredClone(draft), structuredClone(sent), structuredClone(completed)], submissions: [older], shelf: [{ id: "sheet-shelf", asset: "shelf-asset" }],
      unknownExtension: { fields: ["keep", 2] } },
    { id: "student-b", name: "Student B", coachId: "coach-b", userId: "student-2", worksheets: [{ ...structuredClone(draft), id: "draft-2", title: "Other student private" }] }]
      .map((student, index) => ({ ...student, practiceSharing: {
        version: 1, policyVersion: "practice-replays-v1", status: "pending", studentUserId: student.userId,
        coachUserId: `coach-${index + 1}`, requestedAt: new Date("2026-11-01T12:00:00Z"),
        respondedAt: null, revokedAt: null, grantId: null,
      } })),
    assets: { "shelf-asset": { data: "data:text/plain,asset" } }, customBuilds: [{ id: "build", name: "Build" }],
    wsTemplates: [{ id: "template", title: "Prior template", blocks: sent.blocks }], contentStudio: { unknown: "unchanged" },
  };
}

let mongo, client, db, coaching;
function app(userId, source = "clerk") {
  const server = express();
  server.use(express.json());
  server.use("/v1", buildCoachingRouter({
    auth: (req, _res, next) => { req.auth = { userId, source }; next(); }, isAdmin: () => userId === "admin", coaching,
  }));
  return request(server);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect();
  const collections = client.db("locker_worksheets");
  db = { coaching: collections.collection("coaching"), users: collections.collection("users"), deviceTokens: collections.collection("device_tokens") };
  coaching = new CoachingService({ db });
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all(Object.values(db).map(collection => collection.deleteMany({})));
  await db.coaching.insertOne({ _id: "locker", rev: 1, state: fixture() });
  await db.users.insertMany(["coach-1", "coach-2", "student-1", "student-2", "admin"].map(userId => ({ userId, email: `${userId}@example.test` })));
});

test("react student reads and conflicts omit drafts while Classic remains available", async () => {
  const student = app("student-1");
  const current = await student.get(WORKSHEETS).expect(200);
  expect(current.headers["cache-control"]).toContain("no-store");
  expect(current.body.state.students.map(row => row.id)).toEqual(["student-a"]);
  expect(current.body.state.students[0].worksheets.map(row => row.id)).toEqual(["sent-1", "completed-1"]);
  expect(JSON.stringify(current.body)).not.toMatch(/Unpublished prompt|Other student private/);
  const conflict = await student.put(WORKSHEETS).send({ ...current.body, rev: 0 }).expect(409);
  expect(conflict.body.state).toEqual(current.body.state);
  expect((await student.get(STATE).expect(200)).body.state.students[0].worksheets.map(row => row.id)).toEqual(["sent-1", "completed-1"]);
  await app("student-1", "device").get(WORKSHEETS).expect(404);
  await student.get(`${WORKSHEETS}&shelf=1`).expect(404);
  const previousRole = jest.spyOn(coaching, "roleFor").mockResolvedValueOnce({ role: "student", studentId: "student-a", rev: 0 });
  try {
    const retired = await student.get(WORKSHEETS).expect(409);
    expect(retired.body).toEqual({ error: { code: "conflict", message: "The Locker changed. Reload before editing." } });
  } finally { previousRole.mockRestore(); }
  await app("no-role").get(WORKSHEETS).expect(404);
});

test("Classic can submit a worksheet without erasing or exposing coach drafts", async () => {
  const student = app("student-1");
  const before = (await student.get(STATE).expect(200)).body;
  const own = before.state.students[0];
  own.worksheets[0].state = "submitted";
  own.worksheets[0].blocks[0].q = "Ignore the forged question";
  own.worksheets[0].answers = { choice: 0, long: "Classic student answer" };
  own.worksheets[1].answers.long = "Ignore the forged prior answer";
  own.submissions.push(attachment);
  await student.put(STATE).send(before).expect(200);
  const saved = (await coaching.getDoc()).state;
  const expected = fixture();
  expected.students[0].worksheets[1] = { ...sent, state: "submitted", answers: { choice: 0, long: "Classic student answer" },
    submittedAt: saved.students[0].worksheets[1].submittedAt };
  expected.students[0].submissions.push(attachment);
  expect(saved).toEqual(expected);
  expect(JSON.stringify((await student.get(STATE).expect(200)).body)).not.toContain("Unpublished prompt");
});

test("staff draft CAS preserves other state and authoritative student answers and can restore", async () => {
  const coach = app("coach-1");
  const before = (await coach.get(WORKSHEETS).expect(200)).body;
  const request = structuredClone(before);
  request.state.students[0].focus.title = "Ignore forged focus";
  request.state.students[0].worksheets[0].blocks[0].q = "Updated private draft";
  request.state.students[0].worksheets[0].answers = { long: "Do not invent answers" };
  request.state.students[0].worksheets[1].blocks[0].q = "Ignore changes to sent prompts";
  request.state.students[0].worksheets[2].answers.long = "Ignore forged answer";
  request.state.students.push({ id: "student-b", worksheets: [] });
  const concurrent = await Promise.all([coach.put(WORKSHEETS).send(request), coach.put(WORKSHEETS).send(request)]);
  expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
  const expected = structuredClone(fixture());
  expected.students[0].worksheets[0].blocks[0].q = "Updated private draft";
  expect((await coaching.getDoc()).state).toEqual(expected);
  await coach.put(WORKSHEETS).send({ rev: 2, state: before.state }).expect(200);
  expect((await coaching.getDoc()).state).toEqual(fixture());
});

test("restoring a deleted draft preserves its position and authored extension data", async () => {
  const coach = app("coach-1");
  const baseline = fixture();
  baseline.students[0].worksheets.splice(0, 2, sent, { ...draft, futureWorksheetField: ["keep"] });
  await db.coaching.updateOne({ _id: "locker" }, { $set: { state: baseline } });
  const snapshot = (await coach.get(WORKSHEETS).expect(200)).body;
  const removed = structuredClone(snapshot.state);
  removed.students[0].worksheets.splice(1, 1);
  await coach.put(WORKSHEETS).send({ rev: 1, state: removed }).expect(200);
  await coach.put(WORKSHEETS).send({ rev: 2, state: snapshot.state }).expect(200);
  expect((await coaching.getDoc()).state).toEqual(baseline);
});

test("student submits and restores only the addressed worksheet answers and new attachments", async () => {
  const student = app("student-1");
  const before = (await student.get(WORKSHEETS).expect(200)).body;
  const attempted = structuredClone(before);
  const own = attempted.state.students[0];
  const target = own.worksheets[0];
  target.state = "submitted";
  target.title = "Ignore a forged prompt title";
  target.blocks[0].q = "Ignore a forged prompt";
  target.answers = { choice: 0, long: "Saw the Nexus", replay: { count: 1 }, extra: "Ignore hidden data" };
  own.focus = { title: "Ignore a forged focus" };
  own.worksheets.push({ ...draft, state: "submitted" });
  own.worksheets[1].answers.long = "Ignore forged past answer";
  own.submissions.push({ ...attachment, size: 4 });
  await student.put(WORKSHEETS).send(attempted).expect(403);
  own.submissions[1] = attachment;
  await student.put(WORKSHEETS).send(attempted).expect(200);
  const saved = (await coaching.getDoc()).state;
  const expected = structuredClone(fixture());
  expected.students[0].worksheets[1] = { ...sent, state: "submitted", answers: { choice: 0, long: "Saw the Nexus", replay: { count: 1 } },
    submittedAt: saved.students[0].worksheets[1].submittedAt };
  expected.students[0].submissions.push(attachment);
  expect(saved).toEqual(expected);
  await student.put(WORKSHEETS).send({ rev: 2, state: before.state }).expect(200);
  expect((await coaching.getDoc()).state).toEqual(fixture());
});
