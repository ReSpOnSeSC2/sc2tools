// @ts-nocheck
"use strict";

/**
 * Build check-in readers on surfaces other people see (contract §5):
 * coaching assignment progress, the coach-visible per-game build and the
 * coaching practice game list use the classifier's label; published
 * community-card owner totals key on the classifier's custom-build slug.
 */

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { CoachingService } = require("../src/services/coaching");
const { CommunityService } = require("../src/services/community");
const {
  STARGATE,
  UNCLASSIFIED,
  SECRET_NOTES,
  DT_REF,
  slimGame,
  checkIn,
  seedThree,
} = require("./helpers/buildIntentReadersSeed");

const STUDENT = "student-user-1";
const COACH_ROLE = { role: "coach", coachId: "coach-1" };
const GAME_DATE = new Date("2026-09-04T13:00:00.000Z");

let mongo;
let client;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  const raw = client.db("build_intent_readers_coaching_test");
  db = {
    coaching: raw.collection("coaching_locker"),
    users: raw.collection("users"),
    games: raw.collection("games"),
    devicePairings: raw.collection("device_pairings"),
    deviceTokens: raw.collection("device_tokens"),
    communityBuilds: raw.collection("community_builds"),
  };
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(db).map((collection) => collection.deleteMany({})));
});

/**
 * The three standard rows plus custom-build shapes, all inside the
 * assignment window:
 *   "plain-custom"        classified as custom "dt-rush", no check-in;
 *   "custom-over-catalog" declared "dt-rush", classified 2 Stargate Phoenix;
 *   "catalog-over-custom" declared 2 Stargate Phoenix, classified "dt-rush".
 */
