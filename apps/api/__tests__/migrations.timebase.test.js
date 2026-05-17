// @ts-nocheck
"use strict";

/**
 * Integration test for the 2026-05-17-rescale-timebase migration.
 *
 * Runs the migration against an in-memory MongoDB seeded with broken-
 * scale fixtures across every touched collection and asserts that
 * each documented field gets rewritten correctly. Also covers
 * idempotency (re-runs are no-ops), snapshot creation, and the
 * survived-sentinel remap for died_time.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  SCALE,
  SNAPSHOT_SUFFIX,
  DERIVED_CACHE_COLLECTIONS,
  rescaleSec,
  rescaleBuildLogLine,
  isBrokenScaleGameLength,
  runMigration,
} = require("../src/db/migrations/2026-05-17-rescale-timebase");
const { COLLECTIONS } = require("../src/config/constants");

const USER_A = "user_alpha";
const USER_B = "user_beta";

/** Convert a real mm:ss timestamp back to the broken scale the agent shipped. */
function brokenSec(realSec) {
  return Math.round(realSec / SCALE);
}

describe("rescale timebase migration", () => {
  /** @type {MongoMemoryServer} */
  let mongo;
  /** @type {MongoClient} */
  let client;
  /** @type {import('mongodb').Db} */
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db("test_rescale_timebase");
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    const names = [
      COLLECTIONS.GAMES,
      COLLECTIONS.GAME_DETAILS,
      COLLECTIONS.CUSTOM_BUILDS,
      COLLECTIONS.COMMUNITY_BUILDS,
      `${COLLECTIONS.GAMES}${SNAPSHOT_SUFFIX}`,
      `${COLLECTIONS.GAME_DETAILS}${SNAPSHOT_SUFFIX}`,
      `${COLLECTIONS.CUSTOM_BUILDS}${SNAPSHOT_SUFFIX}`,
      `${COLLECTIONS.COMMUNITY_BUILDS}${SNAPSHOT_SUFFIX}`,
      ...DERIVED_CACHE_COLLECTIONS,
    ];
    for (const n of names) {
      await db.collection(n).deleteMany({});
    }
  });

  /* ---------- pure-helper coverage --------------------------------- */

  test("rescaleSec / rescaleBuildLogLine match the documented anchors", () => {
    // The hero anchor from the prompt: a Nexus at broken-scale 4:57
    // (297s) should render at real 3:32 (212s) after rescaling.
    expect(rescaleSec(297)).toBe(212);
    expect(rescaleBuildLogLine("[4:57] BuildNexus")).toBe("[3:32] BuildNexus");
    // Empty / malformed lines pass through unchanged.
    expect(rescaleBuildLogLine("Beacon Probe")).toBe("Beacon Probe");
    expect(rescaleBuildLogLine("")).toBe("");
    // Negative + NaN inputs collapse to 0.
    expect(rescaleSec(-5)).toBe(0);
    expect(rescaleSec(Number.NaN)).toBe(0);
  });

  test("isBrokenScaleGameLength fires only on the 1.4× signature", () => {
    // Broken-scale: 600 / 429 ≈ 1.4 → true.
    expect(isBrokenScaleGameLength(600, 429)).toBe(true);
    // Already-correct: ratio is 1.0 → false.
    expect(isBrokenScaleGameLength(429, 429)).toBe(false);
    // Edge cases — ratio out of band.
    expect(isBrokenScaleGameLength(700, 429)).toBe(false);
    expect(isBrokenScaleGameLength(500, 429)).toBe(false);
    expect(isBrokenScaleGameLength(429, 0)).toBe(false);
  });

  /* ---------- end-to-end migration --------------------------------- */

  /**
   * Seed two games per user with broken-scale timestamps + matched
   * gameDetails blobs, plus the user's one customBuild and a
   * communityBuild. Returns the realDurationSec map so assertions
   * can use the survived-sentinel target value.
   */
  async function seedFixtures() {
    /** durationSec is the REAL replay length (already-correct). */
    const gamesFixture = [
      {
        userId: USER_A,
        gameId: "g1",
        durationSec: 429,
        buildLog: [
          "[0:14] BuildProbe",
          "[4:57] BuildNexus",
          "[6:00] BuildStargate",
        ],
        oppBuildLog: ["[0:14] BuildDrone", "[5:00] BuildLair"],
        earlyBuildLog: ["[0:14] BuildProbe"],
        oppEarlyBuildLog: ["[0:14] BuildDrone"],
      },
      {
        userId: USER_A,
        gameId: "g2",
        durationSec: 600,
        buildLog: ["[0:00] BuildProbe", "[10:00] BuildGateway"],
        oppBuildLog: ["[0:00] BuildDrone"],
      },
      {
        userId: USER_B,
        gameId: "gb1",
        durationSec: 300,
        buildLog: ["[0:00] BuildSCV", "[7:00] BuildCommandCenter"],
        oppBuildLog: [],
      },
    ];
    await db.collection(COLLECTIONS.GAMES).insertMany(gamesFixture);

    // gameDetails: matched on (userId, gameId). g1 carries a full
    // macroBreakdown with survived bases + apmCurve; g2 is a
    // light blob; gb1 has only buildLog.
    const gd = [
      {
        userId: USER_A,
        gameId: "g1",
        buildLog: gamesFixture[0].buildLog,
        oppBuildLog: gamesFixture[0].oppBuildLog,
        macroBreakdown: {
          // 1.4× durationSec → broken-scale game_length_sec.
          game_length_sec: 600,
          stats_events: [{ time: 0, sq: 80 }, { time: 297, sq: 95 }],
          opp_stats_events: [{ time: 100, sq: 50 }],
          bases: [
            { name: "Nexus", born_time: 0, died_time: 600 }, // survived
            { name: "Nexus", born_time: 297, died_time: 400 }, // died
          ],
          production_buildings: [
            { name: "Gateway", born_time: 100, died_time: 600 }, // survived
            { name: "Stargate", born_time: 300, died_time: 500 }, // died
          ],
          unit_timeline: [{ time: 0, my: {}, opp: {} }, { time: 297, my: {} }],
          ability_events: [{ time: 60, ability: "Chronoboost" }],
          unit_births: [{ time: 14, unit: "Probe" }],
        },
        apmCurve: {
          window_sec: 30,
          has_data: true,
          players: [
            { name: "u_a", race: "Protoss", samples: [{ t: 0, apm: 100 }, { t: 297, apm: 200 }] },
          ],
        },
      },
      {
        userId: USER_A,
        gameId: "g2",
        buildLog: gamesFixture[1].buildLog,
        oppBuildLog: gamesFixture[1].oppBuildLog,
        macroBreakdown: {
          // Already-correct game_length_sec (1:1 with durationSec) —
          // the migration must leave this alone.
          game_length_sec: 600,
          stats_events: [{ time: 100, sq: 70 }],
        },
      },
      {
        userId: USER_B,
        gameId: "gb1",
        buildLog: gamesFixture[2].buildLog,
        oppBuildLog: gamesFixture[2].oppBuildLog,
      },
    ];
    await db.collection(COLLECTIONS.GAME_DETAILS).insertMany(gd);

    // The user's one customBuild — rules[*].time_lt at broken scale.
    await db.collection(COLLECTIONS.CUSTOM_BUILDS).insertMany([
      {
        userId: USER_A,
        slug: "stargate-rush",
        name: "Stargate Rush",
        rules: [
          { type: "exists_at", name: "BuildStargate", time_lt: 360 },
          { type: "count_min", name: "BuildPhoenix", time_lt: 480, count: 2 },
        ],
        // Legacy v2 signature too.
        signature: [{ unit: "Stargate", count: 1, beforeSec: 360 }],
      },
    ]);

    await db.collection(COLLECTIONS.COMMUNITY_BUILDS).insertMany([
      {
        slug: "pvz-skytoss",
        rules: [{ type: "exists_at", name: "BuildFleetBeacon", time_lt: 700 }],
        signature: [{ unit: "FleetBeacon", count: 1, beforeSec: 700 }],
      },
    ]);

    // One derived cache so the drop step exercises a real collection.
    await db.collection("dna_timings").insertOne({ stale: true });

    return {
      realDurationByGame: {
        g1: 429,
        g2: 600,
        gb1: 300,
      },
    };
  }

  test("rewrites every documented field on a single pass", async () => {
    const { realDurationByGame } = await seedFixtures();
    await runMigration(db, { dryRun: false });

    /* games slim row -------------------------------------------------- */
    const g1 = await db
      .collection(COLLECTIONS.GAMES)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(g1.buildLog).toEqual([
      "[0:10] BuildProbe", // 14s → 10s
      "[3:32] BuildNexus", // 4:57 → 3:32
      "[4:17] BuildStargate", // 6:00 → 4:17
    ]);
    expect(g1.oppBuildLog).toEqual([
      "[0:10] BuildDrone",
      "[3:34] BuildLair",
    ]);
    expect(g1.earlyBuildLog).toEqual(["[0:10] BuildProbe"]);
    expect(g1.oppEarlyBuildLog).toEqual(["[0:10] BuildDrone"]);
    expect(g1._timebaseScaledAt).toBeInstanceOf(Date);
    // durationSec MUST be left alone — it was always correct.
    expect(g1.durationSec).toBe(realDurationByGame.g1);

    /* gameDetails heavy blob ----------------------------------------- */
    const gd1 = await db
      .collection(COLLECTIONS.GAME_DETAILS)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(gd1.buildLog).toEqual(g1.buildLog);
    const mb = gd1.macroBreakdown;
    // game_length_sec: 600/429 ≈ 1.4 ⇒ rewrite to durationSec=429.
    expect(mb.game_length_sec).toBe(429);
    // stats_events rescaled (297 → 212).
    expect(mb.stats_events).toEqual([
      { time: 0, sq: 80 },
      { time: 212, sq: 95 },
    ]);
    expect(mb.opp_stats_events).toEqual([{ time: 71, sq: 50 }]);
    // Survived bases / production_buildings → died_time = realDurationSec.
    expect(mb.bases[0].died_time).toBe(realDurationByGame.g1);
    expect(mb.bases[0].born_time).toBe(0);
    // Died-mid-game base: died_time rescaled normally.
    expect(mb.bases[1].born_time).toBe(rescaleSec(297));
    expect(mb.bases[1].died_time).toBe(rescaleSec(400));
    expect(mb.production_buildings[0].died_time).toBe(realDurationByGame.g1);
    expect(mb.production_buildings[1].died_time).toBe(rescaleSec(500));
    // unit_timeline / ability_events / unit_births.
    expect(mb.unit_timeline[0].time).toBe(0);
    expect(mb.unit_timeline[1].time).toBe(rescaleSec(297));
    expect(mb.ability_events[0].time).toBe(rescaleSec(60));
    expect(mb.unit_births[0].time).toBe(rescaleSec(14));
    // apmCurve samples rescaled, rates untouched.
    expect(gd1.apmCurve.players[0].samples).toEqual([
      { t: 0, apm: 100 },
      { t: rescaleSec(297), apm: 200 },
    ]);

    // g2: game_length_sec was already correct (600 == durationSec),
    // so we LEAVE it alone.
    const gd2 = await db
      .collection(COLLECTIONS.GAME_DETAILS)
      .findOne({ userId: USER_A, gameId: "g2" });
    expect(gd2.macroBreakdown.game_length_sec).toBe(600);
    expect(gd2.macroBreakdown.stats_events).toEqual([
      { time: rescaleSec(100), sq: 70 },
    ]);

    /* customBuilds --------------------------------------------------- */
    const cb = await db
      .collection(COLLECTIONS.CUSTOM_BUILDS)
      .findOne({ userId: USER_A, slug: "stargate-rush" });
    expect(cb.rules[0].time_lt).toBe(rescaleSec(360));
    expect(cb.rules[1].time_lt).toBe(rescaleSec(480));
    expect(cb.signature[0].beforeSec).toBe(rescaleSec(360));

    /* communityBuilds ------------------------------------------------ */
    const cmb = await db
      .collection(COLLECTIONS.COMMUNITY_BUILDS)
      .findOne({ slug: "pvz-skytoss" });
    expect(cmb.rules[0].time_lt).toBe(rescaleSec(700));
    expect(cmb.signature[0].beforeSec).toBe(rescaleSec(700));

    /* derived caches dropped ---------------------------------------- */
    const after = await db
      .listCollections({ name: "dna_timings" }, { nameOnly: true })
      .toArray();
    expect(after).toHaveLength(0);
  });

  test("creates snapshot collections before rewriting", async () => {
    await seedFixtures();
    await runMigration(db);

    const games = await db
      .collection(`${COLLECTIONS.GAMES}${SNAPSHOT_SUFFIX}`)
      .countDocuments({});
    expect(games).toBe(3);

    const details = await db
      .collection(`${COLLECTIONS.GAME_DETAILS}${SNAPSHOT_SUFFIX}`)
      .countDocuments({});
    expect(details).toBe(3);

    // Snapshot preserves the pre-migration (broken-scale) state. The
    // hero anchor should still read 4:57 in the snapshot.
    const snap = await db
      .collection(`${COLLECTIONS.GAMES}${SNAPSHOT_SUFFIX}`)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(snap.buildLog).toContain("[4:57] BuildNexus");
    // And neither snapshot copy was stamped with _timebaseScaledAt.
    expect(snap._timebaseScaledAt).toBeUndefined();

    const cb = await db
      .collection(`${COLLECTIONS.CUSTOM_BUILDS}${SNAPSHOT_SUFFIX}`)
      .countDocuments({});
    expect(cb).toBe(1);
    const cmb = await db
      .collection(`${COLLECTIONS.COMMUNITY_BUILDS}${SNAPSHOT_SUFFIX}`)
      .countDocuments({});
    expect(cmb).toBe(1);
  });

  test("re-running is a no-op (idempotency fence on _timebaseScaledAt)", async () => {
    await seedFixtures();
    const first = await runMigration(db);
    expect(first.games.planned).toBeGreaterThan(0);
    expect(first.gameDetails.planned).toBeGreaterThan(0);
    expect(first.customBuilds.planned).toBe(1);
    expect(first.communityBuilds.planned).toBe(1);

    const second = await runMigration(db);
    expect(second.games.planned).toBe(0);
    expect(second.games.written).toBe(0);
    expect(second.gameDetails.planned).toBe(0);
    expect(second.gameDetails.written).toBe(0);
    expect(second.customBuilds.planned).toBe(0);
    expect(second.communityBuilds.planned).toBe(0);

    // And the hero timestamp must still be the once-rescaled value,
    // never double-rescaled. 297 → 212 → 152 would be the bug.
    const g1 = await db
      .collection(COLLECTIONS.GAMES)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(g1.buildLog).toContain("[3:32] BuildNexus");
  });

  test("dry-run reports counts without writing", async () => {
    await seedFixtures();
    const out = await runMigration(db, { dryRun: true });
    expect(out.games.planned).toBe(3);
    expect(out.gameDetails.planned).toBe(3);
    expect(out.customBuilds.planned).toBe(1);
    expect(out.communityBuilds.planned).toBe(1);

    // Source data untouched.
    const g1 = await db
      .collection(COLLECTIONS.GAMES)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(g1.buildLog).toContain("[4:57] BuildNexus");
    expect(g1._timebaseScaledAt).toBeUndefined();

    // Derived cache still present.
    const dna = await db
      .listCollections({ name: "dna_timings" }, { nameOnly: true })
      .toArray();
    expect(dna).toHaveLength(1);
  });

  test("--user scopes rewrites to one user; other users untouched", async () => {
    await seedFixtures();
    await runMigration(db, { user: USER_A });
    const userA = await db
      .collection(COLLECTIONS.GAMES)
      .findOne({ userId: USER_A, gameId: "g1" });
    expect(userA._timebaseScaledAt).toBeInstanceOf(Date);
    const userB = await db
      .collection(COLLECTIONS.GAMES)
      .findOne({ userId: USER_B, gameId: "gb1" });
    expect(userB._timebaseScaledAt).toBeUndefined();
    expect(userB.buildLog).toContain("[7:00] BuildCommandCenter");
  });

  test("broken-scale anchor: brokenSec round-trip helper matches expected scale", () => {
    // Defensive: confirm the test's broken-scale helper undoes
    // rescaleSec to the documented anchor.
    expect(brokenSec(212)).toBe(297);
  });
});
