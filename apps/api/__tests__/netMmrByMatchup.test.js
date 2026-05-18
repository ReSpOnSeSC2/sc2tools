// @ts-nocheck
"use strict";

/**
 * netMmrByMatchup — real-Mongo integration tests for the Net-MMR-by-
 * matchup chart on the Trends tab.
 *
 * Pins the regression where a player could see "100% WR vs Protoss"
 * sit on a -213 net-MMR bar (see Screenshot_20260516). The chart
 * runs over consecutive game pairs in the FILTERED set, and pairs
 * that skip across hours of unrecorded games used to absorb that
 * drift into one matchup. The guards in trendsInsights.js drop
 * those pairs so the displayed total can never disagree with the
 * win/loss column next to it.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const {
  NET_MMR_MAX_GAP_MS,
  NET_MMR_MAX_DELTA,
} = require("../src/services/trendsInsights");

describe("services/trendsInsights.netMmrByMatchup", () => {
  let mongo;
  let db;
  let svc;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "net_mmr_test" });
    svc = new AggregationsService(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  const MIN_AGO = 60 * 1000;

  function makeGame(overrides) {
    return {
      userId: "u1",
      gameId: `${overrides.gameId || Math.random()}`,
      date: new Date("2026-05-09T12:00:00Z"),
      result: "Victory",
      myRace: "Protoss",
      myBuild: "Protoss - Robo Opener",
      myMmr: 4500,
      map: "Hard Lead LE",
      durationSec: 620,
      opponent: {
        pulseId: "1-S2-1-1",
        toonHandle: "1-S2-1-1",
        displayName: "Foe",
        race: "Zerg",
        mmr: 4500,
        strategy: "Zerg - Hatch First",
      },
      ...overrides,
    };
  }

  function findRow(matchups, race) {
    return matchups.find((m) => m.race === race);
  }

  test("back-to-back wins vs Protoss come out net-positive", async () => {
    // Three wins vs Protoss, all in the same session (≈5 min apart),
    // each climbing the ladder by +25 MMR. The fourth (Zerg) game
    // is also a win but only exists to give the third Protoss game
    // a "next" reading.
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "p1",
        date: new Date(t0 + 0 * MIN_AGO),
        myMmr: 4500,
        result: "Victory",
        opponent: { race: "Protoss", mmr: 4500 },
      }),
      makeGame({
        gameId: "p2",
        date: new Date(t0 + 10 * MIN_AGO),
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Protoss", mmr: 4525 },
      }),
      makeGame({
        gameId: "p3",
        date: new Date(t0 + 20 * MIN_AGO),
        myMmr: 4550,
        result: "Victory",
        opponent: { race: "Protoss", mmr: 4550 },
      }),
      makeGame({
        gameId: "z1",
        date: new Date(t0 + 30 * MIN_AGO),
        myMmr: 4575,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 4575 },
      }),
    ]);

    const { matchups } = await svc.netMmrByMatchup("u1", {});
    const p = findRow(matchups, "P");
    expect(p).toBeDefined();
    expect(p.games).toBe(3);
    expect(p.wins).toBe(3);
    expect(p.losses).toBe(0);
    expect(p.winRate).toBeCloseTo(1);
    // Three +25-MMR climbs.
    expect(p.netMmr).toBe(75);
    expect(p.avgDelta).toBeCloseTo(25);
  });

  test(
    "regression: a 100% WR matchup never reads net-negative when " +
      "earlier deltas were inflated by an unrecorded ladder run",
    async () => {
      // The bug: three wins vs Protoss attributed -213 MMR because
      // the "next game" the API used to land its delta on was hours
      // later (a fresh session) and skipped over a stack of losses
      // the older agent didn't tag with myMmr.
      //
      // We reproduce it by spacing the Protoss games across MORE
      // THAN NET_MMR_MAX_GAP_MS with a steep MMR decline between
      // them — the kind of trace an agent missing myMmr on the
      // intervening games leaves behind. With the gap+magnitude
      // guard, none of those pairs should land on the Protoss bar.
      //
      // Spacing scales off the constant so a v0.7.x-style relaxation
      // of NET_MMR_MAX_GAP_MS (24 h instead of 6 h) doesn't quietly
      // turn the regression test green.
      const t0 = new Date("2026-05-09T12:00:00Z").getTime();
      const PAIR_GAP = NET_MMR_MAX_GAP_MS + 60 * 60 * 1000;
      await db.games.insertMany([
        makeGame({
          gameId: "p_day1",
          date: new Date(t0 + 0),
          myMmr: 4800,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4800 },
        }),
        // ... a long break with no myMmr lands the user 100 MMR
        // lower, but the next recorded reading is past the gap cap.
        makeGame({
          gameId: "p_day2",
          date: new Date(t0 + 1 * PAIR_GAP),
          myMmr: 4700,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4700 },
        }),
        makeGame({
          gameId: "p_day3",
          date: new Date(t0 + 2 * PAIR_GAP),
          myMmr: 4600,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4600 },
        }),
        // Closing game so day3 has a "next".
        makeGame({
          gameId: "p_day4",
          date: new Date(t0 + 3 * PAIR_GAP),
          myMmr: 4500,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4500 },
        }),
      ]);

      const { matchups, dropped } = await svc.netMmrByMatchup("u1", {});
      const p = findRow(matchups, "P");
      // Every pair sits beyond NET_MMR_MAX_GAP_MS so the row is
      // dropped entirely — better than reporting a number the user
      // can't reconcile with their own W/L record. The diagnostic
      // counter still reflects the three dropped pairs so the chart
      // can render "3 pairs hidden: 3 long gaps".
      expect(p).toBeUndefined();
      expect(dropped.longGap).toBe(3);
    },
  );

  test(
    "region partitioning prevents an NA → EU switch from faking a phantom loss",
    async () => {
      // Two consecutive games on different regions used to chain
      // into a single delta — a streamer at 4900 NA who logged into
      // EU at 3500 would see a ~-1400 phantom loss attributed to
      // whichever matchup happened to bridge the regions. Region
      // partitioning short-circuits that: the EU game doesn't even
      // see the NA game as its "previous".
      const t0 = new Date("2026-05-09T12:00:00Z").getTime();
      await db.games.insertMany([
        makeGame({
          gameId: "na1",
          date: new Date(t0),
          myToonHandle: "1-S2-1-100",
          myMmr: 4900,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 4900, toonHandle: "1-S2-1-101" },
        }),
        makeGame({
          gameId: "na2",
          date: new Date(t0 + 5 * MIN_AGO),
          myToonHandle: "1-S2-1-100",
          myMmr: 4925,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 4925, toonHandle: "1-S2-1-102" },
        }),
        // Region switch — EU pulseId, different ladder rating.
        makeGame({
          gameId: "eu1",
          date: new Date(t0 + 10 * MIN_AGO),
          myToonHandle: "2-S2-1-300",
          myMmr: 3500,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 3500, toonHandle: "2-S2-1-301" },
        }),
        makeGame({
          gameId: "eu2",
          date: new Date(t0 + 15 * MIN_AGO),
          myToonHandle: "2-S2-1-300",
          myMmr: 3520,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 3520, toonHandle: "2-S2-1-302" },
        }),
      ]);
      const { matchups } = await svc.netMmrByMatchup("u1", {});
      const z = findRow(matchups, "Z");
      expect(z).toBeDefined();
      // Two valid pairs: na1→na2 (+25 NA) and eu1→eu2 (+20 EU).
      // The na2→eu1 hop is suppressed by the partition, so the
      // chart reads +45 instead of (+25 − 1425 + 20) = −1380.
      expect(z.games).toBe(2);
      expect(z.netMmr).toBe(45);
      expect(z.winRate).toBeCloseTo(1);
    },
  );

  test("a wide gap inside the same race-pool is dropped", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      // Pair 1 — tight gap, valid.
      makeGame({
        gameId: "z1",
        date: new Date(t0 + 0),
        myMmr: 4500,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 4500 },
      }),
      makeGame({
        gameId: "z2",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 4525 },
      }),
      // Pair 2 — gap one minute past the cap. Must be dropped.
      makeGame({
        gameId: "z3",
        date: new Date(t0 + 5 * MIN_AGO + NET_MMR_MAX_GAP_MS + MIN_AGO),
        myMmr: 4525 - 80,
        result: "Defeat",
        opponent: { race: "Zerg", mmr: 4525 },
      }),
    ]);
    const { matchups } = await svc.netMmrByMatchup("u1", {});
    const z = findRow(matchups, "Z");
    expect(z).toBeDefined();
    // Only z1→z2 survives; z2→z3 fails the gap guard.
    expect(z.games).toBe(1);
    expect(z.netMmr).toBe(25);
  });

  test("oversized swings (race-pool switch, season reset) are dropped", async () => {
    // Two same-session Terran games on a 4500 ladder, then a switch
    // into a Random ladder rated 3000 — the next pair would land a
    // delta of -1500 on the second Terran game's matchup if we let
    // it through. The magnitude guard drops it.
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "t1",
        date: new Date(t0),
        myRace: "Terran",
        myMmr: 4500,
        result: "Victory",
        opponent: { race: "Terran", mmr: 4500 },
      }),
      makeGame({
        gameId: "t2",
        date: new Date(t0 + 5 * MIN_AGO),
        myRace: "Terran",
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Terran", mmr: 4525 },
      }),
      // Race switch into Random with a sub-NET_MMR_MAX_GAP_MS gap.
      makeGame({
        gameId: "r1",
        date: new Date(t0 + 10 * MIN_AGO),
        myRace: "Random",
        myMmr: 3000,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 3000 },
      }),
    ]);
    const { matchups } = await svc.netMmrByMatchup("u1", {});
    const t = findRow(matchups, "T");
    expect(t).toBeDefined();
    // t1→t2 is +25 and attributed to Terran. t2→r1 is -1525,
    // exceeds NET_MMR_MAX_DELTA, and must NOT show up on the
    // Terran bar.
    expect(t.games).toBe(1);
    expect(t.netMmr).toBe(25);
    expect(NET_MMR_MAX_DELTA).toBeGreaterThan(60);
  });

  test("displayed WR comes from the same cohort that produced netMmr", async () => {
    // 2 wins + 1 loss vs Zerg. The loss is the LAST chronological
    // Z game so its pair is z_loss → (no next): excluded. The two
    // wins produce one valid pair (win→win), one excluded (win→loss
    // pair survives if z_loss has a "next" — give it one). Verify
    // games / wins / WR all reflect the surviving pairs only.
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "z_w1",
        date: new Date(t0),
        myMmr: 4500,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 4500 },
      }),
      makeGame({
        gameId: "z_w2",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 4525 },
      }),
      makeGame({
        gameId: "z_loss",
        date: new Date(t0 + 10 * MIN_AGO),
        myMmr: 4550,
        result: "Defeat",
        opponent: { race: "Zerg", mmr: 4550 },
      }),
      makeGame({
        gameId: "closer",
        date: new Date(t0 + 15 * MIN_AGO),
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Terran", mmr: 4525 },
      }),
    ]);
    const { matchups } = await svc.netMmrByMatchup("u1", {});
    const z = findRow(matchups, "Z");
    expect(z).toBeDefined();
    expect(z.games).toBe(3);
    expect(z.wins).toBe(2);
    expect(z.losses).toBe(1);
    expect(z.winRate).toBeCloseTo(2 / 3);
    // z_w1 → z_w2: +25 (Z). z_w2 → z_loss: +25 (Z). z_loss → closer: -25 (Z).
    expect(z.netMmr).toBe(25);
  });

  test("returns an empty list when nothing carries myMmr", async () => {
    await db.games.insertMany([
      makeGame({ gameId: "g1", myMmr: null }),
      makeGame({ gameId: "g2", myMmr: null }),
    ]);
    const { matchups } = await svc.netMmrByMatchup("u1", {});
    expect(matchups).toEqual([]);
  });
});
