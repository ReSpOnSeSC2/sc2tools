// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { CoachingService } = require("../src/services/coaching");
const { catalogKeyForName } = require("../src/services/buildIntentShape");
const { buildCoachingRouter } = require("../src/routes/coaching");
const {
  DIGEST_LOOKBACK_DAYS,
  digestWindow,
  previousSession,
  sessionHistory,
} = require("../src/services/coachingSessions");

const NOW = new Date("2026-10-20T12:00:00.000Z");
const at = (iso) => new Date(iso);

function booking(id, studentId, startIso, minutes = 60, extra = {}) {
  const startAt = at(startIso);
  return {
    id,
    studentId,
    studentUserId: studentId === "student-1" ? "student-user-1" : "student-user-2",
    studentName: studentId === "student-1" ? "Alex" : "Blair",
    startAt,
    endAt: new Date(startAt.getTime() + minutes * 60_000),
    durationMinutes: minutes,
    status: "booked",
    createdAt: at("2026-09-01T00:00:00.000Z"),
    updatedAt: at("2026-09-01T00:00:00.000Z"),
    cancelledBy: null,
    ...extra,
  };
}

function sharing(status, respondedAt, userId = "student-user-1") {
  return {
    version: 1,
    policyVersion: "practice-replays-v1",
    status,
    studentUserId: userId,
    coachUserId: "coach-user",
    requestedAt: at("2026-08-31T12:00:00.000Z"),
    respondedAt: at(respondedAt),
    revokedAt: status === "revoked" ? at(respondedAt) : null,
    grantId: status === "accepted" ? `grant-${userId}` : null,
  };
}

/** A synced 1v1 game that STARTED at ``startIso`` and lasted ten minutes. */
function game(gameId, startIso, extra = {}) {
  const startedAt = at(startIso);
  return {
    userId: "student-user-1",
    gameId,
    startedAt,
    date: new Date(startedAt.getTime() + 600_000),
    durationSec: 600,
    matchFormat: "1v1",
    isLadderGame: true,
    map: "Alcyone LE",
    myRace: "Protoss",
    opponent: { race: "Zerg", displayName: "SecretOpponent", mmr: 4100 },
    result: "Victory",
    myBuild: "Blink Stalkers",
    macroScore: 71,
    apm: 180,
    notes: "private note",
    ...extra,
  };
}

function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { out.add(key); keysOf(item, out); }
  }
  return out;
}

describe("session prep digest window", () => {
  const next = booking("next", "student-1", "2026-10-22T18:00:00.000Z");

  test("starts at the latest held session, ignoring cancelled, later and other students' sessions", () => {
    const bookings = [
      booking("held", "student-1", "2026-10-10T18:00:00.000Z"),
      booking("cancelled", "student-1", "2026-10-15T18:00:00.000Z", 60, { status: "cancelled" }),
      booking("other", "student-2", "2026-10-16T18:00:00.000Z"),
      booking("after", "student-1", "2026-10-25T18:00:00.000Z"),
      next,
    ];
    expect(previousSession(bookings, next, NOW).id).toBe("held");
    expect(digestWindow({ bookings, booking: next, sharingStartedAt: at("2026-09-01T00:00:00.000Z"), now: NOW })).toEqual({
      since: at("2026-10-10T19:00:00.000Z"),
      until: NOW,
      basis: "last_session",
      lastSession: { startAt: "2026-10-10T18:00:00.000Z", endAt: "2026-10-10T19:00:00.000Z" },
    });
  });

  test("never reaches before consent, and is bounded by the lookback limit", () => {
    const bookings = [booking("held", "student-1", "2026-10-10T18:00:00.000Z"), next];
    expect(digestWindow({ bookings, booking: next, sharingStartedAt: at("2026-10-12T00:00:00.000Z"), now: NOW }))
      .toMatchObject({ since: at("2026-10-12T00:00:00.000Z"), basis: "sharing_started" });
    expect(digestWindow({ bookings: [next], booking: next, sharingStartedAt: at("2026-01-01T00:00:00.000Z"), now: NOW }))
      .toMatchObject({
        since: new Date(NOW.getTime() - DIGEST_LOOKBACK_DAYS * 86_400_000),
        basis: "lookback_limit",
        lastSession: null,
      });
  });
});

