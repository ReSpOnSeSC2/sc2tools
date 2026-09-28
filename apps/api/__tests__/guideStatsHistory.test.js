// @ts-nocheck
"use strict";

/**
 * services/guideStats.js — run-over-run behaviour and privacy:
 * week-over-week baseline rotation, idempotent reruns, isNew and the
 * carried-forward firstPublishedAt, example replays (sharing users only,
 * no gameId / opponent fields) and the NO-PII scan over every doc.
 */

const { GuideStatsService } = require("../src/services/guideStats");
const {
  NOW_MS, DAY_MS, BEFORE_BUILD,
  startDb, resetDb, slimGame, cellGames, sampleRow, statsByKey,
} = require("./helpers/guideStatsSeed");

const HOUR_MS = 60 * 60 * 1000;
const KEY_GLAIVES = "build:after:PvZ:stargate-into-glaives";
const SHARER_SLUG = "sharer-a1b2c3d4e5";
const SECOND_SLUG = "second-0123456789";
/** Numeric sections a rerun on unchanged data must reproduce exactly. */
const NUMERIC_FIELDS = ["overall", "prevalence", "matchupGames", "bands", "headline", "vsStrategy", "lengths", "maps"];

describe("GuideStatsService — history, examples and privacy", () => {
  let mongo; let db; let now;

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_stats_history"));
  });
  beforeEach(async () => {
    await resetDb(db);
    now = NOW_MS;
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const runAt = async (ms) => {
    now = ms;
    await new GuideStatsService(db, { logger: null, now: () => now }).recompute();
    return (await statsByKey(db)).get(KEY_GLAIVES);
  };
  const pick = (doc) => Object.fromEntries(NUMERIC_FIELDS.map((f) => [f, doc[f]]));

  test("baseline is a real snapshot ≥ 7 days old, rotated weekly; reruns change nothing", async () => {
    await db.games.insertMany(cellGames({ users: 6, perUser: 20, winsPerUser: 10, userPrefix: "a" }));
    const first = await runAt(NOW_MS);
    const firstSnapshot = { games: 120, winRate: 0.5, prevalence: 1, at: new Date(NOW_MS) };
    expect(first).toMatchObject({
      baseline: null, baselineCandidate: firstSnapshot, trend: null, isNew: true, firstPublishedAt: new Date(NOW_MS),
    });

    // Reruns inside the week ("Recompute now", deploys): numbers and both slots unchanged.
    const rerun = await runAt(NOW_MS + HOUR_MS);
    expect(pick(rerun)).toEqual(pick(first));
    expect(rerun).toMatchObject({ baseline: null, baselineCandidate: firstSnapshot, trend: null, isNew: false });

    await db.games.insertMany(cellGames({ users: 6, perUser: 10, winsPerUser: 10, userPrefix: "b" }));
    const midWeek = await runAt(NOW_MS + 3 * DAY_MS);
    expect(midWeek.overall).toMatchObject({ games: 180, wins: 120, winRate: 0.6667 });
    expect(midWeek).toMatchObject({ baseline: null, baselineCandidate: firstSnapshot, trend: null });

    // Day 7: the week-old candidate becomes the baseline; today's numbers the next candidate.
    const weekOne = await runAt(NOW_MS + 7 * DAY_MS);
    const weekOneSnapshot = { games: 180, winRate: 0.6667, prevalence: 1, at: new Date(NOW_MS + 7 * DAY_MS) };
    expect(weekOne.baseline).toEqual(firstSnapshot);
    expect(weekOne.baselineCandidate).toEqual(weekOneSnapshot);
    expect(weekOne.trend).toEqual({ winRateDelta: 0.1667, prevalenceDelta: 0, since: new Date(NOW_MS) });

    const weekOneRerun = await runAt(NOW_MS + 7 * DAY_MS + HOUR_MS);
    expect(pick(weekOneRerun)).toEqual(pick(weekOne));
    for (const field of ["baseline", "baselineCandidate", "trend"]) expect(weekOneRerun[field]).toEqual(weekOne[field]);

    // Mid second week: still compared with the ≥ 7-day-old first snapshot.
    const tenDays = await runAt(NOW_MS + 10 * DAY_MS);
    expect(tenDays.baseline).toEqual(firstSnapshot);
    expect(tenDays.baselineCandidate).toEqual(weekOneSnapshot);

    const weekTwo = await runAt(NOW_MS + 14 * DAY_MS);
    expect(weekTwo.baseline).toEqual(weekOneSnapshot);
    expect(weekTwo.trend).toEqual({ winRateDelta: 0, prevalenceDelta: 0, since: new Date(NOW_MS + 7 * DAY_MS) });
    expect(weekTwo.firstPublishedAt).toEqual(new Date(NOW_MS));

    // After a long gap in runs the promoted snapshot is too old to call "last week": no trend.
    const afterGap = await runAt(NOW_MS + 60 * DAY_MS);
    expect(afterGap.baseline).toBeNull();
    expect(afterGap.trend).toBeNull();
    expect(afterGap.baselineCandidate).toEqual({ ...weekOneSnapshot, at: new Date(NOW_MS + 60 * DAY_MS) });
  });

  test("isNew marks the first published run; firstPublishedAt is carried even when unpublished again", async () => {
    await db.games.insertMany(cellGames({ users: 6, perUser: 10, winsPerUser: 5, userPrefix: "a" }));
    const cellOnly = await runAt(NOW_MS);
    expect(cellOnly).toMatchObject({ published: false, isNew: false, firstPublishedAt: null });

    await db.games.insertMany(cellGames({ users: 6, perUser: 10, winsPerUser: 5, userPrefix: "b" }));
    const published = await runAt(NOW_MS + DAY_MS);
    expect(published).toMatchObject({ published: true, isNew: true, firstPublishedAt: new Date(NOW_MS + DAY_MS) });

    const again = await runAt(NOW_MS + 2 * DAY_MS);
    expect(again).toMatchObject({ published: true, isNew: false, firstPublishedAt: new Date(NOW_MS + DAY_MS) });

    await db.games.deleteMany({ userId: /^b-/ });
    const dropped = await runAt(NOW_MS + 3 * DAY_MS);
    expect(dropped).toMatchObject({ published: false, isNew: false, firstPublishedAt: new Date(NOW_MS + DAY_MS) });
  });

  test("examples: newest stored replay per sharing user, public fields only", async () => {
    const stored = { replayFile: { storedAt: new Date(NOW_MS), sizeBytes: 1000 } };
    await db.users.insertMany([
      { displayName: "Sharer One", replaySharing: { enabled: true, slug: SHARER_SLUG } },
      { displayName: "  Second\u0007 ", replaySharing: { enabled: true, slug: SECOND_SLUG } },
      { displayName: "Private", replaySharing: { enabled: false, slug: "private-aaaaaaaaaa" } },
      { displayName: "Bad", replaySharing: { enabled: true, slug: "Not A Slug" } },
    ].map((user, i) => ({
      userId: ["sharer-0", "sharer-1", "private-0", "badslug-0"][i], clerkUserId: `clerk_${i}`, ...user,
    })));
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 20, winsPerUser: 10, userPrefix: "cell" }),
      slimGame({ userId: "sharer-0", date: new Date(NOW_MS - 3 * DAY_MS), result: "Defeat", ...stored }),
      slimGame({
        userId: "sharer-0", date: new Date(NOW_MS - DAY_MS), result: "Victory", durationSec: 612.4, ...stored,
      }),
      slimGame({ userId: "sharer-0", date: new Date(NOW_MS - HOUR_MS) }),
      slimGame({ userId: "sharer-0", date: new Date(NOW_MS - HOUR_MS), gameBuild: BEFORE_BUILD, ...stored }),
      slimGame({
        userId: "sharer-1", date: new Date(NOW_MS - 2 * DAY_MS), result: "Tie", map: "Alcyone LE", ...stored,
      }),
      slimGame({ userId: "private-0", date: new Date(NOW_MS), ...stored }),
      slimGame({ userId: "badslug-0", date: new Date(NOW_MS), ...stored }),
    ]);
    const doc = await runAt(NOW_MS);
    expect(doc.published).toBe(true);
    expect(doc.examples).toEqual([
      {
        handle: SHARER_SLUG, displayName: "Sharer One", result: "Victory", map: "Site Delta LE",
        durationSec: 612, playedAt: new Date(NOW_MS - DAY_MS),
      },
      {
        handle: SECOND_SLUG, displayName: "Second", result: "Tie", map: "Alcyone LE",
        durationSec: 640, playedAt: new Date(NOW_MS - 2 * DAY_MS),
      },
    ]);
    expect((await statsByKey(db)).get("build:before:PvZ:stargate-into-glaives").examples).toEqual([]);
  });

  test("NO-PII: no userId, gameId, opponent name, pulse id, toon handle or user hash reaches guide_stats", async () => {
    const users = 6;
    const games = [];
    for (let i = 0; i < users * 25; i += 1) {
      games.push(slimGame({
        userId: `PII_USER_7f3a_${i % users}`,
        gameId: `PII_GAME_${i}`,
        myToonHandle: `3-S2-1-PIIMINE${i % users}`,
        result: i % 3 === 0 ? "Defeat" : "Victory",
        replayFile: { storedAt: new Date(NOW_MS), sizeBytes: 5 },
        opponent: {
          displayName: `PII_NAME_${i}`, pulseId: `1-S2-1-PII${i}`, toonHandle: `2-S2-1-PIITOON${i}`,
          pulseCharacterId: `PII_CHAR_${i}`, strategy: "Zerg - 8 Pool", mmr: 4120, leagueId: 4,
        },
      }));
    }
    await db.games.insertMany(games);
    await db.users.insertMany(Array.from({ length: users }, (_, u) => ({
      userId: `PII_USER_7f3a_${u}`,
      clerkUserId: `clerk_pii_${u}`,
      displayName: u === 0 ? "Public Sharer" : `PII_DISPLAY_${u}`,
      replaySharing: { enabled: u === 0, slug: `sharer${u}-a1b2c3d4e5` },
    })));
    await db.guideSamples.insertMany(Array.from({ length: 60 }, (_, i) => sampleRow({
      userHash: `PII_UHASH_${i % users}`, gameHash: `PII_GHASH_${i}`,
      milestones: { Pylon: 18 }, army: { 360: { Oracle: 1 } },
    })));
    await runAt(NOW_MS);

    const docs = await db.guideStats.find({}).toArray();
    expect(docs.length).toBeGreaterThan(0);
    const glaives = docs.find((d) => d.key === KEY_GLAIVES);
    expect(glaives.published).toBe(true);
    expect(glaives.examples).toEqual([expect.objectContaining({ displayName: "Public Sharer" })]);
    expect(glaives.timings.samples).toBe(60);
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      for (const needle of ["PII", "7f3a", "1-S2-1-", "2-S2-1-", "3-S2-1-"]) {
        expect(json).not.toContain(needle);
      }
      expect(json).not.toMatch(/"(userId|gameId|opponent|pulseId|toonHandle|myToonHandle|userHash|gameHash)"/);
    }
  });
});
