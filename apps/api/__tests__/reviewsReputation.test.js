// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { buildReviewDigestJob, isPastSendSlot } = require("../src/jobs/reviewDigestJob");
const { bandFromMmr, approximateMmr } = require("../src/util/leagueBands");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: verified reviewer band and coach badge", () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  test("verification needs 10 ladder games per race and 3 games at the band", async () => {
    await h.seedUser("spike");
    // Nine Master-level games are not enough games in total for Zerg…
    await h.seedLadderHistory("spike", { count: 9, mmr: 5000, race: "Zerg" });
    let v = await h.services.reviewerReputation.computeVerification(h.userId("spike"));
    expect(v.band).toBeNull();
    expect(v.reason).toBe("not_enough_ladder_games");
    // …and a single Grandmaster outlier among Diamond games verifies Diamond.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      userId: h.userId("spike"), gameId: `t-${i}`, date: new Date(), myRace: "Terran", matchFormat: "1v1",
      isLadderGame: true, myMmr: i === 0 ? 6900 : 3800, myMmrSource: "replay", result: "Victory", map: "X",
    }));
    await h.db.games.insertMany(rows);
    v = await h.services.reviewerReputation.computeVerification(h.userId("spike"));
    expect(v.race).toBe("Terran");
    expect(v.band).toEqual({ id: 4, label: "Diamond" });
    // Unranked or team games never count.
    await h.db.games.insertMany(Array.from({ length: 12 }, (_, i) => ({
      userId: h.userId("spike"), gameId: `team-${i}`, date: new Date(), myRace: "Protoss", matchFormat: "team",
      isLadderGame: true, myMmr: 6000, myMmrSource: "replay", result: "Victory", map: "X",
    })));
    v = await h.services.reviewerReputation.computeVerification(h.userId("spike"));
    expect(v.race).toBe("Terran");
  });

  test("coach badge links a coach's own students to the schedule and lets others request a lesson", async () => {
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("coach", { displayName: "CoachSensei" });
    await h.seedUser("student", { displayName: "Pupil" });
    await h.seedUser("stranger", { displayName: "Stranger" });
    await h.seedLadderHistory("coach", { mmr: 5600 });
    await h.db.coaching.insertOne({
      _id: "locker",
      rev: 1,
      state: {
        coaches: [{ id: "c1", name: "CoachSensei", userId: h.userId("coach"), email: "coach@example.com", clerkUserId: "clerk_coach" }],
        students: [{ id: "s1", name: "Pupil", userId: h.userId("student"), coachId: "c1" }],
      },
    });
    await h.db.coaching.insertOne({
      _id: "calendar:c1",
      coachId: "c1",
      coachUserId: h.userId("coach"),
      availabilityEnabled: true,
      availability: { timeZone: "UTC", durations: [60], windows: [{ day: 1, startMinute: 600, endMinute: 720 }] },
      bookings: [],
    });
    h.services.reviewerReputation._coachCache = null;
    const gameId = await h.seedGame("asker");
    const id = (await request(h.app).post("/v1/reviews").set("authorization", h.bearer("asker")).send({ gameId, question: QUESTION })).body.id;
    const c = (await request(h.app).post(`/v1/reviews/${id}/comments`).set("authorization", h.bearer("coach")).send({ body: "Coach here: scout at 4:30.", gameTimeSec: 270 })).body.id;

    const anon = await request(h.app).get(`/v1/reviews/${id}`);
    const author = anon.body.comments.find((x) => x.id === c).author;
    expect(author.coach).toEqual({ coachId: "c1", bookable: true, isViewersCoach: false });
    expect(JSON.stringify(anon.body)).not.toContain("coach@example.com");
    const asStudent = await request(h.app).get(`/v1/reviews/${id}`).set("authorization", h.bearer("student"));
    expect(asStudent.body.comments.find((x) => x.id === c).author.coach.isViewersCoach).toBe(true);

    const direct = await request(h.app).post("/v1/reviews/coaches/c1/lesson-request").set("authorization", h.bearer("student")).send({});
    expect(direct.body).toEqual({ status: "student", href: "/coaching?view=schedule" });
    const req = await request(h.app).post("/v1/reviews/coaches/c1/lesson-request").set("authorization", h.bearer("stranger")).send({ note: "Can we work on PvZ?", requestId: id });
    expect(req.status).toBe(202);
    expect(req.body.status).toBe("requested");
    const inbox = await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("coach"));
    const lesson = inbox.body.items.find((n) => n.kind === "review.lesson_request");
    expect(lesson).toMatchObject({ title: "Stranger would like a lesson", body: "Can we work on PvZ?", href: `/reviews/${id}` });
    expect((await request(h.app).post("/v1/reviews/coaches/nope/lesson-request").set("authorization", h.bearer("stranger")).send({})).status).toBe(404);
  });

  test("public profile carries a reviewer section once they have reviewed", async () => {
    await h.db.communityBuilds.insertOne({ slug: "b1", ownerUserId: h.userId("coach"), removed: false, authorName: "CoachSensei", title: "t", matchup: "PvZ", votes: 0, publishedAt: new Date(), build: { race: "Protoss" } });
    const profile = await h.services.publicProfile.getPublicProfile(h.userId("coach"));
    expect(profile.reviewer).toMatchObject({ reviews: 1, matchupsReviewed: [{ matchup: "PvZ", count: 1 }] });
    expect(profile.reviewer.badges.map((b) => b.key)).toContain("first_review");
  });

  test("league bands and rounded MMR", () => {
    expect(bandFromMmr(4130)).toMatchObject({ id: 4, label: "Diamond" });
    expect(bandFromMmr(4600)).toMatchObject({ id: 5, label: "Master" });
    expect(bandFromMmr(6500)).toMatchObject({ id: 6 });
    expect(bandFromMmr(0)).toBeNull();
    expect(approximateMmr(4088)).toBe(4100);
    expect(approximateMmr(Number.NaN)).toBeNull();
  });
});

describe("review digest job", () => {
  test("sends only after Monday 15:00 UTC and keys the week", async () => {
    expect(isPastSendSlot(new Date("2026-09-21T14:59:00Z"))).toBe(false); // Monday
    expect(isPastSendSlot(new Date("2026-09-21T15:00:00Z"))).toBe(true);
    expect(isPastSendSlot(new Date("2026-09-27T01:00:00Z"))).toBe(true); // Sunday
    const sendWeeklyDigest = jest.fn(async () => ({ notified: 2 }));
    const logger = require("pino")({ level: "silent" });
    const job = buildReviewDigestJob({ reviews: { sendWeeklyDigest }, logger, enabled: true, nowFn: () => Date.parse("2026-09-23T10:00:00Z") });
    await job.runOnce();
    expect(sendWeeklyDigest).toHaveBeenCalledWith({ weekKey: "2026-09-21" });
    const early = buildReviewDigestJob({ reviews: { sendWeeklyDigest }, logger, enabled: true, nowFn: () => Date.parse("2026-09-21T09:00:00Z") });
    sendWeeklyDigest.mockClear();
    await early.runOnce();
    expect(sendWeeklyDigest).not.toHaveBeenCalled();
    const off = buildReviewDigestJob({ reviews: { sendWeeklyDigest }, logger, enabled: false });
    off.start();
    await off.stop();
    expect(sendWeeklyDigest).not.toHaveBeenCalled();
  });
});