describe("past-session history", () => {
  const serialize = (item) => ({ id: item.id, status: item.status });
  const bookings = [
    booking("a1", "student-1", "2026-10-01T18:00:00.000Z"),
    booking("b1", "student-2", "2026-10-03T18:00:00.000Z", 60, { status: "cancelled", cancelledBy: "student" }),
    booking("a2", "student-1", "2026-10-05T18:00:00.000Z"),
    booking("a-now", "student-1", "2026-10-20T11:30:00.000Z"),
    booking("a-next", "student-1", "2026-10-22T18:00:00.000Z"),
  ];

  test("gives a coach every ended session newest first with complete per-student counts", () => {
    const out = sessionHistory(bookings, { kind: "coach" }, { limit: 2, now: NOW, serialize });
    expect(out.bookings).toEqual([{ id: "a2", status: "booked" }, { id: "b1", status: "cancelled" }]);
    expect(out).toMatchObject({ total: 3, held: 2, limit: 2, hasMore: true });
    expect(out.students).toEqual([
      { studentId: "student-1", name: "Alex", held: 2, cancelled: 0 },
      { studentId: "student-2", name: "Blair", held: 0, cancelled: 1 },
    ]);
  });

  test("gives a student only their own sessions and no roster counts", () => {
    const out = sessionHistory(bookings, { kind: "student", studentUserId: "student-user-2" }, { limit: "abc", now: NOW, serialize });
    expect(out).toEqual({ bookings: [{ id: "b1", status: "cancelled" }], total: 1, held: 0, limit: 50, hasMore: false });
  });
});

let mongo;
let client;
let db;
let service;
const coachRole = { role: "coach", coachId: "coach-1" };
const alexRole = { role: "student", studentId: "student-1" };
const blairRole = { role: "student", studentId: "student-2" };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  const raw = client.db("coaching_sessions_test");
  db = {
    coaching: raw.collection("coaching_locker"),
    users: raw.collection("users"),
    games: raw.collection("games"),
    devicePairings: raw.collection("device_pairings"),
    deviceTokens: raw.collection("device_tokens"),
  };
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

async function seedDigest({ alexSharing = sharing("accepted", "2026-09-01T13:00:00.000Z") } = {}) {
  await Promise.all(Object.values(db).map((collection) => collection.deleteMany({})));
  await db.coaching.insertOne({
    _id: "locker",
    rev: 1,
    state: {
      coaches: [{ id: "coach-1", name: "Response", userId: "coach-user" }],
      students: [
        { id: "student-1", name: "Alex", userId: "student-user-1", coachId: "coach-1", practiceSharing: alexSharing },
        { id: "student-2", name: "Blair", userId: "student-user-2", coachId: "coach-1", practiceSharing: sharing("pending", "2026-09-01T13:00:00.000Z", "student-user-2") },
      ],
    },
  });
  await db.coaching.insertOne({
    _id: "calendar:coach-1",
    bookings: [
      booking("held", "student-1", "2026-10-10T18:00:00.000Z"),
      booking("cancelled", "student-1", "2026-10-15T18:00:00.000Z", 60, { status: "cancelled", cancelledBy: "coach" }),
      booking("next", "student-1", "2026-10-22T18:00:00.000Z"),
      booking("blair-next", "student-2", "2026-10-23T18:00:00.000Z"),
    ],
  });
  await db.coaching.insertMany([
    { _id: "assignment:active", kind: "game_requirement", id: "active", coachId: "coach-1", coachUserId: "coach-user",
      studentId: "student-1", studentUserId: "student-user-1", practiceSharingGrantId: "grant-student-user-1",
      createdAt: at("2026-10-14T00:00:00Z"), requirement: { type: "games", startsAt: at("2026-10-14T00:00:00Z"), endsAt: at("2026-10-20T00:00:00Z") } },
    { _id: "assignment:old", kind: "game_requirement", id: "old", coachId: "coach-1", coachUserId: "coach-user",
      studentId: "student-1", studentUserId: "student-user-1", practiceSharingGrantId: "superseded",
      createdAt: at("2026-10-11T00:00:00Z"), requirement: { type: "games", startsAt: at("2026-10-11T00:00:00Z"), endsAt: at("2026-10-13T00:00:00Z") } },
  ]);
  await db.games.insertMany([
    game("before-last-session", "2026-10-10T12:00:00.000Z"),
    game("w1", "2026-10-11T12:00:00.000Z"),
    game("w2", "2026-10-12T12:00:00.000Z"),
    game("l1", "2026-10-13T12:00:00.000Z", { result: "Defeat" }),
    game("custom", "2026-10-13T13:00:00.000Z", { isLadderGame: false, myBuild: "Unassigned custom build" }),
    game("w3", "2026-10-14T12:00:00.000Z"),
    game("l2", "2026-10-15T12:00:00.000Z", { result: "Defeat", myBuild: null }),
    game("pvt", "2026-10-16T12:00:00.000Z", { opponent: { race: "Terran" }, map: "Ghost River LE",
      result: "Defeat", replayFile: { storedAt: NOW } }),
    game("checked-in", "2026-10-17T12:00:00.000Z", {
      myBuild: "DT Rush",
      buildIntent: { status: "confirmed", applied: true, build: { name: "DT Rush" }, detected: { name: "Chargelot All-in" } },
    }),
    game("team", "2026-10-18T12:00:00.000Z", { matchFormat: "2v2", playerCount: 4 }),
    game("hidden", "2026-10-18T13:00:00.000Z", { excluded: true }),
    game("resumed", "2026-10-18T14:00:00.000Z", { isResumedFromReplay: true }),
    game("someone-else", "2026-10-18T15:00:00.000Z", { userId: "student-user-2" }),
  ]);
  service = new CoachingService({ db, now: () => new Date(NOW) });
}

