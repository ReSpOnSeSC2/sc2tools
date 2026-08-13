// @ts-nocheck
"use strict";

/**
 * netMmrByMatchup — real-Mongo integration tests for the Net-MMR-by-
 * matchup chart on the Trends tab. Pairing is calculated over complete
 * stored history before display filters, then guarded by replay provenance,
 * account/ladder identity, result sign, and a delta cap. Database adjacency
 * cannot prove that an entirely absent replay never existed; that limitation
 * is documented in the chart copy rather than hidden behind a time-gap guess.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { AggregationsService } = require("../src/services/aggregations");
const { NET_MMR_MAX_DELTA } = require("../src/services/trendsInsights");

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
      myLadderRace: "Protoss",
      myBuild: "Protoss - Robo Opener",
      myMmr: 4500,
      myMmrSource: "replay",
      myToonHandle: "1-S2-1-100",
      isLadderGame: true,
      playerCount: 2,
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
    "MMR moves whose sign contradicts the result are quarantined",
    async () => {
      // v0.5.x used to drop pairs spaced beyond a session cap so a
      // 100%-WR matchup could never read net-negative. The user
      // explicitly asked for those pairs to count now: region
      // partitioning kills the worst noise (cross-region log-ins)
      // and the SC2Pulse current-MMR card on the dashboard
      // reconciles the running totals, so any drift within a region
      // is a real ladder change the chart should attribute to the
      // last matchup played.
      //
      // Four wins vs Protoss spaced multiple days apart with a 100
      // MMR slide between each one: a season-long climb-down. All
      // three pairs survive — −300 net, 100% WR. Surprising on its
      // face but the chart is now honest about what happened on
      // the ladder.
      const t0 = new Date("2026-05-09T12:00:00Z").getTime();
      const PAIR_GAP = 3 * 24 * 60 * 60 * 1000;
      await db.games.insertMany([
        makeGame({
          gameId: "p_day1",
          date: new Date(t0 + 0),
          myMmr: 4800,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4800 },
        }),
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
        makeGame({
          gameId: "p_day4",
          date: new Date(t0 + 3 * PAIR_GAP),
          myMmr: 4500,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4500 },
        }),
      ]);

      const out = await svc.netMmrByMatchup("u1", {});
      expect(findRow(out.matchups, "P")).toBeUndefined();
      expect(out.dropped.signMismatch).toBe(3);
      expect(out.dropped.outlierSwing).toBe(0);
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

  test("multiple selected servers sum independently paired per-server totals", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "na1",
        date: new Date(t0),
        myToonHandle: "1-S2-1-100",
        myMmr: 4000,
        result: "Victory",
        opponent: {
          race: "Zerg",
          region: "NA",
          toonHandle: "1-S2-1-101",
        },
      }),
      // Chronologically interleaved EU game with a deliberately similar MMR.
      // If servers shared one window, these rows could form plausible-looking
      // (sub-150) but incorrect deltas instead of obvious outliers.
      makeGame({
        gameId: "eu1",
        date: new Date(t0 + MIN_AGO),
        myToonHandle: "2-S2-1-200",
        myMmr: 4010,
        result: "Defeat",
        opponent: {
          race: "Zerg",
          region: "EU",
          toonHandle: "2-S2-1-201",
        },
      }),
      makeGame({
        gameId: "na2",
        date: new Date(t0 + 2 * MIN_AGO),
        myToonHandle: "1-S2-1-100",
        myMmr: 4020,
        result: "Victory",
        opponent: {
          race: "Zerg",
          region: "NA",
          toonHandle: "1-S2-1-102",
        },
      }),
      makeGame({
        gameId: "eu2",
        date: new Date(t0 + 3 * MIN_AGO),
        myToonHandle: "2-S2-1-200",
        myMmr: 3990,
        result: "Victory",
        opponent: {
          race: "Zerg",
          region: "EU",
          toonHandle: "2-S2-1-202",
        },
      }),
    ]);

    const [combined, naOnly, euOnly] = await Promise.all([
      svc.netMmrByMatchup("u1", { regions: ["NA", "EU"] }),
      svc.netMmrByMatchup("u1", { regions: ["NA"] }),
      svc.netMmrByMatchup("u1", { regions: ["EU"] }),
    ]);
    const combinedZ = findRow(combined.matchups, "Z");
    const naZ = findRow(naOnly.matchups, "Z");
    const euZ = findRow(euOnly.matchups, "Z");

    expect(naZ).toMatchObject({ netMmr: 20, pairs: 1, wins: 1, losses: 0 });
    expect(euZ).toMatchObject({ netMmr: -20, pairs: 1, wins: 0, losses: 1 });
    expect(combinedZ.netMmr).toBe(naZ.netMmr + euZ.netMmr);
    expect(combinedZ.pairs).toBe(naZ.pairs + euZ.pairs);
    expect(combinedZ).toMatchObject({ netMmr: 0, pairs: 2 });
    expect(combined.dropped.terminalGame).toBe(2);
  });

  test("75 filtered Zerg games reconcile to 66 measured across nine MMR sequences", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    const raceNames = ["Protoss", "Terran", "Zerg"];
    const games = [];

    for (let partition = 0; partition < 9; partition++) {
      const size = partition < 3 ? 9 : 8;
      const ladderRace = raceNames[partition % raceNames.length];
      for (let game = 0; game < size; game++) {
        games.push(makeGame({
          gameId: `partition-${partition}-game-${game}`,
          date: new Date(t0 + (game * 9 + partition) * MIN_AGO),
          myRace: ladderRace,
          myLadderRace: ladderRace,
          myToonHandle: `${1 + (partition % 3)}-S2-1-${1000 + partition}`,
          myMmr: 4000 + partition * 100 + game * 10,
          result: "Victory",
          opponent: { race: "Zerg" },
        }));
      }
    }
    await db.games.insertMany(games);

    const [list, net] = await Promise.all([
      svc.gamesList("u1", { oppRace: "Z" }, { limit: 5000 }),
      svc.netMmrByMatchup("u1", { oppRace: "Z" }),
    ]);
    const zerg = findRow(net.matchups, "Z");
    const zergCoverage = findRow(net.coverage, "Z");

    expect(list.total).toBe(75);
    expect(net.totalGames).toBe(75);
    expect(net.eligibleGames).toBe(75);
    expect(zerg).toMatchObject({ pairs: 66, wins: 66, losses: 0 });
    expect(zergCoverage).toMatchObject({
      totalGames: 75,
      eligibleGames: 75,
      measuredGames: 66,
      dropped: { terminalGame: 9 },
    });
    expect(net.dropped).toEqual({
      excludedNonRanked1v1: 0,
      missingIdentity: 0,
      missingMyMmr: 0,
      untrustedMyMmr: 0,
      terminalGame: 9,
      nextMissingMyMmr: 0,
      nextUntrustedMyMmr: 0,
      outlierSwing: 0,
      signMismatch: 0,
      unsupportedResult: 0,
    });
  });

  test("coverage reasons are mutually exclusive for ineligible missing-MMR games", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "ranked-1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "ranked-2",
        date: new Date(t0 + MIN_AGO),
        myMmr: 4510,
      }),
      makeGame({
        gameId: "custom-missing",
        date: new Date(t0 + 2 * MIN_AGO),
        myMmr: null,
        myMmrSource: "unavailable",
        isLadderGame: false,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", { oppRace: "Z" });
    const zerg = findRow(out.matchups, "Z");
    const coverage = findRow(out.coverage, "Z");

    expect(zerg.pairs).toBe(1);
    expect(coverage).toMatchObject({
      totalGames: 3,
      eligibleGames: 2,
      measuredGames: 1,
      dropped: {
        excludedNonRanked1v1: 1,
        missingMyMmr: 0,
        terminalGame: 1,
      },
    });
    expect(out.dropped.excludedNonRanked1v1).toBe(1);
    expect(out.dropped.missingMyMmr).toBe(0);
    expect(out.dropped.terminalGame).toBe(1);
  });

  test(
    "long gaps inside the same race-pool now count — only the " +
      "±150 delta cap filters outliers",
    async () => {
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const t0 = new Date("2026-05-09T12:00:00Z").getTime();
      await db.games.insertMany([
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
        // 2-day gap that the old session cap would have dropped. It remains
        // a valid adjacent stored-replay reading when the result sign and
        // delta are credible; elapsed time alone cannot prove a replay gap.
        makeGame({
          gameId: "z3",
          date: new Date(t0 + 5 * MIN_AGO + 2 * ONE_DAY),
          myMmr: 4550,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 4525 },
        }),
      ]);
      const { matchups, dropped } = await svc.netMmrByMatchup("u1", {});
      const z = findRow(matchups, "Z");
      expect(z).toBeDefined();
      // Both the short z1-to-z2 and two-day z2-to-z3 readings add +25.
      expect(z.games).toBe(2);
      expect(z.netMmr).toBe(50);
      expect(dropped.signMismatch).toBe(0);
      expect(dropped.outlierSwing).toBe(0);
    },
  );

  test("selected ladder race prevents cross-pool swings", async () => {
    // Two same-session Terran games on a 4500 ladder, then a switch
    // into a Random ladder rated 3000 — the next pair would land a
    // delta of -1500 on the second Terran game's matchup if we let
    // it through. Exact ladder-race partitioning prevents the pair.
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "t1",
        date: new Date(t0),
        myRace: "Terran",
        myLadderRace: "Terran",
        myMmr: 4500,
        result: "Victory",
        opponent: { race: "Terran", mmr: 4500 },
      }),
      makeGame({
        gameId: "t2",
        date: new Date(t0 + 5 * MIN_AGO),
        myRace: "Terran",
        myLadderRace: "Terran",
        myMmr: 4525,
        result: "Victory",
        opponent: { race: "Terran", mmr: 4525 },
      }),
      // Race switch into the separately-rated Random ladder.
      makeGame({
        gameId: "r1",
        date: new Date(t0 + 10 * MIN_AGO),
        myRace: "Random",
        myLadderRace: "Random",
        myMmr: 3000,
        result: "Victory",
        opponent: { race: "Zerg", mmr: 3000 },
      }),
    ]);
    const { matchups } = await svc.netMmrByMatchup("u1", {});
    const t = findRow(matchups, "T");
    expect(t).toBeDefined();
    // t1→t2 is +25 and attributed to Terran. t2 and r1 never pair.
    expect(t.games).toBe(1);
    expect(t.netMmr).toBe(25);
    expect(NET_MMR_MAX_DELTA).toBeGreaterThan(60);
  });

  test("oversized swings inside one ladder are counted as outliers", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "g1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "g2",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: 4700,
      }),
      makeGame({
        gameId: "g3",
        date: new Date(t0 + 10 * MIN_AGO),
        myMmr: 4725,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {});
    const z = findRow(out.matchups, "Z");
    expect(z.games).toBe(1);
    expect(z.netMmr).toBe(25);
    expect(out.dropped.outlierSwing).toBe(1);
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
    const { matchups, totalGames, dropped } = await svc.netMmrByMatchup(
      "u1",
      {},
    );
    expect(matchups).toEqual([]);
    // Two games show up in the filtered set, both missing myMmr —
    // chart can render "0 pairs from 2 games · 2 missing MMR".
    expect(totalGames).toBe(2);
    expect(dropped.missingMyMmr).toBe(2);
  });

  test(
    "diagnostic counters explain why pair count < game count " +
      "(missing-myMmr games are visible)",
    async () => {
      // Bug repro: Win-Rate-by-MMR chart shows 28 games (it uses the
      // opp-mmr fallback), Net-MMR-by-matchup shows only ~13 pairs.
      // The disparity has to be legible: games without ``myMmr`` are
      // the dominant reason, and the chart now surfaces that count
      // so the user doesn't think the chart is broken.
      const t0 = new Date("2026-05-09T12:00:00Z").getTime();
      await db.games.insertMany([
        // Three myMmr-tagged games on NA → two valid pairs vs Zerg.
        makeGame({
          gameId: "z1",
          date: new Date(t0 + 0 * MIN_AGO),
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
        makeGame({
          gameId: "z3",
          date: new Date(t0 + 10 * MIN_AGO),
          myMmr: 4550,
          result: "Victory",
          opponent: { race: "Zerg", mmr: 4550 },
        }),
        // Two ranked games WITHOUT myMmr (older agent versions): they
        // appear in Win-Rate-by-MMR but can never form a pair.
        makeGame({
          gameId: "no_mmr_1",
          date: new Date(t0 + 20 * MIN_AGO),
          myMmr: null,
          result: "Defeat",
          opponent: { race: "Terran", mmr: 4540 },
        }),
        makeGame({
          gameId: "no_mmr_2",
          date: new Date(t0 + 25 * MIN_AGO),
          myMmr: null,
          result: "Victory",
          opponent: { race: "Protoss", mmr: 4530 },
        }),
      ]);
      const out = await svc.netMmrByMatchup("u1", {});
      // 5 filtered games, 2 missing myMmr, 2 surviving pairs (z1→z2,
      // z2→z3). The disparity (5 games vs 2 pairs) is now visible in
      // the response and the chart can render the "why".
      expect(out.totalGames).toBe(5);
      expect(out.dropped.missingMyMmr).toBe(2);
      const z = findRow(out.matchups, "Z");
      expect(z).toBeDefined();
      expect(z.games).toBe(2);
    },
  );

  test("a missing-MMR replay breaks adjacency instead of being skipped", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "g1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "g2_missing",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: null,
        myMmrSource: "unavailable",
      }),
      makeGame({
        gameId: "g3",
        date: new Date(t0 + 10 * MIN_AGO),
        myMmr: 4550,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {});
    expect(out.matchups).toEqual([]);
    expect(out.dropped.missingMyMmr).toBe(1);
    expect(out.dropped.nextMissingMyMmr).toBe(1);
    expect(out.dailySwings).toMatchObject({
      bestGain: null,
      biggestLoss: null,
      measuredDays: 0,
      measuredGames: 0,
    });
  });

  test("numeric MMR without replay provenance is quarantined", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    const first = makeGame({ gameId: "legacy1", date: new Date(t0) });
    const second = makeGame({
      gameId: "legacy2",
      date: new Date(t0 + 5 * MIN_AGO),
      myMmr: 4525,
    });
    delete first.myMmrSource;
    delete second.myMmrSource;
    await db.games.insertMany([first, second]);

    const out = await svc.netMmrByMatchup("u1", {});
    expect(out.matchups).toEqual([]);
    expect(out.dropped.untrustedMyMmr).toBe(2);
  });

  test("opponent filters apply to anchors after adjacency is computed", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "z1",
        date: new Date(t0),
        myMmr: 4500,
        opponent: { race: "Zerg" },
      }),
      makeGame({
        gameId: "p1",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: 4525,
        opponent: { race: "Protoss" },
      }),
      makeGame({
        gameId: "z2",
        date: new Date(t0 + 10 * MIN_AGO),
        myMmr: 4550,
        opponent: { race: "Zerg" },
      }),
      makeGame({
        gameId: "t1",
        date: new Date(t0 + 15 * MIN_AGO),
        myMmr: 4575,
        opponent: { race: "Terran" },
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", { oppRace: "Z" });
    const z = findRow(out.matchups, "Z");
    expect(z.games).toBe(2);
    expect(z.netMmr).toBe(50);
    expect(z.avgDelta).toBe(25);
  });

  test("the last game inside a date filter can use the next replay", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "inside", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "outside",
        date: new Date(t0 + 5 * MIN_AGO),
        myMmr: 4525,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {
      until: new Date(t0 + MIN_AGO),
    });
    expect(out.totalGames).toBe(1);
    expect(findRow(out.matchups, "Z").netMmr).toBe(25);
  });

  test("same-region accounts never pair with each other", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "a1",
        date: new Date(t0),
        myToonHandle: "1-S2-1-100",
        myMmr: 4500,
      }),
      makeGame({
        gameId: "b1",
        date: new Date(t0 + MIN_AGO),
        myToonHandle: "1-S2-1-200",
        myMmr: 4520,
      }),
      makeGame({
        gameId: "a2",
        date: new Date(t0 + 2 * MIN_AGO),
        myToonHandle: "1-S2-1-100",
        myMmr: 4525,
      }),
      makeGame({
        gameId: "b2",
        date: new Date(t0 + 3 * MIN_AGO),
        myToonHandle: "1-S2-1-200",
        myMmr: 4540,
      }),
    ]);

    const z = findRow((await svc.netMmrByMatchup("u1", {})).matchups, "Z");
    expect(z.games).toBe(2);
    expect(z.netMmr).toBe(45);
  });

  test("custom and team games neither count nor contaminate 1v1 pairs", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "ladder1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "custom",
        date: new Date(t0 + MIN_AGO),
        myMmr: 5000,
        isLadderGame: false,
      }),
      makeGame({
        gameId: "team",
        date: new Date(t0 + 2 * MIN_AGO),
        myMmr: 4000,
        playerCount: 4,
      }),
      makeGame({
        gameId: "ladder2",
        date: new Date(t0 + 3 * MIN_AGO),
        myMmr: 4525,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {});
    expect(out.totalGames).toBe(4);
    expect(out.eligibleGames).toBe(2);
    expect(out.dropped.excludedNonRanked1v1).toBe(2);
    expect(findRow(out.matchups, "Z").netMmr).toBe(25);
  });

  test("resumed replay artifacts neither count nor break real MMR adjacency", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "ladder1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "resume-test",
        date: new Date(t0 + MIN_AGO),
        myMmr: 4510,
        isResumedFromReplay: true,
      }),
      makeGame({
        gameId: "ladder2",
        date: new Date(t0 + 2 * MIN_AGO),
        myMmr: 4525,
      }),
      makeGame({
        gameId: "ladder3",
        date: new Date(t0 + 3 * MIN_AGO),
        myMmr: 4550,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {});
    const z = findRow(out.matchups, "Z");
    expect(out.totalGames).toBe(3);
    expect(z.games).toBe(2);
    expect(z.netMmr).toBe(50);
  });

  test("daily swings use local anchor days, sum independent ladders, and prefer the latest tie", async () => {
    const docs = [];
    const addPair = ({
      prefix,
      handle,
      anchorDate,
      nextDate,
      startMmr,
      delta,
      map = "Hard Lead LE",
    }) => {
      docs.push(
        makeGame({
          gameId: `${prefix}-anchor`,
          date: new Date(anchorDate),
          myToonHandle: handle,
          myMmr: startMmr,
          result: delta < 0 ? "Defeat" : "Victory",
          map,
        }),
        makeGame({
          gameId: `${prefix}-next`,
          date: new Date(nextDate),
          myToonHandle: handle,
          myMmr: startMmr + delta,
          map,
        }),
      );
    };

    // America/New_York still sees 03:30Z on May 10 as May 9. Its
    // next reading crosses local midnight, but the +25 belongs to the
    // anchor replay's May 9 record.
    addPair({
      prefix: "a",
      handle: "1-S2-1-201",
      anchorDate: "2026-05-10T03:30:00Z",
      nextDate: "2026-05-10T04:10:00Z",
      startMmr: 4000,
      delta: 25,
    });
    // A second account contributes another +25 to the same selected day,
    // while account-aware partitioning prevents the two ladders pairing.
    addPair({
      prefix: "b",
      handle: "1-S2-1-202",
      anchorDate: "2026-05-09T20:00:00Z",
      nextDate: "2026-05-09T20:10:00Z",
      startMmr: 4300,
      delta: 25,
    });
    addPair({
      prefix: "c",
      handle: "1-S2-1-203",
      anchorDate: "2026-05-10T15:00:00Z",
      nextDate: "2026-05-10T15:10:00Z",
      startMmr: 4400,
      delta: -30,
    });
    // This +50 ties May 9. The deterministic record is the newer day.
    // Its next reading is outside the display time frame but still closes
    // the selected anchor game's delta.
    addPair({
      prefix: "d",
      handle: "1-S2-1-204",
      anchorDate: "2026-05-11T15:00:00Z",
      nextDate: "2026-05-11T17:00:00Z",
      startMmr: 4500,
      delta: 50,
    });
    // A larger filtered-out day must not become the record.
    addPair({
      prefix: "excluded",
      handle: "1-S2-1-205",
      anchorDate: "2026-05-11T14:00:00Z",
      nextDate: "2026-05-11T14:10:00Z",
      startMmr: 4600,
      delta: 100,
      map: "Other Map",
    });
    // A resumed replay is ignored before pairing, so it cannot replace
    // account A's real next observation or create a phantom daily move.
    docs.push(
      makeGame({
        gameId: "a-resumed",
        date: new Date("2026-05-10T03:50:00Z"),
        myToonHandle: "1-S2-1-201",
        myMmr: 4100,
        isResumedFromReplay: true,
      }),
    );
    await db.games.insertMany(docs);

    const out = await svc.netMmrByMatchup(
      "u1",
      {
        map: "hard lead",
        until: new Date("2026-05-11T16:00:00Z"),
      },
      { tz: "America/New_York" },
    );

    expect(out.dailySwings).toMatchObject({
      timezone: "America/New_York",
      measuredDays: 3,
      measuredGames: 4,
      bestGain: {
        netMmr: 50,
        measuredGames: 1,
        wins: 1,
        losses: 0,
      },
      biggestLoss: {
        netMmr: -30,
        measuredGames: 1,
        wins: 0,
        losses: 1,
      },
    });
    expect(new Date(out.dailySwings.bestGain.day).toISOString()).toBe(
      "2026-05-11T04:00:00.000Z",
    );
    expect(new Date(out.dailySwings.biggestLoss.day).toISOString()).toBe(
      "2026-05-10T04:00:00.000Z",
    );
  });

  test("flat-only measured days report no gain or loss record", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({ gameId: "flat-1", date: new Date(t0), myMmr: 4500 }),
      makeGame({
        gameId: "flat-2",
        date: new Date(t0 + MIN_AGO),
        myMmr: 4500,
      }),
    ]);

    const out = await svc.netMmrByMatchup("u1", {}, { tz: "bad/timezone" });
    expect(out.dailySwings).toEqual({
      timezone: "UTC",
      bestGain: null,
      biggestLoss: null,
      measuredDays: 1,
      measuredGames: 1,
      regions: [
        {
          region: "NA",
          bestGain: null,
          biggestLoss: null,
          measuredDays: 1,
          measuredGames: 1,
        },
      ],
    });
  });

  test("daily regional records stay independent when regions cancel overall and use latest local-day ties", async () => {
    const docs = [];
    const addRegionalPair = ({ prefix, handle, date, startMmr, delta }) => {
      const anchor = new Date(date);
      docs.push(
        makeGame({
          gameId: `${prefix}-anchor`,
          date: anchor,
          myToonHandle: handle,
          myMmr: startMmr,
          result: delta < 0 ? "Defeat" : "Victory",
        }),
        makeGame({
          gameId: `${prefix}-next`,
          date: new Date(anchor.getTime() + MIN_AGO),
          myToonHandle: handle,
          myMmr: startMmr + delta,
        }),
      );
    };

    // NA +40 and EU -40 cancel in the overall May 10 row. Each own-region
    // record must remain visible instead of disappearing into the flat sum.
    addRegionalPair({
      prefix: "na-tie-old",
      handle: "1-S2-1-301",
      date: "2026-05-10T15:00:00Z",
      startMmr: 4000,
      delta: 40,
    });
    addRegionalPair({
      prefix: "eu-loss",
      handle: "2-S2-1-302",
      date: "2026-05-10T16:00:00Z",
      startMmr: 4300,
      delta: -40,
    });
    // Equal NA gain on the following local day: latest tie wins.
    addRegionalPair({
      prefix: "na-tie-new",
      handle: "1-S2-1-303",
      date: "2026-05-11T15:00:00Z",
      startMmr: 4400,
      delta: 40,
    });
    addRegionalPair({
      prefix: "na-loss",
      handle: "1-S2-1-304",
      date: "2026-05-12T15:00:00Z",
      startMmr: 4500,
      delta: -20,
    });
    addRegionalPair({
      prefix: "eu-gain",
      handle: "2-S2-1-305",
      date: "2026-05-12T16:00:00Z",
      startMmr: 4600,
      delta: 15,
    });
    // Unknown but nonempty handle remains a valid, separately reported
    // ladder region and sorts after every known Blizzard region.
    addRegionalPair({
      prefix: "unknown-gain",
      handle: "9-S2-1-306",
      date: "2026-05-13T15:00:00Z",
      startMmr: 4700,
      delta: 5,
    });
    await db.games.insertMany(docs);

    const out = await svc.netMmrByMatchup(
      "u1",
      {},
      { tz: "America/New_York" },
    );
    expect(out.dailySwings.regions.map((row) => row.region)).toEqual([
      "NA",
      "EU",
      "U",
    ]);
    const [na, eu, unknown] = out.dailySwings.regions;
    expect(na).toMatchObject({
      measuredDays: 3,
      measuredGames: 3,
      bestGain: { netMmr: 40, measuredGames: 1, wins: 1, losses: 0 },
      biggestLoss: { netMmr: -20, measuredGames: 1, wins: 0, losses: 1 },
    });
    expect(new Date(na.bestGain.day).toISOString()).toBe(
      "2026-05-11T04:00:00.000Z",
    );
    expect(eu).toMatchObject({
      measuredDays: 2,
      measuredGames: 2,
      bestGain: { netMmr: 15 },
      biggestLoss: { netMmr: -40 },
    });
    expect(new Date(eu.biggestLoss.day).toISOString()).toBe(
      "2026-05-10T04:00:00.000Z",
    );
    expect(unknown).toMatchObject({
      measuredDays: 1,
      measuredGames: 1,
      bestGain: { netMmr: 5 },
      biggestLoss: null,
    });
    // The regional May 10 moves cancel, while May 12 nets -5 overall.
    expect(out.dailySwings.bestGain.netMmr).toBe(40);
    expect(out.dailySwings.biggestLoss.netMmr).toBe(-5);
  });

  test("the global region filter scopes opponent region while records label own ladder region", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "own-na-vs-eu",
        date: new Date(t0),
        myToonHandle: "1-S2-1-401",
        myMmr: 4000,
        opponent: { race: "Zerg", region: "EU", toonHandle: "2-S2-1-1" },
      }),
      makeGame({
        gameId: "own-na-next",
        date: new Date(t0 + MIN_AGO),
        myToonHandle: "1-S2-1-401",
        myMmr: 4020,
        opponent: { race: "Zerg", region: "NA", toonHandle: "1-S2-1-1" },
      }),
      makeGame({
        gameId: "own-eu-vs-na",
        date: new Date(t0 + 2 * MIN_AGO),
        myToonHandle: "2-S2-1-402",
        myMmr: 4300,
        opponent: { race: "Zerg", region: "NA", toonHandle: "1-S2-1-2" },
      }),
      makeGame({
        gameId: "own-eu-next",
        date: new Date(t0 + 3 * MIN_AGO),
        myToonHandle: "2-S2-1-402",
        myMmr: 4325,
        opponent: { race: "Zerg", region: "NA", toonHandle: "1-S2-1-3" },
      }),
    ]);

    const out = await svc.netMmrByMatchup(
      "u1",
      { regions: ["EU"] },
      { tz: "UTC" },
    );
    expect(out.dailySwings.regions).toEqual([
      {
        region: "NA",
        bestGain: expect.objectContaining({ netMmr: 20 }),
        biggestLoss: null,
        measuredDays: 1,
        measuredGames: 1,
      },
    ]);
  });

  test("Random queue pairs by selected race, not spawned race", async () => {
    const t0 = new Date("2026-05-09T12:00:00Z").getTime();
    await db.games.insertMany([
      makeGame({
        gameId: "random_p",
        date: new Date(t0),
        myRace: "Protoss",
        myLadderRace: "Random",
        myMmr: 3000,
      }),
      makeGame({
        gameId: "random_z",
        date: new Date(t0 + MIN_AGO),
        myRace: "Zerg",
        myLadderRace: "Random",
        myMmr: 3020,
      }),
      makeGame({
        gameId: "protoss",
        date: new Date(t0 + 2 * MIN_AGO),
        myRace: "Protoss",
        myLadderRace: "Protoss",
        myMmr: 4500,
      }),
    ]);

    const z = findRow((await svc.netMmrByMatchup("u1", {})).matchups, "Z");
    expect(z.games).toBe(1);
    expect(z.netMmr).toBe(20);
  });
});
