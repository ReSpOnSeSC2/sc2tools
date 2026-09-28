// @ts-nocheck
"use strict";

/**
 * services/guideStats.js — the guide_samples side: exact milestone
 * quantiles (linear interpolation, computed in Mongo), the presence
 * threshold, the both-sides floor on winner/loser medians, army presence
 * and median counts, and the per-user cap on samples (most recently
 * played first).
 */

const { GuideStatsService } = require("../src/services/guideStats");
const {
  NOW_MS, DAY_MS, GLAIVES, startDb, resetDb, sampleRow, statsByKey,
} = require("./helpers/guideStatsSeed");

const KEY_GLAIVES = "build:after:PvZ:stargate-into-glaives";
const USERS = 8;

/**
 * ``count`` samples of GLAIVES spread over USERS user hashes; ``make(i)``
 * returns per-sample overrides.
 */
function samples(count, make, users = USERS) {
  return Array.from({ length: count }, (_, i) => sampleRow({ userHash: `uh-${i % users}`, ...make(i) }));
}

describe("GuideStatsService.recompute — guide_samples timings and army", () => {
  let mongo; let db;

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_stats_samples"));
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const recompute = async () => {
    await new GuideStatsService(db, { logger: null, now: () => NOW_MS }).recompute();
    return statsByKey(db);
  };

  test("quantiles are exact (linear interpolation) with winner and loser medians", async () => {
    await db.guideSamples.insertMany(samples(80, (i) => ({
      result: i < 40 ? "Victory" : "Defeat",
      milestones: { Pylon: 100 + i },
    })));
    const doc = (await recompute()).get(KEY_GLAIVES);
    expect(doc.timings).toEqual({
      samples: 80,
      users: USERS,
      milestones: [{
        key: "Pylon", label: "Pylon", event: "start", games: 80, users: USERS, presence: 1,
        p25: 119.75, median: 139.5, p75: 159.25,
        winners: { games: 40, users: USERS, median: 119.5 },
        losers: { games: 40, users: USERS, median: 159.5 },
      }],
    });
  });

  test("milestones need 60% presence and the floor; splits need BOTH sides over the floor", async () => {
    await db.guideSamples.insertMany(samples(80, (i) => {
      const milestones = { Gateway: 40 + (i % 3) };
      if (i < 50) milestones.Stargate = 200 + i;
      if (i < 45) milestones.Forge = 150;
      if (i < 29) milestones.TwilightCouncil = 300;
      milestones.PII_UNKNOWN_KEY = 1;
      return { result: i < 55 ? "Victory" : "Defeat", milestones };
    }));
    const { timings } = (await recompute()).get(KEY_GLAIVES);
    expect(timings.milestones.map((m) => m.key)).toEqual(["Gateway", "Stargate"]);
    const [gateway, stargate] = timings.milestones;
    expect(gateway.presence).toBe(1);
    expect(stargate.presence).toBe(0.625);
    expect(stargate).toMatchObject({ event: "start", label: "Stargate", games: 50, p25: 212.25, median: 224.5 });
    // 55 winners / 25 losers: the loser side is under the floor → no split at all.
    expect(gateway.winners).toBeUndefined();
    expect(gateway.losers).toBeUndefined();
    expect(JSON.stringify(timings)).not.toContain("PII_UNKNOWN_KEY");
  });

  test("army: presence over samples carrying the checkpoint, median among fielders, missing ≠ zero", async () => {
    await db.guideSamples.insertMany(samples(80, (i) => {
      const at360 = { Oracle: i % 2 === 0 ? 1 : 2 };
      if (i < 40) at360.Adept = 3 + (i % 3);
      if (i < 20) at360.Stalker = 1;
      const army = { 360: at360 };
      if (i < 20) army[480] = { Oracle: 2, VoidRay: 1 };
      return { army };
    }));
    const { army } = (await recompute()).get(KEY_GLAIVES);
    expect(Object.keys(army)).toEqual(["360"]);
    expect(army["360"]).toEqual({
      samples: 80,
      users: USERS,
      units: [
        { unit: "Oracle", presence: 1, median: 1.5, games: 80 },
        { unit: "Adept", presence: 0.5, median: 4, games: 40 },
      ],
    });
  });

  test("one user hash contributes at most 50 samples; below the floor timings are null", async () => {
    await db.guideSamples.insertMany([
      ...Array.from({ length: 200 }, () => sampleRow({ userHash: "whale", milestones: { Pylon: 10 } })),
      ...samples(40, () => ({ milestones: { Pylon: 30 } }), 5),
      ...samples(60, () => ({ buildKey: "PvZ - 2 Stargate Phoenix", milestones: { Pylon: 20 } }), 4),
    ]);
    const docs = await recompute();
    const glaives = docs.get(KEY_GLAIVES).timings;
    expect(glaives.samples).toBe(90);
    expect(glaives.users).toBe(6);
    expect(glaives.milestones[0]).toMatchObject({ key: "Pylon", games: 90, median: 10, p75: 30 });
    expect(docs.get("build:after:PvZ:2-stargate-phoenix").timings).toBeNull();
  });

  test("the per-user cap keeps the most recently PLAYED samples, not the last written", async () => {
    // A newest-first backfill writes a user's oldest games last, so capture
    // order (createdAt) is the reverse of play order (playedOn).
    const whale = Array.from({ length: 60 }, (_, i) => sampleRow({
      userHash: "whale",
      playedOn: new Date(NOW_MS - (i + 1) * DAY_MS),
      createdAt: new Date(NOW_MS - (60 - i) * 1000),
      milestones: { Pylon: 100 + i },
    }));
    await db.guideSamples.insertMany([...whale, ...samples(20, () => ({ milestones: { Pylon: 100 } }), 4)]);
    const { timings } = (await recompute()).get(KEY_GLAIVES);
    // Kept: whale i = 0..49 (+ 20 others at 100) → 21 × 100, then 101..149.
    expect(timings).toMatchObject({ samples: 70, users: 5 });
    expect(timings.milestones[0]).toMatchObject({ key: "Pylon", games: 70, median: 114.5 });
  });

  test("equal play days break ties by gameHash, identically on every run", async () => {
    const day = new Date(NOW_MS - DAY_MS);
    const createdAt = new Date(NOW_MS);
    const whale = Array.from({ length: 60 }, (_, i) => sampleRow({
      userHash: "whale",
      gameHash: `gh-tie-${String(i).padStart(2, "0")}`,
      playedOn: day,
      createdAt,
      milestones: { Pylon: 100 + i },
    }));
    await db.guideSamples.insertMany([...whale, ...samples(20, () => ({ milestones: { Pylon: 100 } }), 4)]);
    const first = (await recompute()).get(KEY_GLAIVES).timings;
    // Kept: the 50 greatest hashes, gh-tie-10..59 → 20 × 100, then 110..159.
    expect(first.milestones[0]).toMatchObject({ games: 70, median: 124.5 });
    expect((await recompute()).get(KEY_GLAIVES).timings).toEqual(first);
  });

  test("rows written before playedOn existed fall back to their capture time", async () => {
    const legacy = Array.from({ length: 60 }, (_, i) => sampleRow({
      userHash: "whale", createdAt: new Date(NOW_MS - i * 1000), milestones: { Pylon: 100 + i },
    }));
    await db.guideSamples.insertMany([...legacy, ...samples(20, () => ({ milestones: { Pylon: 100 } }), 4)]);
    expect((await recompute()).get(KEY_GLAIVES).timings.milestones[0]).toMatchObject({ games: 70, median: 114.5 });
  });

  test("samples are split by era", async () => {
    await db.guideSamples.insertMany([
      ...samples(40, () => ({ milestones: { Pylon: 20 } })),
      ...samples(35, () => ({ era: "before", milestones: { Pylon: 25 } })),
    ]);
    const docs = await recompute();
    expect(docs.get(KEY_GLAIVES).timings.milestones[0]).toMatchObject({ games: 40, median: 20 });
    expect(docs.get("build:before:PvZ:stargate-into-glaives").timings.milestones[0])
      .toMatchObject({ games: 35, median: 25 });
    expect(docs.get(KEY_GLAIVES).buildKey).toBe(GLAIVES);
  });
});
