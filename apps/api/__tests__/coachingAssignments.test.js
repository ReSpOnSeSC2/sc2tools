// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { CoachingService } = require("../src/services/coaching");
const { buildCoachingRouter } = require("../src/routes/coaching");

describe("coaching game assignments", () => {
  let mongo;
  let client;
  let db;
  let service;
  let emitted;

  const coachRole = { role: "coach", coachId: "coach-1" };
  const otherCoachRole = { role: "coach", coachId: "coach-2" };
  const studentRole = { role: "student", studentId: "student-1" };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    const raw = client.db("coaching_assignments_test");
    db = {
      coaching: raw.collection("coaching_locker"),
      users: raw.collection("users"),
      games: raw.collection("games"),
      devicePairings: raw.collection("device_pairings"),
      deviceTokens: raw.collection("device_tokens"),
    };
    await db.coaching.createIndex(
      { kind: 1, coachId: 1, clientRequestId: 1 },
      {
        unique: true,
        partialFilterExpression: {
          kind: "game_requirement",
          clientRequestId: { $type: "string" },
        },
      },
    );
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all(Object.values(db).map((collection) => collection.deleteMany({})));
    await db.users.insertMany([
      { userId: "coach-user" },
      { userId: "other-coach-user" },
      { userId: "student-user-1" },
      { userId: "student-user-2" },
      { userId: "replacement-coach-user" },
      { userId: "replacement-student-user" },
    ]);
    await db.coaching.insertOne({
      _id: "locker",
      rev: 1,
      state: {
        setup: true,
        coaches: [
          { id: "coach-1", name: "Response", userId: "coach-user" },
          { id: "coach-2", name: "Other", userId: "other-coach-user" },
        ],
        students: [
          {
            id: "student-1",
            name: "Alex",
            userId: "student-user-1",
            coachId: "coach-1",
            practiceSharing: {
              version: 1,
              policyVersion: "practice-replays-v1",
              status: "accepted",
              studentUserId: "student-user-1",
              coachUserId: "coach-user",
              requestedAt: new Date("2026-09-01T12:00:00.000Z"),
              respondedAt: new Date("2026-09-01T13:00:00.000Z"),
              revokedAt: null,
              grantId: "grant-student-1",
            },
          },
          {
            id: "student-2",
            name: "Blair",
            userId: "student-user-2",
            coachId: "coach-2",
            practiceSharing: {
              version: 1,
              policyVersion: "practice-replays-v1",
              status: "accepted",
              studentUserId: "student-user-2",
              coachUserId: "other-coach-user",
              requestedAt: new Date("2026-09-01T12:00:00.000Z"),
              respondedAt: new Date("2026-09-01T13:00:00.000Z"),
              revokedAt: null,
              grantId: "grant-student-2",
            },
          },
        ],
      },
    });
    emitted = [];
    service = new CoachingService({
      db,
      now: () => new Date("2026-09-04T16:00:00.000Z"),
      io: {
        to(room) {
          return { emit: (event, payload) => emitted.push({ room, event, payload }) };
        },
      },
    });
  });

  function definition(overrides = {}) {
    return {
      clientRequestId: "req-assignment-0001",
      type: "build",
      requiredGames: 2,
      build: { id: "pvp-blink", name: "PvP - Blink", matchBy: "name" },
      recurrence: "daily",
      timeZone: "America/New_York",
      startsOn: "2026-09-01",
      endsOn: "2026-09-07",
      title: "Blink reps",
      note: "Keep the first observer alive.",
      ...overrides,
    };
  }

  async function game(gameId, fields = {}) {
    await db.games.insertOne({
      userId: "student-user-1",
      gameId,
      date: new Date("2026-09-04T13:00:00.000Z"),
      map: "Site Delta LE",
      opponent: { displayName: "PracticePartner" },
      result: "Victory",
      myBuild: "PvP - Blink",
      matchFormat: "1v1",
      playerCount: 2,
      isLadderGame: true,
      ...fields,
    });
  }

  async function assignmentDoc(id, createdAt = "2026-09-01T04:00:00.000Z") {
    await db.coaching.updateOne(
      { _id: `assignment:${id}` },
      { $set: { createdAt: new Date(createdAt) } },
    );
    return db.coaching.findOne({ _id: `assignment:${id}` });
  }

  test("requires explicit account-bound student consent and enforces revocation immediately", async () => {
    await db.coaching.updateOne(
      { _id: "locker" },
      { $unset: { "state.students.0.practiceSharing": "" } },
    );

    await expect(service.practiceSharingFor("student-user-1", studentRole))
      .resolves.toMatchObject({
        rev: 1,
        relationships: [{ status: "pending", coach: { id: "coach-1" } }],
      });
    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    )).rejects.toMatchObject({
      status: 409,
      code: "practice_sharing_consent_required",
    });
    await expect(service.listAssignments("coach-user", coachRole)).resolves.toEqual([]);

    const accepted = await service.respondPracticeSharing(
      "student-user-1",
      studentRole,
      { expectedRev: 1, coachId: "coach-1", decision: "accepted" },
    );
    expect(accepted).toMatchObject({ rev: 2, relationship: { status: "accepted" } });

    await game("consented-replay", { replayFile: { storedAt: new Date() } });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    await assignmentDoc(created.id);
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "consented-replay",
    )).resolves.toEqual({ userId: "student-user-1", gameId: "consented-replay" });

    const revoked = await service.revokePracticeSharing(
      "student-user-1",
      studentRole,
      { expectedRev: 2, coachId: "coach-1" },
    );
    expect(revoked).toMatchObject({ rev: 3, relationship: { status: "revoked" } });
    await expect(service.listAssignments("coach-user", coachRole)).resolves.toEqual([]);
    await expect(service.listAssignments("student-user-1", studentRole))
      .resolves.toEqual([expect.objectContaining({ id: created.id })]);
    await expect(service.assignmentGames(
      "coach-user",
      coachRole,
      created.id,
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "consented-replay",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
    await expect(service.assignmentReplayOwner(
      "student-user-1",
      studentRole,
      created.id,
      "consented-replay",
    )).resolves.toEqual({ userId: "student-user-1", gameId: "consented-replay" });

    const pendingAgain = await service.requestPracticeSharing(
      "coach-user",
      coachRole,
      "student-1",
      { expectedRev: 3 },
    );
    expect(pendingAgain).toMatchObject({ rev: 4, relationship: { status: "pending" } });
    const rejected = await service.respondPracticeSharing(
      "student-user-1",
      studentRole,
      { expectedRev: 4, coachId: "coach-1", decision: "rejected" },
    );
    expect(rejected).toMatchObject({ rev: 5, relationship: { status: "rejected" } });
    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ clientRequestId: "req-after-rejection" }),
    )).rejects.toMatchObject({ code: "practice_sharing_consent_required" });

    const requestedAfterRejection = await service.requestPracticeSharing(
      "coach-user",
      coachRole,
      "student-1",
      { expectedRev: 5 },
    );
    expect(requestedAfterRejection).toMatchObject({
      rev: 6,
      relationship: { status: "pending" },
    });
    await service.respondPracticeSharing(
      "student-user-1",
      studentRole,
      { expectedRev: 6, coachId: "coach-1", decision: "accepted" },
    );
    // A fresh acceptance is a fresh grant. Revoked assignments cannot wake
    // back up and retroactively collect games from the revoked interval.
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "consented-replay",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
    const replacement = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ clientRequestId: "req-after-new-grant" }),
    );
    expect(replacement.id).not.toBe(created.id);
  });

  test("does not allow Locker state writes to forge consent or carry it across account changes", async () => {
    const current = await service.getDoc();
    const forged = structuredClone(current.state);
    forged.students[0].practiceSharing.status = "revoked";
    await expect(service.putStateWithRosterGuard(forged, current.rev))
      .resolves.toMatchObject({ ok: true, rev: 2 });
    let stored = await service.getDoc();
    expect(stored.state.students[0].practiceSharing.status).toBe("accepted");

    const relinked = structuredClone(stored.state);
    relinked.coaches[0].userId = "replacement-coach-user";
    await expect(service.putStateWithRosterGuard(relinked, stored.rev))
      .resolves.toMatchObject({ ok: true, rev: 3 });
    stored = await service.getDoc();
    expect(stored.state.students[0].practiceSharing).toMatchObject({
      status: "pending",
      studentUserId: "student-user-1",
      coachUserId: "replacement-coach-user",
    });
  });

  test("blocks assignment and Locker writes involving an account under deletion", async () => {
    await db.users.updateOne(
      { userId: "student-user-1" },
      { $set: { _gdprMutation: {
        id: "deleting-student",
        leaseUntil: new Date("2099-01-01T00:00:00.000Z"),
      } } },
    );
    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    )).rejects.toMatchObject({
      status: 409,
      code: "account_deletion_in_progress",
    });
    expect(await db.coaching.countDocuments({ kind: "game_requirement" })).toBe(0);

    await db.users.updateOne(
      { userId: "student-user-1" },
      { $unset: { _gdprMutation: "" } },
    );
    await db.users.updateOne(
      { userId: "coach-user" },
      { $set: { _gdprMutation: {
        id: "deleting-coach",
        leaseUntil: new Date("2099-01-01T00:00:00.000Z"),
      } } },
    );
    const current = await service.getDoc();
    const edited = structuredClone(current.state);
    edited.coaches[0].name = "Must not persist";
    await expect(service.putStateWithRosterGuard(
      edited,
      current.rev,
      ["coach-user"],
    )).rejects.toMatchObject({
      status: 409,
      code: "account_deletion_in_progress",
    });
    expect((await service.getDoc()).state.coaches[0].name).toBe("Response");
    expect(await db.users.countDocuments({ "_coachingMutations.0": { $exists: true } }))
      .toBe(0);

    await db.users.updateOne(
      { userId: "coach-user" },
      { $unset: { _gdprMutation: "" } },
    );
    await db.users.updateOne(
      { userId: "student-user-1" },
      { $set: { _gdprMutation: {
        id: "deleting-prospective-member",
        leaseUntil: new Date("2099-01-01T00:00:00.000Z"),
      } } },
    );
    const latest = await service.getDoc();
    const relinked = structuredClone(latest.state);
    relinked.coaches[1].userId = "student-user-1";
    await expect(service.putStateWithRosterGuard(
      relinked,
      latest.rev,
      ["coach-user"],
    )).rejects.toMatchObject({ code: "account_deletion_in_progress" });
    expect((await service.getDoc()).state.coaches[1].userId).toBe("other-coach-user");
  });

  test("reclaims an expired GDPR fence before a coaching write", async () => {
    await db.users.updateOne(
      { userId: "student-user-1" },
      { $set: { _gdprMutation: {
        id: "crashed-deletion",
        leaseUntil: new Date("2020-01-01T00:00:00.000Z"),
      } } },
    );

    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    )).resolves.toMatchObject({ student: { id: "student-1" } });
    const studentUser = await db.users.findOne({ userId: "student-user-1" });
    expect(studentUser).not.toHaveProperty("_gdprMutation");
    expect(studentUser._coachingMutations).toEqual([]);
  });

  test("requires an exact coach account id on every assignment", async () => {
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    await db.coaching.updateOne(
      { _id: `assignment:${created.id}` },
      { $set: { coachUserId: null } },
    );
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "anything",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
    await expect(service.listAssignments("coach-user", coachRole)).resolves.toEqual([]);
  });

  test("keeps consent account bindings and grant ids out of scoped Locker state", async () => {
    const router = buildCoachingRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "student-user-1", source: "clerk" };
        next();
      },
      isAdmin: () => false,
      coaching: service,
      aggregations: {},
      users: { getSummary: jest.fn() },
    });
    const app = express();
    app.use(express.json());
    app.use("/v1", router);

    const response = await request(app).get("/v1/coaching/state").expect(200);
    expect(response.body.state.students[0].practiceSharing).toMatchObject({
      status: "accepted",
    });
    expect(response.body.state.students[0].practiceSharing).not.toHaveProperty("studentUserId");
    expect(response.body.state.students[0].practiceSharing).not.toHaveProperty("coachUserId");
    expect(response.body.state.students[0].practiceSharing).not.toHaveProperty("grantId");
  });

  test("tracks only exact-build 1v1 ladder/custom games and exposes archived replay metadata", async () => {
    await game("ladder", { replayFile: { storedAt: new Date(), sizeBytes: 99 } });
    await game("custom", { isLadderGame: false, date: new Date("2026-09-04T14:00:00.000Z") });
    await game("legacy-1v1", {
      playerCount: 2,
      date: new Date("2026-09-04T15:00:00.000Z"),
    });
    await db.games.updateOne({ gameId: "legacy-1v1" }, { $unset: { matchFormat: "" } });
    await game("wrong-build", { myBuild: "PvP - Stargate" });
    await game("team", { matchFormat: "team", playerCount: 4 });
    await game("ffa", { matchFormat: "ffa", playerCount: 2 });
    await game("resumed", { isResumedFromReplay: true });
    await game("outside", { date: new Date("2026-09-08T04:00:00.000Z") });

    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    const stored = await assignmentDoc(created.id);
    const progress = await service._assignmentProgress(
      stored,
      new Date("2026-09-04T16:00:00.000Z"),
    );

    expect(progress.playedGames).toBe(3);
    expect(progress.currentBucket).toMatchObject({
      key: "2026-09-04",
      playedGames: 3,
      requiredGames: 2,
      remainingGames: 0,
      complete: true,
    });
    expect(progress.games.map((item) => item.gameId).sort())
      .toEqual(["custom", "ladder", "legacy-1v1"]);
    expect(progress.games.find((item) => item.gameId === "custom"))
      .toMatchObject({ isLadderGame: false, matchFormat: "1v1" });
    expect(progress.games.find((item) => item.gameId === "ladder"))
      .toMatchObject({
        replayAvailable: true,
        replayDownloadPath: `/v1/coaching/assignments/${created.id}/games/ladder/replay-download`,
      });
    expect(emitted).toEqual([{
      room: "user:student-user-1",
      event: "coaching:assignment",
      payload: expect.objectContaining({ kind: "assigned", assignmentId: created.id }),
    }]);
  });

  test("offers build suggestions only from eligible 1v1 games", async () => {
    await game("eligible", { myBuild: "PvP - Blink" });
    await game("legacy", { myBuild: "PvP - Robo", playerCount: 2 });
    await db.games.updateOne({ gameId: "legacy" }, { $unset: { matchFormat: "" } });
    await game("team", {
      myBuild: "PvP - Team Only",
      matchFormat: "team",
      playerCount: 4,
    });
    await game("ffa", {
      myBuild: "PvP - FFA Only",
      matchFormat: "ffa",
      playerCount: 2,
    });
    await game("resumed", {
      myBuild: "PvP - Resumed Only",
      isResumedFromReplay: true,
    });

    const suggestions = await service.gamesFor("student-user-1");

    expect(suggestions.map((item) => item.b).sort()).toEqual([
      "PvP - Blink",
      "PvP - Robo",
    ]);
  });

  test("uses exactly one declared build identity instead of unioning name and slug", async () => {
    await game("name-match", {
      myBuild: "PvP - Blink",
      _customBuildSlug: "another-build",
    });
    await game("slug-match", {
      myBuild: "A renamed custom build",
      _customBuildSlug: "pvp-blink",
    });

    const byName = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ clientRequestId: "req-name-matcher-01" }),
    );
    const nameDoc = await assignmentDoc(byName.id);
    await expect(service._assignmentProgress(
      nameDoc,
      new Date("2026-09-04T16:00:00.000Z"),
    )).resolves.toMatchObject({
      playedGames: 1,
      replayGames: [expect.objectContaining({ gameId: "name-match" })],
    });

    const bySlug = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-slug-matcher-01",
        build: { id: "pvp-blink", name: "PvP - Blink", matchBy: "slug" },
      }),
    );
    const slugDoc = await assignmentDoc(bySlug.id);
    await expect(service._assignmentProgress(
      slugDoc,
      new Date("2026-09-04T16:00:00.000Z"),
    )).resolves.toMatchObject({
      playedGames: 1,
      replayGames: [expect.objectContaining({ gameId: "slug-match" })],
    });
  });

  test("uses inclusive local dates and DST-safe exclusive UTC boundaries", async () => {
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-dst-window-0001",
        type: "total",
        build: undefined,
        recurrence: "once",
        startsOn: "2027-03-14",
        endsOn: "2027-03-14",
      }),
    );

    expect(created.requirement).toMatchObject({
      type: "total",
      build: null,
      window: {
        startsOn: "2027-03-14",
        endsOn: "2027-03-14",
        startsAt: "2027-03-14T05:00:00.000Z",
        endsAt: "2027-03-15T04:00:00.000Z",
        endExclusive: true,
      },
    });
  });

  test("canonicalizes timezone aliases before using them in Mongo recurrence grouping", async () => {
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-canonical-zone-01",
        type: "total",
        build: undefined,
        recurrence: "daily",
        timeZone: "america/new_york",
      }),
    );

    expect(created.requirement.timeZone).toBe("America/New_York");
    expect(Array.isArray(created.progress.buckets)).toBe(true);
  });

  test("handles calendar days whose IANA zone skips local midnight", async () => {
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-midnight-dst-01",
        type: "total",
        build: undefined,
        recurrence: "daily",
        timeZone: "America/Santiago",
        startsOn: "2026-09-05",
        endsOn: "2026-09-07",
      }),
    );

    const stored = await assignmentDoc(created.id, "2026-09-05T04:00:00.000Z");
    const progress = await service._assignmentProgress(
      stored,
      new Date("2026-09-06T12:00:00.000Z"),
    );
    expect(progress.buckets).toHaveLength(3);
    expect(progress.buckets.map((bucket) => bucket.key)).toEqual([
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
    ]);
  });

  test("counts only games played after the coach creates the assignment", async () => {
    const beforeCreate = new Date("2026-09-04T15:59:00.000Z");
    const startsOn = "2026-09-03";
    const endsOn = "2026-09-05";
    await game("historical", { date: beforeCreate });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-no-retro-credit",
        type: "total",
        build: undefined,
        recurrence: "once",
        timeZone: "UTC",
        startsOn,
        endsOn,
      }),
    );
    const stored = await db.coaching.findOne({ _id: `assignment:${created.id}` });
    const afterCreate = new Date(stored.createdAt.getTime() + 60_000);
    await game("new-practice", { date: afterCreate });

    const progress = await service._assignmentProgress(
      stored,
      new Date(afterCreate.getTime() + 60_000),
    );
    expect(progress.playedGames).toBe(1);
    expect(progress.replayGames.map((item) => item.gameId)).toEqual(["new-practice"]);
  });

  test("does not count a game that was already underway when the plan was assigned", async () => {
    await game("already-underway", {
      startedAt: "2026-09-04T15:55:00.000Z",
      date: new Date("2026-09-04T16:05:00.000Z"),
      durationSec: 600,
    });
    await game("started-after-assignment", {
      startedAt: "2026-09-04T16:01:00.000Z",
      date: new Date("2026-09-04T16:11:00.000Z"),
      durationSec: 600,
    });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ type: "total", build: undefined }),
    );
    const stored = await db.coaching.findOne({ _id: `assignment:${created.id}` });

    const progress = await service._assignmentProgress(
      stored,
      new Date("2026-09-04T17:00:00.000Z"),
    );

    expect(progress.playedGames).toBe(1);
    expect(progress.replayGames.map((item) => item.gameId))
      .toEqual(["started-after-assignment"]);
  });

  test("attributes cross-midnight games to their start day with a legacy duration fallback", async () => {
    await game("exact-cross-midnight", {
      startedAt: "2026-09-04T23:58:00.000Z",
      date: new Date("2026-09-05T00:08:00.000Z"),
      durationSec: 600,
    });
    await game("legacy-cross-midnight", {
      date: new Date("2026-09-05T00:05:00.000Z"),
      durationSec: 600,
    });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-cross-midnight",
        type: "total",
        build: undefined,
        requiredGames: 2,
        timeZone: "UTC",
      }),
    );
    const stored = await db.coaching.findOne({ _id: `assignment:${created.id}` });

    const progress = await service._assignmentProgress(
      stored,
      new Date("2026-09-05T02:00:00.000Z"),
    );

    expect(progress.buckets.find((bucket) => bucket.key === "2026-09-04"))
      .toMatchObject({ playedGames: 2, complete: true });
    expect(progress.buckets.find((bucket) => bucket.key === "2026-09-05"))
      .toMatchObject({ playedGames: 0, complete: false });
    expect(progress.replayGames.map((item) => item.date).sort()).toEqual([
      "2026-09-04T23:55:00.000Z",
      "2026-09-04T23:58:00.000Z",
    ]);
  });

  test("counts total-game weekly recurrence in clipped local-calendar buckets", async () => {
    await game("week-one-a", { date: new Date("2026-09-01T13:00:00.000Z") });
    await game("week-one-b", {
      date: new Date("2026-09-02T13:00:00.000Z"),
      isLadderGame: false,
      myBuild: "A different build",
    });
    await game("week-two", {
      date: new Date("2026-09-07T13:00:00.000Z"),
      myBuild: "A different build",
    });
    await game("week-three", { date: new Date("2026-09-14T13:00:00.000Z") });
    await game("team-does-not-count", {
      date: new Date("2026-09-08T13:00:00.000Z"),
      matchFormat: "team",
      playerCount: 4,
    });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-weekly-total-01",
        type: "total",
        build: undefined,
        recurrence: "weekly",
        startsOn: "2026-09-01",
        endsOn: "2026-09-15",
      }),
    );
    const stored = await assignmentDoc(created.id);
    const progress = await service._assignmentProgress(
      stored,
      new Date("2026-09-08T16:00:00.000Z"),
    );

    expect(progress.playedGames).toBe(4);
    expect(progress.buckets).toEqual([
      expect.objectContaining({ key: "2026-08-31", playedGames: 2, complete: true }),
      expect.objectContaining({ key: "2026-09-07", playedGames: 1, complete: false }),
      expect.objectContaining({ key: "2026-09-14", playedGames: 1, complete: false }),
    ]);
    expect(progress.currentBucket.key).toBe("2026-09-07");
    expect(progress.games.map((item) => item.gameId)).toEqual(["week-two"]);
  });

  test("makes create idempotent and updates/cancels with revision CAS", async () => {
    const first = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    const retry = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    expect(retry.id).toBe(first.id);
    await expect(db.coaching.countDocuments({ kind: "game_requirement" }))
      .resolves.toBe(1);
    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ requiredGames: 99 }),
    )).rejects.toMatchObject({
      status: 409,
      code: "assignment_request_conflict",
    });

    await expect(service.replaceAssignment(
      "coach-user",
      coachRole,
      first.id,
      { expectedRev: 2, status: "cancelled" },
    )).rejects.toMatchObject({ status: 409, code: "assignment_conflict" });

    const cancelled = await service.replaceAssignment(
      "coach-user",
      coachRole,
      first.id,
      { expectedRev: 1, status: "cancelled" },
    );
    expect(cancelled).toMatchObject({ rev: 2, status: "cancelled" });
    expect(cancelled.progress.state).toBe("cancelled");
    await expect(service.replaceAssignment(
      "coach-user",
      coachRole,
      first.id,
      { expectedRev: 2, status: "cancelled" },
    )).rejects.toMatchObject({ status: 409, code: "assignment_cancelled" });
  });

  test("pages assignment history without silently hiding older plans", async () => {
    for (let index = 1; index <= 3; index += 1) {
      await service.createAssignment(
        "coach-user",
        coachRole,
        "student-1",
        definition({ clientRequestId: `req-page-${index}` }),
      );
    }

    await expect(service.listAssignments(
      "coach-user",
      coachRole,
      { studentId: "student-1", page: 1, limit: 2, paginated: true },
    )).resolves.toMatchObject({
      page: 1,
      limit: 2,
      hasMore: true,
      assignments: expect.arrayContaining([
        expect.objectContaining({ student: { id: "student-1", name: "Alex" } }),
      ]),
    });
    const secondPage = await service.listAssignments(
      "coach-user",
      coachRole,
      { studentId: "student-1", page: 2, limit: 2, paginated: true },
    );
    expect(secondPage).toMatchObject({ page: 2, limit: 2, hasMore: false });
    expect(secondPage.assignments).toHaveLength(1);
  });

  test("rejects already-ended windows and cannot cancel a completed one-time target", async () => {
    await expect(service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-ended-window-01",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
      }),
    )).rejects.toMatchObject({ status: 400, code: "invalid_assignment_window" });

    await game("completed-target");
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({
        clientRequestId: "req-completed-window-01",
        requiredGames: 1,
        recurrence: "once",
      }),
    );
    await assignmentDoc(created.id);

    await expect(service.replaceAssignment(
      "coach-user",
      coachRole,
      created.id,
      { expectedRev: 1, status: "cancelled" },
    )).rejects.toMatchObject({ status: 409, code: "assignment_not_cancellable" });
  });

  test("freezes counted games and replay evidence at the first cancellation time", async () => {
    const now = new Date("2026-09-04T16:00:00.000Z");
    const startsOn = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const endsOn = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    const input = definition({
      clientRequestId: "req-cancel-freeze-01",
      type: "total",
      build: undefined,
      recurrence: "daily",
      timeZone: "UTC",
      startsOn,
      endsOn,
    });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      input,
    );
    await service.replaceAssignment(
      "coach-user",
      coachRole,
      created.id,
      { ...input, expectedRev: 1, status: "cancelled" },
    );
    const cancelled = await db.coaching.findOne({ _id: `assignment:${created.id}` });
    const stored = await assignmentDoc(
      created.id,
      new Date(cancelled.cancelledAt.getTime() - 3_600_000).toISOString(),
    );
    const cancelledAt = stored.cancelledAt.getTime();
    await game("before-cancel", { date: new Date(cancelledAt - 60_000) });
    await game("after-cancel", { date: new Date(cancelledAt + 60_000) });

    const progress = await service._assignmentProgress(
      stored,
      new Date(cancelledAt + 3_600_000),
    );

    expect(progress.state).toBe("cancelled");
    expect(progress.playedGames).toBe(1);
    expect(progress.totalBuckets).toBe(1);
    expect(progress.requiredGamesTotal).toBe(input.requiredGames);
    expect(progress.replayGames.map((item) => item.gameId)).toEqual(["before-cancel"]);
  });

  test("does not transfer historical assignment access when roster ids are relinked", async () => {
    await game("eligible", { replayFile: { storedAt: new Date() } });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition({ clientRequestId: "req-identity-binding" }),
    );

    await db.coaching.updateOne(
      { _id: "locker" },
      { $set: { "state.students.0.userId": "replacement-student-user" } },
    );
    await expect(service.listAssignments(
      "replacement-student-user",
      studentRole,
    )).resolves.toEqual([]);
    await expect(service.assignmentReplayOwner(
      "replacement-student-user",
      studentRole,
      created.id,
      "eligible",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
    await expect(service.listAssignments("coach-user", coachRole)).resolves.toEqual([]);

    await db.coaching.updateOne(
      { _id: "locker" },
      {
        $set: {
          "state.students.0.userId": "student-user-1",
          "state.coaches.0.userId": "replacement-coach-user",
        },
      },
    );
    await expect(service.listAssignments(
      "replacement-coach-user",
      coachRole,
    )).resolves.toEqual([]);
    await expect(service.assignmentReplayOwner(
      "replacement-coach-user",
      coachRole,
      created.id,
      "eligible",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });
  });

  test("enforces current roster scope and assignment-specific replay access", async () => {
    await game("eligible", { replayFile: { storedAt: new Date() } });
    await game("team", { matchFormat: "team", playerCount: 4, replayFile: { storedAt: new Date() } });
    const created = await service.createAssignment(
      "coach-user",
      coachRole,
      "student-1",
      definition(),
    );
    await assignmentDoc(created.id);

    await expect(service.createAssignment(
      "student-user-1",
      studentRole,
      "student-1",
      definition({ clientRequestId: "req-student-denied" }),
    )).rejects.toMatchObject({ status: 404 });
    await expect(service.createAssignment(
      "other-coach-user",
      otherCoachRole,
      "student-1",
      definition({ clientRequestId: "req-other-denied" }),
    )).rejects.toMatchObject({ status: 404, code: "student_not_found" });
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "eligible",
    )).resolves.toEqual({ userId: "student-user-1", gameId: "eligible" });
    await expect(service.assignmentReplayOwner(
      "student-user-1",
      studentRole,
      created.id,
      "eligible",
    )).resolves.toEqual({ userId: "student-user-1", gameId: "eligible" });
    await expect(service.assignmentReplayOwner(
      "coach-user",
      coachRole,
      created.id,
      "team",
    )).rejects.toMatchObject({ status: 404, code: "replay_not_found" });
    await expect(service.assignmentReplayOwner(
      "other-coach-user",
      otherCoachRole,
      created.id,
      "eligible",
    )).rejects.toMatchObject({ status: 404, code: "assignment_not_found" });

    await db.coaching.updateOne(
      { _id: "locker" },
      { $set: { "state.students.0.coachId": "coach-2" } },
    );
    await expect(service.listAssignments("coach-user", coachRole))
      .resolves.toEqual([]);
  });

  test("requires live student approval for a coach's build-suggestion game list", async () => {
    await db.games.insertOne({
      userId: "student-user-2",
      gameId: "student-two-game",
      date: new Date("2026-09-04T13:00:00.000Z"),
      map: "Site Delta LE",
      opponent: { displayName: "PracticePartner" },
      result: "Victory",
      myBuild: "PvP - Blink",
      matchFormat: "1v1",
      playerCount: 2,
      isLadderGame: true,
    });
    const router = buildCoachingRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "other-coach-user", source: "clerk" };
        next();
      },
      isAdmin: () => false,
      coaching: service,
      aggregations: {},
      users: {},
    });
    const app = express();
    app.use(express.json());
    app.use("/v1", router);
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: error.code || "internal_error" });
    });

    const accepted = await request(app)
      .get("/v1/coaching/students/student-user-2/games")
      .expect(200);
    expect(accepted.headers["cache-control"]).toContain("no-store");
    expect(accepted.body.games).toEqual([
      expect.objectContaining({ b: "PvP - Blink" }),
    ]);

    await db.coaching.updateOne(
      { _id: "locker" },
      {
        $set: { "state.students.1.practiceSharing.status": "revoked" },
        $unset: { "state.students.1.practiceSharing.grantId": "" },
      },
    );
    await request(app)
      .get("/v1/coaching/students/student-user-2/games")
      .expect(404, { error: "not_found" });
  });

  test("wires scoped list/create/update/download routes and delegates signed URLs", async () => {
    const assignment = {
      id: "a-1",
      rev: 1,
      status: "active",
      requirement: {},
      progress: {},
    };
    const coaching = {
      roleFor: jest.fn(async () => coachRole),
      practiceSharingFor: jest.fn(async () => ({
        rev: 7,
        relationships: [{ student: { id: "student-1" }, status: "pending" }],
      })),
      requestPracticeSharing: jest.fn(async () => ({
        rev: 8,
        relationship: { student: { id: "student-1" }, status: "pending" },
      })),
      respondPracticeSharing: jest.fn(async () => ({
        rev: 9,
        relationship: { student: { id: "student-1" }, status: "accepted" },
      })),
      revokePracticeSharing: jest.fn(async () => ({
        rev: 10,
        relationship: { student: { id: "student-1" }, status: "revoked" },
      })),
      listAssignments: jest.fn(async () => [assignment]),
      createAssignment: jest.fn(async () => assignment),
      replaceAssignment: jest.fn(async () => ({ ...assignment, rev: 2 })),
      assignmentGames: jest.fn(async () => ({
        assignmentId: "a-1",
        page: 1,
        limit: 25,
        total: 1,
        hasMore: false,
        games: [{ gameId: "g-1" }],
      })),
      assignmentReplayOwner: jest.fn(async () => ({
        userId: "student-user-1",
        gameId: "g-1",
      })),
    };
    const replayFiles = {
      prepareDownload: jest.fn(async () => ({
        url: "https://signed.invalid/replay",
        filename: "practice.SC2Replay",
        expiresIn: 60,
      })),
    };
    const router = buildCoachingRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "coach-user", source: "clerk" };
        next();
      },
      isAdmin: () => false,
      coaching,
      replayFiles,
      aggregations: {},
      users: {},
    });
    const app = express();
    app.use(express.json());
    app.use("/v1", router);
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({
        error: { code: error.code || "internal_error", message: error.message },
      });
    });

    await request(app)
      .get("/v1/coaching/practice-sharing")
      .expect(200, {
        rev: 7,
        relationships: [{ student: { id: "student-1" }, status: "pending" }],
      });
    await request(app)
      .post("/v1/coaching/students/student-1/practice-sharing/request")
      .send({ expectedRev: 7 })
      .expect(200)
      .expect(() => {
        expect(coaching.requestPracticeSharing)
          .toHaveBeenCalledWith("coach-user", coachRole, "student-1", { expectedRev: 7 });
      });
    await request(app)
      .post("/v1/coaching/practice-sharing/respond")
      .send({ expectedRev: 8, coachId: "coach-1", decision: "accepted" })
      .expect(200);
    await request(app)
      .post("/v1/coaching/practice-sharing/revoke")
      .send({ expectedRev: 9, coachId: "coach-1" })
      .expect(200);
    await request(app)
      .get("/v1/coaching/assignments?studentId=student-1")
      .expect(200)
      .expect((response) => {
        expect(response.body.assignments).toEqual([assignment]);
        expect(response.body).toMatchObject({ page: 1, limit: 20, hasMore: false });
        expect(response.body.serverTime).toMatch(/Z$/);
      });
    expect(coaching.listAssignments).toHaveBeenCalledWith(
      "coach-user",
      coachRole,
      expect.objectContaining({
        studentId: "student-1",
        paginated: true,
      }),
    );
    await request(app)
      .post("/v1/coaching/students/student-1/assignments")
      .send(definition())
      .expect(201, { assignment });
    await request(app)
      .put("/v1/coaching/assignments/a-1")
      .send({ expectedRev: 1, status: "cancelled" })
      .expect(200)
      .expect((response) => expect(response.body.assignment.rev).toBe(2));
    await request(app)
      .get("/v1/coaching/assignments/a-1/games?page=1&limit=25")
      .expect(200, {
        assignmentId: "a-1",
        page: 1,
        limit: 25,
        total: 1,
        hasMore: false,
        games: [{ gameId: "g-1" }],
      });
    await request(app)
      .get("/v1/coaching/assignments/a-1/games/g-1/replay-download")
      .expect(200, {
        url: "https://signed.invalid/replay",
        filename: "practice.SC2Replay",
        expiresIn: 60,
      });
    expect(replayFiles.prepareDownload)
      .toHaveBeenCalledWith("student-user-1", "g-1");
  });
});