async function seedStudentGames() {
  const inWindow = (row) => ({ ...row, date: GAME_DATE, userId: STUDENT });
  await seedThree(db.games, STUDENT, inWindow);
  await db.games.insertMany([
    inWindow(slimGame(STUDENT, "plain-custom", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" })),
    inWindow(slimGame(STUDENT, "custom-over-catalog", { myBuild: STARGATE })),
    inWindow(slimGame(STUDENT, "catalog-over-custom", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" })),
  ]);
  await checkIn(db.games, STUDENT, "custom-over-catalog", DT_REF);
  await checkIn(db.games, STUDENT, "catalog-over-custom");
}

describe("coaching", () => {
  let service;

  beforeEach(async () => {
    await db.users.insertMany([{ userId: "coach-user" }, { userId: STUDENT }]);
    await db.coaching.insertOne({
      _id: "locker",
      rev: 1,
      state: {
        setup: true,
        coaches: [{ id: "coach-1", name: "Response", userId: "coach-user" }],
        students: [{
          id: "student-1",
          name: "Alex",
          userId: STUDENT,
          coachId: "coach-1",
          practiceSharing: {
            version: 1,
            policyVersion: "practice-replays-v1",
            status: "accepted",
            studentUserId: STUDENT,
            coachUserId: "coach-user",
            requestedAt: new Date("2026-09-01T12:00:00.000Z"),
            respondedAt: new Date("2026-09-01T13:00:00.000Z"),
            revokedAt: null,
            grantId: "grant-student-1",
          },
        }],
      },
    });
    service = new CoachingService({
      db,
      now: () => new Date("2026-09-04T16:00:00.000Z"),
      io: { to: () => ({ emit: () => {} }) },
    });
    await seedStudentGames();
  });

  /** @param {Record<string, any>} build @param {string} requestId */
  async function assignment(build, requestId) {
    const created = await service.createAssignment("coach-user", COACH_ROLE, "student-1", {
      clientRequestId: requestId,
      type: "build",
      requiredGames: 2,
      build,
      recurrence: "once",
      timeZone: "UTC",
      startsOn: "2026-09-01",
      endsOn: "2026-09-07",
      title: "Build reps",
      note: "",
    });
    await db.coaching.updateOne(
      { _id: `assignment:${created.id}` },
      { $set: { createdAt: new Date("2026-09-01T00:00:00.000Z") } },
    );
    return { id: created.id, doc: await db.coaching.findOne({ _id: `assignment:${created.id}` }) };
  }

  test("a catalog-name assignment counts what the replays show", async () => {
    const { id, doc } = await assignment(
      { id: "pvz-2-stargate-phoenix", name: STARGATE, matchBy: "name" },
      "req-readers-name-0001",
    );
    const progress = await service._assignmentProgress(doc, new Date("2026-09-04T16:00:00.000Z"));
    expect(progress.playedGames).toBe(3);
    const shown = Object.fromEntries(progress.replayGames.map((g) => [g.gameId, g.myBuild]));
    expect(shown).toEqual({ normal: STARGATE, agree: STARGATE, "custom-over-catalog": STARGATE });
    expect(JSON.stringify(progress)).not.toContain(SECRET_NOTES);

    const paged = await service.assignmentGames("coach-user", COACH_ROLE, id);
    expect(paged.total).toBe(3);
    expect(paged.games.map((g) => g.gameId).sort()).toEqual(["agree", "custom-over-catalog", "normal"]);
  });

  test("a custom-slug assignment counts the classifier's slug, never a declared one", async () => {
    const { doc } = await assignment(
      { id: "dt-rush", name: "DT Rush", matchBy: "slug" },
      "req-readers-slug-0001",
    );
    const progress = await service._assignmentProgress(doc, new Date("2026-09-04T16:00:00.000Z"));
    expect(progress.playedGames).toBe(2);
    const shown = Object.fromEntries(progress.replayGames.map((g) => [g.gameId, g.myBuild]));
    // The coach sees the classifier's build on the overridden row.
    expect(shown).toEqual({ "plain-custom": "DT Rush", "catalog-over-custom": "DT Rush" });
  });

  test("a game counts for the build its replay shows even when another was declared", async () => {
    const { doc } = await assignment(
      { id: "unclassified", name: UNCLASSIFIED, matchBy: "name" },
      "req-readers-uncl-0001",
    );
    const progress = await service._assignmentProgress(doc, new Date("2026-09-04T16:00:00.000Z"));
    expect(progress.playedGames).toBe(1);
    expect(progress.replayGames.map((g) => [g.gameId, g.myBuild])).toEqual([["disagree", UNCLASSIFIED]]);
  });

  test("the coaching practice game list shows classifier labels", async () => {
    const games = await service.gamesFor(STUDENT);
    expect(games).toHaveLength(6);
    const labels = games.map((g) => `${g.b}|${g.bid}`).sort();
    expect(labels).toEqual([
      "DT Rush|dt-rush",
      "DT Rush|dt-rush",
      `${STARGATE}|`,
      `${STARGATE}|`,
      `${STARGATE}|`,
      `${UNCLASSIFIED}|`,
    ]);
    expect(JSON.stringify(games)).not.toContain(SECRET_NOTES);
  });
});

describe("community published-card owner totals", () => {
  test("totals key on the classifier's slug", async () => {
    await seedStudentGames();
    await db.communityBuilds.insertOne({
      ownerUserId: STUDENT,
      removed: false,
      slug: "dt-rush-public-0123456789",
      sourceSlug: "dt-rush",
    });
    const community = new CommunityService(db);
    const [card] = await community.listOwnerReplayStats(STUDENT);
    // plain-custom + catalog-over-custom; custom-over-catalog only declared it.
    expect(card).toEqual({ publicSlug: "dt-rush-public-0123456789", total: 2, wins: 2, losses: 0 });
  });

  test("an opponent-perspective card still counts its own slot", async () => {
    await db.games.insertMany([
      slimGame(STUDENT, "opp-slot", { myBuild: UNCLASSIFIED, _customOpponentStrategySlug: "pool-first" }),
      slimGame(STUDENT, "opp-slot-declared", { myBuild: UNCLASSIFIED, _customOpponentStrategySlug: "pool-first" }),
    ]);
    await checkIn(db.games, STUDENT, "opp-slot-declared");
    await db.communityBuilds.insertOne({
      ownerUserId: STUDENT,
      removed: false,
      slug: "pool-first-public-0123456789",
      sourceSlug: "pool-first",
    });
    const [card] = await new CommunityService(db).listOwnerReplayStats(STUDENT);
    expect(card.total).toBe(2);
  });
});
