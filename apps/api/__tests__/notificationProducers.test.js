// @ts-nocheck
"use strict";

const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");
const { CoachingService } = require("../src/services/coaching");

describe("event-driven notification producers", () => {
  let h;
  beforeAll(async () => {
    h = await createHarness({ rollout: "off" });
    for (const name of ["ann", "bob", "admin"]) await h.seedUser(name);
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await Promise.all([h.db.notifications, h.db.importJobs, h.db.deviceTokens, h.db.devicePairings, h.db.communityBuilds, h.db.coaching].map((collection) => collection.deleteMany({})));
    await h.db.users.updateMany({}, { $unset: { "preferences.notifications": "" } });
  });
  afterEach(() => jest.restoreAllMocks());

  test("completes each import once with synced wording and ignores scan, stalled and cancelled jobs", async () => {
    const user = h.userId("ann");
    const job = await h.services.imports.start(user, {});
    await h.services.imports.reportProgress(user, job.jobId, { completed: 1243, total: 1243, done: true });
    await h.services.notifications.markRead(user, { all: true });
    await h.services.imports.reportProgress(user, job.jobId, { completed: 1243, total: 1243, done: true });
    const rows = await h.db.notifications.find({ userId: user }).toArray();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: "import.done", count: 1, title: "Import finished: 1,243 games synced" });
    expect(rows[0].readAt).toBeInstanceOf(Date);
    const scan = await h.services.imports.scan(user, {});
    await h.services.imports.reportProgress(user, scan.jobId, { completed: 40, done: true });
    const running = await h.services.imports.start(user, {});
    await h.services.imports.reportProgress(user, running.jobId, { completed: 4, stalled: true });
    await h.services.imports.cancel(user);
    await h.services.imports.reportProgress(user, running.jobId, { completed: 9, done: true });
    expect(await h.db.notifications.countDocuments({ userId: user })).toBe(1);
  });

  test("requires an authenticated device heartbeat and notifies only once per minimum version, even after read", async () => {
    let minimum = "0.20.0";
    jest.spyOn(h.services.agentVersion, "latest").mockImplementation(async () => ({ version: minimum, minSupportedVersion: minimum }));
    const started = await h.services.pairings.start();
    await h.services.pairings.claim(h.userId("ann"), started.code);
    const paired = await h.services.pairings.poll(started.code);
    const heartbeat = (token, version = "0.19.0") => request(h.app).post("/v1/devices/heartbeat").set("authorization", `Bearer ${token}`).send({ version, os: "Windows" });
    await heartbeat("u:ann").expect(403);
    await heartbeat(paired.deviceToken).expect(200);
    await h.services.notifications.markRead(h.userId("ann"), { all: true });
    await heartbeat(paired.deviceToken).expect(200);
    await heartbeat(paired.deviceToken, "0.21.0").expect(200);
    expect(await h.db.notifications.countDocuments({ kind: "agent.update_required" })).toBe(1);
    minimum = "0.22.0";
    await heartbeat(paired.deviceToken, "0.21.0").expect(200);
    expect(await h.db.notifications.countDocuments({ kind: "agent.update_required" })).toBe(2);
    await h.db.users.updateOne({ userId: h.userId("ann") }, { $set: { "preferences.notifications": { muted: ["agent.update_required"] } } });
    minimum = "0.23.0";
    await heartbeat(paired.deviceToken).expect(200);
    expect(await h.db.notifications.countDocuments({ kind: "agent.update_required" })).toBe(2);
  });

  test("groups distinct community upvotes per day and never counts retry, undo, downvote or self-vote twice", async () => {
    await h.db.communityBuilds.insertOne({ slug: "opener", ownerUserId: h.userId("ann"), title: "Blink opener", removed: false, upvotes: [], downvotes: [], votes: 0 });
    const vote = (name, delta) => request(h.app).post("/v1/community/builds/opener/vote").set("authorization", h.bearer(name)).send({ delta });
    await vote("bob", 1).expect(200); await vote("bob", 1).expect(200);
    await vote("bob", 0).expect(200); await vote("bob", -1).expect(200); await vote("bob", 1).expect(200);
    await vote("ann", 1).expect(200); await vote("admin", 1).expect(200);
    const row = await h.db.notifications.findOne({ userId: h.userId("ann"), kind: "community.vote" });
    expect(row).toMatchObject({ count: 2, title: "2 upvotes on Blink opener", href: "/community/builds/opener" });
    await h.services.notifications.markRead(h.userId("ann"), { all: true });
    await vote("bob", 0); await vote("bob", 1);
    expect(await h.db.notifications.countDocuments({ kind: "community.vote" })).toBe(1);
    expect((await h.services.notifications.unreadCount(h.userId("ann"))).count).toBe(0);
  });

  test("persists sharing, assignment and booking notifications from real coaching mutations without a live socket", async () => {
    const coach = h.userId("ann"); const student = h.userId("bob");
    const coachRole = { role: "coach", coachId: "coach-1" }; const studentRole = { role: "student", studentId: "student-1" };
    await h.db.coaching.insertOne({ _id: "locker", rev: 1, state: { setup: true, coaches: [{ id: "coach-1", userId: coach, name: "Coach" }], students: [{ id: "student-1", userId: student, name: "Student", coachId: "coach-1" }] } });
    const service = new CoachingService({ db: h.db, notifications: h.services.notifications });
    const requested = await service.requestPracticeSharing(coach, coachRole, "student-1", { expectedRev: 1 });
    await service.requestPracticeSharing(coach, coachRole, "student-1", { expectedRev: requested.rev });
    const accepted = await service.respondPracticeSharing(student, studentRole, { expectedRev: requested.rev, coachId: "coach-1", decision: "accepted" });
    const today = new Date(); const end = new Date(today.getTime() + 7 * 86400000);
    const definition = { clientRequestId: "assignment_notice_001", type: "total", requiredGames: 2, recurrence: "once", timeZone: "UTC", startsOn: today.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10), title: "Practice games" };
    const assignment = await service.createAssignment(coach, coachRole, "student-1", definition);
    await service.createAssignment(coach, coachRole, "student-1", definition);
    await service.replaceAssignment(coach, coachRole, assignment.id, { expectedRev: 1, status: "cancelled" });
    await service.saveAvailability(coach, coachRole, { expectedRev: 0, timeZone: "UTC", durations: [60], windows: Array.from({ length: 7 }, (_, day) => ({ day, start: "00:00", end: "24:00" })) });
    const calendar = await service.calendarFor(student, studentRole, "UTC");
    const booking = await service.bookSession(student, studentRole, calendar.slots[0]);
    await service.cancelSession(coach, coachRole, booking.booking.id);
    await service.revokePracticeSharing(student, studentRole, { expectedRev: accepted.rev, coachId: "coach-1" });
    const requestedAgain = await service.requestPracticeSharing(coach, coachRole, "student-1", { expectedRev: accepted.rev + 1 });
    await service.respondPracticeSharing(student, studentRole, { expectedRev: requestedAgain.rev, coachId: "coach-1", decision: "rejected" });
    const rows = await h.db.notifications.find({}).toArray();
    expect(rows.filter((row) => row.kind === "coaching.practice_sharing_requested")).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "coaching.practice_sharing_rejected")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "coaching.practice_sharing_accepted")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "coaching.practice_sharing_revoked")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "coaching.assigned")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "coaching.booked")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "coaching.cancelled")).toHaveLength(2);
    expect(rows.every((row) => row.href === "/coaching")).toBe(true);
  });
});