describe("booking prep digest facts", () => {
  test("gives the coach ranked counts and only current-assignment replay facts", async () => {
    await seedDigest();
    const digest = await service.bookingDigest("coach-user", coachRole, "next");
    expect(digest).toMatchObject({
      bookingId: "next",
      role: "coach",
      state: "ready",
      window: { since: "2026-10-10T19:00:00.000Z", until: NOW.toISOString(), basis: "last_session" },
      lastSession: { startAt: "2026-10-10T18:00:00.000Z" },
      totals: { games: 7, wins: 4, losses: 3, other: 0 },
      unclassifiedGames: 1,
      moreBuilds: 0,
      moreReplays: 0,
      minSample: 5,
    });
    expect(digest.matchups).toEqual([
      { matchup: "PvZ", games: 6, wins: 4, losses: 2, winRate: 0.667 },
      { matchup: "PvT", games: 1, wins: 0, losses: 1, winRate: null },
    ]);
    expect(digest.builds).toEqual([
      { name: "Blink Stalkers", games: 2 },
      { name: "Chargelot All-in", games: 1 },
    ]);
    expect(digest.replays).toHaveLength(4);
    expect(digest.replays[1]).toEqual({
      playedAt: "2026-10-16T12:00:00.000Z", map: "Ghost River LE", matchup: "PvT", result: "Loss", build: "Blink Stalkers",
      evidenceRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(digest)).not.toMatch(/gameId|Unassigned custom build|SecretOpponent|DT Rush/);
  });

  test("the student sees their own check-in labels and links without grades or private metrics", async () => {
    await seedDigest();
    const digest = await service.bookingDigest("student-user-1", alexRole, "next");
    expect(digest.role).toBe("student");
    const keys = [...keysOf(digest)].join(" ");
    expect(keys).not.toMatch(/grade|score|mmr|macro|apm|note|practice|opponent|intent|check/i);
    expect(JSON.stringify(digest)).not.toMatch(/SecretOpponent|private note/);
    expect(digest.totals.games).toBe(8);
    expect(digest.replays[0]).toMatchObject({ gameId: "checked-in", build: "DT Rush" });
    expect(digest.builds).toContainEqual({ name: "Unassigned custom build", games: 1 });
  });
});

describe("exact assigned replay evidence", () => {
  test("resolves only the archived replay for the actual booking party and live assignment grant", async () => {
    await seedDigest();
    const digest = await service.bookingDigest("coach-user", coachRole, "next");
    const ref = digest.replays[1].evidenceRef;
    expect(digest.replays.filter((replay) => replay.evidenceRef)).toHaveLength(1);
    expect(JSON.stringify(digest)).not.toMatch(/"pvt"|student-user-1|https?:|grantId/);
    await expect(service.bookingDigestReplay("coach-user", coachRole, "next", ref)).resolves.toEqual({ userId: "student-user-1", gameId: "pvt" });
    await expect(service.bookingDigestReplay("coach-user", coachRole, "blair-next", ref)).rejects.toMatchObject({ status: 404 });
    await db.coaching.updateOne({ _id: "calendar:coach-1" }, { $push: {
      bookings: booking("same-student-next", "student-1", "2026-10-24T18:00:00.000Z"),
    } });
    const otherBooking = await service.bookingDigest("coach-user", coachRole, "same-student-next");
    expect(otherBooking.replays[1].evidenceRef).not.toBe(ref);
    await expect(service.bookingDigestReplay("coach-user", coachRole, "same-student-next", ref)).rejects.toMatchObject({ status: 404 });
    await expect(service.bookingDigestReplay("student-user-1", alexRole, "next", ref)).rejects.toMatchObject({ status: 404 });
    await expect(service.bookingDigestReplay("platform-admin", { role: "admin", coachId: "coach-1" }, "next", ref)).rejects.toMatchObject({ status: 404 });
    await db.games.updateOne({ userId: "student-user-1", gameId: "pvt" }, { $set: { excluded: true } });
    await expect(service.bookingDigestReplay("coach-user", coachRole, "next", ref)).rejects.toMatchObject({ status: 404 });
  });

  test("revocation and acceptance under a new grant retire prior references", async () => {
    await seedDigest();
    const digest = await service.bookingDigest("coach-user", coachRole, "next");
    const ref = digest.replays[1].evidenceRef;
    const write = (value) => db.coaching.updateOne({ _id: "locker" }, { $set: { "state.students.0.practiceSharing": value } });
    await write(sharing("revoked", NOW.toISOString()));
    await expect(service.bookingDigestReplay("coach-user", coachRole, "next", ref)).rejects.toMatchObject({ status: 404 });
    await write({ ...sharing("accepted", "2026-09-01T13:00:00.000Z"), grantId: "new-grant" });
    await db.coaching.updateMany({ kind: "game_requirement", practiceSharingGrantId: "grant-student-user-1" }, { $set: { practiceSharingGrantId: "new-grant" } });
    const renewed = await service.bookingDigest("coach-user", coachRole, "next");
    expect(renewed.replays[1].evidenceRef).not.toBe(ref);
    await expect(service.bookingDigestReplay("coach-user", coachRole, "next", renewed.replays[1].evidenceRef))
      .resolves.toMatchObject({ gameId: "pvt" });
    await expect(service.bookingDigestReplay("coach-user", coachRole, "next", ref)).rejects.toMatchObject({ status: 404 });
  });
});

const label = "Protoss - DT Rush";
const choice = (enabled, expectedRev) => ({
  enabled, expectedRev, coachId: "coach-1", policyVersion: "practice-digest-catalog-labels-v1",
});

async function seedLabels() {
  await seedDigest();
  await db.users.insertMany([{ userId: "student-user-1" }, { userId: "coach-user" }]);
  const build = { key: catalogKeyForName(label), name: "Private tampered label", source: "catalog" };
  const checkin = { status: "confirmed", applied: true, build, detected: { name: "Chargelot All-in" }, notes: "Private note" };
  await db.games.updateMany({ gameId: { $in: ["checked-in", "w3"] } }, { $set: { buildIntent: checkin, myBuild: "Private tampered label" } });
  await db.games.updateOne({ gameId: "l2" }, { $set: {
    buildIntent: { ...checkin, build: { ...build, source: "custom" }, detected: { name: "Detected custom fixture" } }, myBuild: "Private custom label",
  } });
  await db.games.updateOne({ gameId: "pvt" }, { $set: {
    buildIntent: { ...checkin, applied: false }, myBuild: "Blink Stalkers",
  } });
  await db.games.insertOne(game("outside-assignment", "2026-10-20T08:00:00.000Z", {
    buildIntent: checkin, myBuild: "Private tampered label", map: "Unassigned fixture",
  }));
  let clock = at("2026-10-14T18:00:00.000Z");
  service = new CoachingService({ db, now: () => clock });
  return () => { clock = NOW; };
}

describe("supplemental digest check-in labels", () => {
  test("only a student can opt in, and sharing is catalog-only and future-assignment-only", async () => {
    const showAll = await seedLabels();
    const before = await service.practiceSharingFor("student-user-1", alexRole);
    expect(before.relationships[0].scope.digestCatalogCheckIns).toBe(false);
    await expect(service.setDigestLabelSharing("coach-user", coachRole, choice(true, 1))).rejects.toMatchObject({ status: 404 });
    await expect(service.setDigestLabelSharing("platform-admin", { role: "admin" }, choice(true, 1))).rejects.toMatchObject({ status: 404 });
    await expect(service.setDigestLabelSharing("student-user-1", alexRole, { ...choice(true, 1), policyVersion: "old" })).rejects.toMatchObject({ status: 400 });

    const allowed = await service.setDigestLabelSharing("student-user-1", alexRole, choice(true, 1));
    expect(allowed).toMatchObject({ rev: 2, relationship: { status: "accepted", scope: { digestCatalogCheckIns: true } } });
    expect(JSON.stringify(allowed)).not.toMatch(/baseGrantId|grantId|grantedAt/);
    showAll();
    const digest = await service.bookingDigest("coach-user", coachRole, "next");
    expect(digest.replays.map(({ build }) => build)).toEqual([label, "Blink Stalkers", "Detected custom fixture", "Chargelot All-in"]);
    expect(digest.builds).toContainEqual({ name: label, games: 1 });
    expect(JSON.stringify(digest)).not.toMatch(/Private (tampered|custom|note)|Unassigned fixture/);

    const stopped = await service.setDigestLabelSharing("student-user-1", alexRole, choice(false, 2));
    expect(stopped.relationship.status).toBe("accepted");
    const latest = await service.getDoc();
    latest.state.students[0].practiceSharing.digestLabels = {
      policyVersion: choice(true, 1).policyVersion, baseGrantId: "grant-student-user-1", id: "forged", grantedAt: at("2026-10-14T18:00:00.000Z"),
    };
    await expect(service.putStateWithRosterGuard(latest.state, latest.rev)).resolves.toMatchObject({ ok: true });
    const detectorOnly = await service.bookingDigest("coach-user", coachRole, "next");
    expect(detectorOnly.replays[0]).toMatchObject({ build: "Chargelot All-in" });
    expect(detectorOnly.totals).toEqual(digest.totals);
    expect(detectorOnly.replays[1].evidenceRef).toBe(digest.replays[1].evidenceRef);
  });

  test("revoking and regranting while an aggregate is in flight discards its opted-in result", async () => {
    const showAll = await seedLabels();
    await service.setDigestLabelSharing("student-user-1", alexRole, choice(true, 1));
    showAll();
    const read = db.games.aggregate.bind(db.games);
    const spy = jest.spyOn(db.games, "aggregate").mockImplementationOnce((...args) => {
      const cursor = read(...args);
      return { toArray: async () => {
        const rows = await cursor.toArray();
        await service.setDigestLabelSharing("student-user-1", alexRole, choice(false, 2));
        await service.setDigestLabelSharing("student-user-1", alexRole, choice(true, 3));
        return rows;
      } };
    });
    try {
      const digest = await service.bookingDigest("coach-user", coachRole, "next");
      expect(digest.replays[0].build).toBe("Chargelot All-in");
      expect(digest.builds.some((entry) => entry.name === label)).toBe(false);
    } finally { spy.mockRestore(); }
  });
});

describe("booking prep digest consent and window", () => {
  test("returns no game facts until the student accepts practice sharing under the current policy", async () => {
    await seedDigest({ alexSharing: sharing("revoked", "2026-10-01T00:00:00.000Z") });
    await expect(service.bookingDigest("coach-user", coachRole, "next"))
      .resolves.toEqual({ bookingId: "next", role: "coach", state: "sharing_off", sharing: "revoked" });
    await expect(service.bookingDigest("student-user-1", alexRole, "next"))
      .resolves.toEqual({ bookingId: "next", role: "student", state: "sharing_off", sharing: "revoked" });
    await expect(service.bookingDigest("coach-user", coachRole, "blair-next"))
      .resolves.toEqual({ bookingId: "blair-next", role: "coach", state: "sharing_off", sharing: "pending" });
    await seedDigest({ alexSharing: { ...sharing("accepted", "2026-09-01T13:00:00.000Z"), policyVersion: "practice-replays-v0" } });
    await expect(service.bookingDigest("coach-user", coachRole, "next")).resolves.toMatchObject({ state: "sharing_off" });
  });

  test("drops an in-flight digest when the student revokes its grant", async () => {
    await seedDigest();
    const read = db.games.aggregate.bind(db.games);
    const spy = jest.spyOn(db.games, "aggregate").mockImplementationOnce((...args) => {
      const cursor = read(...args);
      return { toArray: async () => {
        const rows = await cursor.toArray();
        await db.coaching.updateOne({ _id: "locker" }, { $set: { "state.students.0.practiceSharing": sharing("revoked", NOW.toISOString()) } });
        return rows;
      } };
    });
    try {
      await expect(service.bookingDigest("coach-user", coachRole, "next")).resolves.toEqual({ bookingId: "next", role: "coach", state: "sharing_off", sharing: "revoked" });
    } finally { spy.mockRestore(); }
  });

  test("starts at consent when sharing began after the last session", async () => {
    await seedDigest({ alexSharing: sharing("accepted", "2026-10-14T00:00:00.000Z") });
    const digest = await service.bookingDigest("coach-user", coachRole, "next");
    expect(digest.window).toMatchObject({ since: "2026-10-14T00:00:00.000Z", basis: "sharing_started" });
    expect(digest.totals.games).toBe(4);
  });
});

describe("booking prep digest access and history", () => {
  test("is readable only by the booking's own coach and student, for upcoming sessions", async () => {
    await seedDigest();
    await expect(service.bookingDigest("student-user-2", blairRole, "next")).rejects.toMatchObject({ status: 404 });
    await expect(service.bookingDigest("platform-admin", { role: "admin", coachId: "coach-1" }, "next"))
      .rejects.toMatchObject({ status: 404, code: "booking_not_found" });
    await expect(service.bookingDigest("coach-user", coachRole, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(service.bookingDigest("coach-user", coachRole, "cancelled")).rejects.toMatchObject({ status: 409 });
    await expect(service.bookingDigest("coach-user", coachRole, "held")).rejects.toMatchObject({ status: 409, code: "session_not_upcoming" });
  });

  test("reports an empty window as no_games", async () => {
    await seedDigest();
    await db.games.deleteMany({});
    await expect(service.bookingDigest("coach-user", coachRole, "next"))
      .resolves.toMatchObject({ state: "no_games", totals: { games: 0 }, matchups: [], builds: [], replays: [] });
  });

  test("history keeps a student's view to their own bookings", async () => {
    await seedDigest();
    const coach = await service.calendarHistory("coach-user", coachRole, { limit: 10 });
    expect(coach).toMatchObject({ role: "coach", total: 2, held: 1, hasMore: false });
    expect(coach.bookings.map((item) => item.id)).toEqual(["cancelled", "held"]);
    expect(coach.students).toEqual([{ studentId: "student-1", name: "Alex", held: 1, cancelled: 1 }]);
    const blair = await service.calendarHistory("student-user-2", blairRole, {});
    expect(blair).toEqual({ role: "student", bookings: [], total: 0, held: 0, limit: 50, hasMore: false });
  });
});

function app(auth, role = { role: "coach", coachId: "coach-1" }, replayFiles) {
  const coaching = {
    roleFor: jest.fn(async () => role),
    calendarFor: jest.fn(async () => ({ role: "coach" })),
    calendarHistory: jest.fn(async () => ({ role: "coach", bookings: [] })),
    bookingDigest: jest.fn(async () => ({ state: "ready" })),
    setDigestLabelSharing: jest.fn(async () => ({ rev: 2 })),
    bookingDigestReplay: jest.fn(async () => ({ userId: "private-student", gameId: "private-replay" })),
  };
  const router = buildCoachingRouter({
    auth: (req, _res, next) => { req.auth = auth; next(); },
    isAdmin: () => false,
    coaching,
    aggregations: {},
    replayFiles,
    users: {},
  });
  const server = express();
  server.use(express.json());
  server.use("/v1", router);
  server.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || err.message }));
  return { server, coaching };
}

describe("coaching session routes", () => {
  test("serves history on ?past=1 and keeps the calendar read unchanged", async () => {
    const { server, coaching } = app({ userId: "coach-user", source: "clerk" });
    const past = await request(server).get("/v1/coaching/calendar?past=1&limit=50");
    expect(past.status).toBe(200);
    expect(past.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(coaching.calendarHistory).toHaveBeenCalledWith("coach-user", { role: "coach", coachId: "coach-1" }, { limit: 50 });
    await request(server).get("/v1/coaching/calendar?timeZone=UTC").expect(200);
    expect(coaching.calendarFor).toHaveBeenCalledWith("coach-user", { role: "coach", coachId: "coach-1" }, "UTC");
  });

  test("serves the digest privately to signed-in people only", async () => {
    const signedIn = app({ userId: "coach-user", source: "clerk" });
    const ok = await request(signedIn.server).get("/v1/coaching/calendar/bookings/next/digest");
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(signedIn.coaching.bookingDigest).toHaveBeenCalledWith("coach-user", { role: "coach", coachId: "coach-1" }, "next");
    const device = app({ userId: "student-user-1", source: "device" });
    await request(device.server).get("/v1/coaching/calendar/bookings/next/digest").expect(404);
    expect(device.coaching.bookingDigest).not.toHaveBeenCalled();
    const outsider = app({ userId: "someone", source: "clerk" }, { role: "none" });
    await request(outsider.server).get("/v1/coaching/calendar/bookings/next/digest").expect(404);
    expect(outsider.coaching.bookingDigest).not.toHaveBeenCalled();
  });
});

test("coach replay is a private neutral attachment and rechecks the grant after opening storage", async () => {
  const files = { prepareDownload: jest.fn(async () => ({ url: "https://internal.invalid/private-storage-key" })) };
  const route = "/v1/coaching/calendar/bookings/next/digest/replay";
  const body = { reference: "A".repeat(43) };
  const signedIn = app({ userId: "coach-user", source: "clerk" }, undefined, files);
  const bytes = Buffer.from("MPQ\x1a");
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(bytes, { headers: { "content-length": "4" } }));
  try {
    const result = await request(signedIn.server).post(route).send(body).expect(200);
    expect(result.body).toEqual(bytes);
    expect(result.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(result.headers["content-disposition"]).toBe('attachment; filename="sc2tools-replay.SC2Replay"');
    expect(result.headers.location).toBeUndefined();
    expect(files.prepareDownload).toHaveBeenCalledWith("private-student", "private-replay", { filename: "sc2tools-replay.SC2Replay" });
    expect(signedIn.coaching.bookingDigestReplay).toHaveBeenCalledTimes(2);
    fetchSpy.mockImplementationOnce(async () => {
      signedIn.coaching.bookingDigestReplay.mockRejectedValueOnce(Object.assign(new Error("revoked"), { status: 404 }));
      return new Response(bytes, { headers: { "content-length": "4" } });
    });
    const revoked = await request(signedIn.server).post(route).send(body).expect(404);
    expect(revoked.headers["content-disposition"]).toBeUndefined();
    expect(JSON.stringify(revoked.body)).not.toMatch(/private-student|private-replay|internal.invalid/);
    const device = app({ userId: "coach-user", source: "device" }, undefined, files);
    await request(device.server).post(route).send(body).expect(404);
    expect(device.coaching.bookingDigestReplay).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

test("supplemental label consent requires a student Clerk session", async () => {
  const route = "/v1/coaching/practice-sharing/digest-labels";
  const body = { expectedRev: 1, coachId: "coach-1", enabled: true, policyVersion: "practice-digest-catalog-labels-v1" };
  const signedIn = app({ userId: "student-user-1", source: "clerk" }, alexRole);
  await request(signedIn.server).post(route).send(body).expect("Cache-Control", "private, no-store, max-age=0").expect(200);
  expect(signedIn.coaching.setDigestLabelSharing).toHaveBeenCalledWith("student-user-1", alexRole, body);
  for (const [source, role] of [["device", alexRole], ["clerk", coachRole]]) {
    const rejected = app({ userId: "student-user-1", source }, role);
    await request(rejected.server).post(route).send(body).expect(404);
    expect(rejected.coaching.setDigestLabelSharing).not.toHaveBeenCalled();
  }
});
