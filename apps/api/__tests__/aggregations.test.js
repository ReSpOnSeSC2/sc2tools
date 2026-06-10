// @ts-nocheck
"use strict";

const {
  AggregationsService,
  RACES_PLAYED,
  RACE_NAME_TO_LETTER,
  RACE_LETTER_TO_NAME,
} = require("../src/services/aggregations");

function buildGames(handlers) {
  let nthCall = 0;
  return {
    aggregate(pipeline) {
      const handler = handlers[nthCall++ % handlers.length];
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
    },
  };
}

describe("services/aggregations", () => {
  test("RACES_PLAYED matches the canonical letter map", () => {
    expect(RACES_PLAYED.length).toBe(3);
    for (const r of RACES_PLAYED) {
      expect(RACE_NAME_TO_LETTER[r]).toBeDefined();
      expect(RACE_LETTER_TO_NAME[RACE_NAME_TO_LETTER[r]]).toBe(r);
    }
  });

  test("summary collapses facets into the legacy shape", async () => {
    const games = buildGames([
      () => [
        {
          totals: [{ wins: 6, losses: 4, total: 10 }],
          byMatchup: [{ name: "vs Z", wins: 3, losses: 2, total: 5 }],
          byMap: [{ name: "Goldenaura", wins: 2, losses: 1, total: 3 }],
          recent: [],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.summary("u1", {}));
    expect(out.totals.total).toBe(10);
    expect(out.totals.winRate).toBeCloseTo(0.6);
    expect(out.byMatchup["vs Z"].winRate).toBeCloseTo(0.6);
    expect(out.byMap["Goldenaura"].winRate).toBeCloseTo(2 / 3);
  });

  test("matchups returns rows with computed winRate and recent results", async () => {
    // _matchupsOnce now makes two aggregate calls: the grouped facet
    // and a second pass to attach the last-N results per bucket. Mock
    // both so the recent[] field actually populates.
    const games = buildGames([
      () => [
        { name: "vs P", wins: 4, losses: 2, total: 6 },
        { name: "vs T", wins: 1, losses: 3, total: 4 },
      ],
      () => [
        { _id: "vs P", results: ["Victory", "Defeat", "Victory"] },
        { _id: "vs T", results: ["Defeat", "Victory"] },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any[]} */ (await svc.matchups("u1", {}));
    expect(out[0].winRate).toBeCloseTo(4 / 6);
    expect(out[1].winRate).toBeCloseTo(1 / 4);
    expect(out[0].recent).toEqual(["win", "loss", "win"]);
    expect(out[1].recent).toEqual(["loss", "win"]);
  });

  test("randomSummary computes per-race win rates and best/worst", async () => {
    const games = buildGames([
      () => [
        { _id: "Protoss", games: 10, wins: 6, losses: 3 },
        { _id: "Terran", games: 10, wins: 4, losses: 5 },
        { _id: "Zerg", games: 10, wins: 7, losses: 3 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = await svc.randomSummary("u1", {});
    expect(out.total).toBe(30);
    expect(out.perRace.Protoss.winRate).toBeCloseTo(6 / 9);
    expect(out.best).toBe("Zerg");
    expect(out.worst).toBe("Terran");
  });

  test("randomSummary returns null best/worst when nothing decided enough", async () => {
    const games = buildGames([
      () => [
        { _id: "Protoss", games: 2, wins: 1, losses: 1 },
        { _id: "Terran", games: 2, wins: 0, losses: 2 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = await svc.randomSummary("u1", {});
    expect(out.best).toBeNull();
    expect(out.worst).toBeNull();
  });

  test("buildVsStrategy projects to legacy field names", async () => {
    const games = buildGames([
      () => [
        { my_build: "P-Stargate", opp_strat: "Cheese", wins: 3, losses: 1, total: 4 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any[]} */ (await svc.buildVsStrategy("u1", {}));
    expect(out[0].my_build).toBe("P-Stargate");
    expect(out[0].winRate).toBe(0.75);
  });

  test("timeseries returns interval + points", async () => {
    const games = buildGames([
      () => [
        { bucket: new Date("2026-04-01"), wins: 2, losses: 1, total: 3 },
        { bucket: new Date("2026-04-02"), wins: 1, losses: 1, total: 2 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.timeseries("u1", { interval: "day" }, {}));
    expect(out.interval).toBe("day");
    expect(out.points).toHaveLength(2);
    expect(out.points[0].winRate).toBeCloseTo(2 / 3);
  });

  test("timeseries rounds avgMacroScore to 1dp and nulls buckets without scores", async () => {
    const games = buildGames([
      () => [
        {
          bucket: new Date("2026-04-01"),
          wins: 2,
          losses: 1,
          total: 3,
          avgMacroScore: 71.2345,
        },
        // Bucket whose games all predate macro scoring — $avg over
        // missing fields yields null and must stay null (not 0).
        { bucket: new Date("2026-04-02"), wins: 1, losses: 1, total: 2, avgMacroScore: null },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.timeseries("u1", { interval: "day" }, {})
    );
    expect(out.points[0].avgMacroScore).toBeCloseTo(71.2);
    expect(out.points[1].avgMacroScore).toBeNull();
  });

  test("macroSummary shapes coverage + leaks from the facet doc", async () => {
    const games = buildGames([
      () => [
        {
          coverage: [{ total: 50, withScore: 42, avgScore: 68.449 }],
          leaks: [
            { name: "Supply blocked", count: 30, totalMinerals: 14200 },
            { name: "Idle production", count: 22, totalMinerals: 9100 },
          ],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.macroSummary("u1", {}));
    expect(out.ok).toBe(true);
    expect(out.gamesTotal).toBe(50);
    expect(out.gamesWithMacro).toBe(42);
    expect(out.gamesMissingMacro).toBe(8);
    expect(out.avgScore).toBeCloseTo(68.4);
    expect(out.leaks[0].name).toBe("Supply blocked");
    expect(out.leaks[0].totalMinerals).toBe(14200);
  });

  test("macroSummary tolerates a user with zero games", async () => {
    const games = buildGames([() => [{ coverage: [], leaks: [] }]]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.macroSummary("u1", {}));
    expect(out.gamesTotal).toBe(0);
    expect(out.gamesMissingMacro).toBe(0);
    expect(out.avgScore).toBeNull();
    expect(out.leaks).toEqual([]);
  });

  test("timeseries keeps the most-recent buckets, not the oldest", async () => {
    let captured;
    const games = buildGames([
      (pipeline) => {
        captured = pipeline;
        return [];
      },
    ]);
    const svc = new AggregationsService({ games });
    await svc.timeseries("u1", { interval: "day" }, {});
    // The pipeline must descend by bucket *before* limiting so that
    // users with multi-year histories don't lose today.
    const limitIdx = captured.findIndex(
      (s) => Object.prototype.hasOwnProperty.call(s, "$limit"),
    );
    expect(limitIdx).toBeGreaterThan(-1);
    const sortBeforeLimit = captured[limitIdx - 1];
    expect(sortBeforeLimit).toEqual({ $sort: { _id: -1 } });
    // And we re-sort ascending after limiting so consumers still get
    // chronological order.
    const sortAfterLimit = captured[limitIdx + 1];
    expect(sortAfterLimit).toEqual({ $sort: { _id: 1 } });
  });

  test("timeseries threads a validated timezone into $dateTrunc", async () => {
    let captured;
    const games = buildGames([
      (pipeline) => {
        captured = pipeline;
        return [];
      },
    ]);
    const svc = new AggregationsService({ games });
    await svc.timeseries(
      "u1",
      { interval: "day", tz: "America/Los_Angeles" },
      {},
    );
    const groupStage = captured.find((s) => s.$group);
    expect(groupStage.$group._id.$dateTrunc.timezone).toBe(
      "America/Los_Angeles",
    );
  });

  test("timeseries falls back to UTC for invalid tz", async () => {
    let captured;
    const games = buildGames([
      (pipeline) => {
        captured = pipeline;
        return [];
      },
    ]);
    const svc = new AggregationsService({ games });
    await svc.timeseries("u1", { interval: "day", tz: "Not/AReal_Zone" }, {});
    const groupStage = captured.find((s) => s.$group);
    expect(groupStage.$group._id.$dateTrunc.timezone).toBe("UTC");
  });

  test("timeseries widens the bucket so multi-year ranges aren't truncated", async () => {
    // The min/max pre-query reports a 4-year span. With day buckets the
    // 365-bucket cap would silently drop the oldest ~1100 days, which
    // is what made the "All time" win-rate tile diverge from the
    // lifetime-synced count. The service should escalate to week here.
    let bucketingPipeline;
    const games = buildGames([
      () => [
        { _id: null, minDate: new Date("2022-01-01"), maxDate: new Date("2026-01-01") },
      ],
      (pipeline) => {
        bucketingPipeline = pipeline;
        return [];
      },
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.timeseries("u1", { interval: "day" }, {})
    );
    expect(out.interval).toBe("week");
    const groupStage = bucketingPipeline.find((s) => s.$group);
    expect(groupStage.$group._id.$dateTrunc.unit).toBe("week");
  });

  test("timeseries keeps the requested interval when the span fits the cap", async () => {
    const games = buildGames([
      () => [
        { _id: null, minDate: new Date("2025-12-01"), maxDate: new Date("2026-01-01") },
      ],
      () => [],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.timeseries("u1", { interval: "day" }, {})
    );
    expect(out.interval).toBe("day");
  });

  test("timeseries escalates to month when even week buckets overflow", async () => {
    const games = buildGames([
      () => [
        { _id: null, minDate: new Date("2010-01-01"), maxDate: new Date("2026-01-01") },
      ],
      () => [],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.timeseries("u1", { interval: "day" }, {})
    );
    expect(out.interval).toBe("month");
  });

  test("timeseries stays at day resolution when filtered to today's window", async () => {
    // The dashboard's "Games today" card scopes the global timeseries
    // to a `since=<start of today in tz>` filter so a multi-year
    // history can't trigger `_fitInterval` to widen `day` → `week`.
    // With span < 24h the response must remain day-bucketed; otherwise
    // the bucket key won't match `todayKeyIn(tz)` on the client and the
    // card silently flips to 0 once UTC rolls over.
    let bucketingPipeline;
    const games = buildGames([
      () => [
        {
          _id: null,
          // Both extremes fall inside the user's local 2026-05-09.
          minDate: new Date("2026-05-09T17:00:00Z"),
          maxDate: new Date("2026-05-10T02:30:00Z"),
        },
      ],
      (pipeline) => {
        bucketingPipeline = pipeline;
        return [
          {
            bucket: new Date("2026-05-09T05:00:00Z"),
            wins: 3,
            losses: 1,
            total: 4,
          },
        ];
      },
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.timeseries(
        "u1",
        { interval: "day", tz: "America/Chicago" },
        { since: new Date("2026-05-09T05:00:00Z") },
      )
    );
    expect(out.interval).toBe("day");
    expect(out.points).toHaveLength(1);
    expect(out.points[0].total).toBe(4);
    const groupStage = bucketingPipeline.find((s) => s.$group);
    expect(groupStage.$group._id.$dateTrunc.unit).toBe("day");
    expect(groupStage.$group._id.$dateTrunc.timezone).toBe("America/Chicago");
  });

  test("matchupTimeseries computes winRate per (bucket, race) row", async () => {
    const games = buildGames([
      () => [
        { bucket: new Date("2026-04-01"), race: "P", wins: 3, losses: 1, total: 4 },
        { bucket: new Date("2026-04-01"), race: "Z", wins: 1, losses: 3, total: 4 },
        { bucket: new Date("2026-04-08"), race: "T", wins: 2, losses: 0, total: 2 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.matchupTimeseries("u1", { interval: "week" }, {})
    );
    expect(out.interval).toBe("week");
    expect(out.points).toHaveLength(3);
    const pvP = out.points.find((p) => p.race === "P");
    expect(pvP.winRate).toBeCloseTo(0.75);
    const pvZ = out.points.find((p) => p.race === "Z");
    expect(pvZ.winRate).toBeCloseTo(0.25);
  });

  test("dayHourHeatmap totals games and exposes timezone", async () => {
    const games = buildGames([
      () => [
        { dow: 0, hour: 19, wins: 3, losses: 2, total: 5 },
        { dow: 5, hour: 22, wins: 0, losses: 4, total: 4 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.dayHourHeatmap("u1", { tz: "America/Los_Angeles" }, {})
    );
    expect(out.timezone).toBe("America/Los_Angeles");
    expect(out.totalGames).toBe(9);
    expect(out.cells).toHaveLength(2);
    expect(out.cells[0].winRate).toBeCloseTo(3 / 5);
    expect(out.cells[1].winRate).toBe(0);
  });

  test("lengthBuckets orders rows 0–3m → 25m+ and computes winRate + avgSec", async () => {
    const games = buildGames([
      () => [
        { bucket: "25m+", wins: 1, losses: 1, total: 2, avgSec: 1800 },
        { bucket: "0–3m", wins: 4, losses: 1, total: 5, avgSec: 90 },
        { bucket: "12–15m", wins: 3, losses: 2, total: 5, avgSec: 780 },
        { bucket: "6–9m", wins: 2, losses: 1, total: 3, avgSec: 450 },
        { bucket: "20–25m", wins: 1, losses: 0, total: 1, avgSec: 1380 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.lengthBuckets("u1", {}));
    expect(out.buckets.map((b) => b.bucket)).toEqual([
      "0–3m",
      "6–9m",
      "12–15m",
      "20–25m",
      "25m+",
    ]);
    expect(out.buckets[0].winRate).toBeCloseTo(0.8);
    expect(out.buckets[0].avgSec).toBe(90);
  });

  test("activityCalendar returns one row per day with computed winRate", async () => {
    const games = buildGames([
      () => [
        { day: new Date("2026-04-01"), wins: 2, losses: 1, total: 3 },
        { day: new Date("2026-04-02"), wins: 0, losses: 2, total: 2 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.activityCalendar("u1", { tz: "UTC" }, {})
    );
    expect(out.timezone).toBe("UTC");
    expect(out.days).toHaveLength(2);
    expect(out.days[0].winRate).toBeCloseTo(2 / 3);
    expect(out.days[1].winRate).toBe(0);
  });

  test("gamesList honours offset + limit + search", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({
      id: `g${i}`,
      date: new Date(),
      map: "Goldenaura",
      opponent: `Foo${i}`,
      opp_race: "Z",
      opp_strategy: null,
      result: i % 2 ? "Defeat" : "Victory",
      build: "P - Stargate",
      game_length: 600,
      macro_score: null,
    }));
    const games = buildGames([
      () => [{ meta: [{ total: 5 }], rows: all.slice(0, 2) }],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.gamesList("u1", {}, { limit: 2, offset: 0, search: "Foo" })
    );
    expect(out.total).toBe(5);
    expect(out.count).toBe(2);
  });

  test("groupByRacePlayed returns a per-race map", async () => {
    const games = buildGames([
      () => [{ totals: [{ wins: 1, losses: 1, total: 2 }], byMatchup: [], byMap: [], recent: [] }],
      () => [{ totals: [{ wins: 0, losses: 1, total: 1 }], byMatchup: [], byMap: [], recent: [] }],
      () => [{ totals: [{ wins: 2, losses: 0, total: 2 }], byMatchup: [], byMap: [], recent: [] }],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.summary("u1", { groupByRacePlayed: true })
    );
    expect(out.Protoss).toBeDefined();
    expect(out.Terran).toBeDefined();
    expect(out.Zerg).toBeDefined();
  });

  // ---------------- v0.5+ Player-insight aggregations ----------------

  test("mmrProgression returns close/peak/trough + per-region + per-account series", async () => {
    const games = buildGames([
      () => [
        {
          overall: [
            {
              bucket: new Date("2026-04-01"),
              openMmr: 4000,
              closeMmr: 4050,
              minMmr: 3990,
              maxMmr: 4060,
              wins: 3,
              losses: 1,
              total: 4,
            },
            {
              bucket: new Date("2026-04-08"),
              openMmr: 4055,
              closeMmr: 4120,
              minMmr: 4040,
              maxMmr: 4140,
              wins: 5,
              losses: 2,
              total: 7,
            },
          ],
          byRegion: [
            {
              bucket: new Date("2026-04-01"),
              region: "NA",
              openMmr: 4000,
              closeMmr: 4050,
              minMmr: 3990,
              maxMmr: 4060,
              wins: 3,
              losses: 1,
              total: 4,
            },
            {
              bucket: new Date("2026-04-08"),
              region: "NA",
              openMmr: 4055,
              closeMmr: 4080,
              minMmr: 4055,
              maxMmr: 4090,
              wins: 2,
              losses: 1,
              total: 3,
            },
            {
              bucket: new Date("2026-04-08"),
              region: "EU",
              openMmr: 4100,
              closeMmr: 4120,
              minMmr: 4040,
              maxMmr: 4140,
              wins: 3,
              losses: 1,
              total: 4,
            },
          ],
          byAccount: [
            // Main account on NA — 5 games, lands first in NA group.
            {
              bucket: new Date("2026-04-01"),
              toonHandle: "1-S2-1-12345",
              region: "NA",
              openMmr: 4000,
              closeMmr: 4050,
              minMmr: 3990,
              maxMmr: 4060,
              wins: 3,
              losses: 1,
              total: 4,
            },
            {
              bucket: new Date("2026-04-08"),
              toonHandle: "1-S2-1-12345",
              region: "NA",
              openMmr: 4055,
              closeMmr: 4080,
              minMmr: 4055,
              maxMmr: 4090,
              wins: 1,
              losses: 0,
              total: 1,
            },
            // NA smurf — fewer games, must sort below the main.
            {
              bucket: new Date("2026-04-08"),
              toonHandle: "1-S2-1-99999",
              region: "NA",
              openMmr: 3500,
              closeMmr: 3520,
              minMmr: 3490,
              maxMmr: 3540,
              wins: 1,
              losses: 1,
              total: 2,
            },
            // EU account.
            {
              bucket: new Date("2026-04-08"),
              toonHandle: "2-S2-1-267727",
              region: "EU",
              openMmr: 4100,
              closeMmr: 4120,
              minMmr: 4040,
              maxMmr: 4140,
              wins: 3,
              losses: 1,
              total: 4,
            },
          ],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.mmrProgression("u1", { interval: "week" }, {})
    );
    expect(out.interval).toBe("week");
    expect(out.points).toHaveLength(2);
    expect(out.peak.mmr).toBe(4140);
    expect(out.trough.mmr).toBe(3990);
    expect(out.latest.mmr).toBe(4120);
    expect(out.regions).toHaveLength(2);
    const [na, eu] = out.regions;
    expect(na.region).toBe("NA");
    expect(na.points).toHaveLength(2);
    expect(na.latest.mmr).toBe(4080);
    expect(na.peak.mmr).toBe(4090);
    expect(eu.region).toBe("EU");
    expect(eu.points).toHaveLength(1);
    expect(eu.latest.mmr).toBe(4120);
    // Per-account series: NA main first (most games), then NA smurf,
    // then EU. Labels render as "<region> <bnid>".
    expect(out.accounts).toHaveLength(3);
    expect(out.accounts.map((a) => a.label)).toEqual([
      "NA 12345",
      "NA 99999",
      "EU 267727",
    ]);
    expect(out.accounts[0].region).toBe("NA");
    expect(out.accounts[0].points).toHaveLength(2);
    expect(out.accounts[0].latest.mmr).toBe(4080);
    expect(out.accounts[1].latest.mmr).toBe(3520);
    expect(out.accounts[2].latest.mmr).toBe(4120);
  });

  test("momentum shapes post-win / post-loss splits + session positions", async () => {
    const games = buildGames([
      () => [
        {
          post: [
            { _id: "win", wins: 7, losses: 3, total: 10 },
            { _id: "loss", wins: 2, losses: 4, total: 6 },
          ],
          positions: [
            { _id: 1, wins: 5, losses: 5, total: 10 },
            { _id: 2, wins: 4, losses: 3, total: 7 },
            { _id: 3, wins: 2, losses: 3, total: 5 },
          ],
          baseline: [{ wins: 11, losses: 11, total: 22 }],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.momentum("u1", {}, undefined));
    expect(out.sessionGapMinutes).toBe(90);
    expect(out.postWin.winRate).toBeCloseTo(0.7);
    expect(out.postLoss.winRate).toBeCloseTo(2 / 6);
    expect(out.baseline.winRate).toBeCloseTo(0.5);
    expect(out.sessionPositions).toHaveLength(3);
    expect(out.sessionPositions[1].pos).toBe(2);
  });

  test("momentum clamps session gap into the safe range", async () => {
    const games = buildGames([
      () => [{ post: [], positions: [], baseline: [] }],
    ]);
    const svc = new AggregationsService({ games });
    const tooSmall = /** @type {any} */ (
      await svc.momentum("u1", {}, { sessionGapMinutes: 5 })
    );
    expect(tooSmall.sessionGapMinutes).toBe(15);
    const tooBig = /** @type {any} */ (
      await svc.momentum("u1", {}, { sessionGapMinutes: 9999 })
    );
    expect(tooBig.sessionGapMinutes).toBe(480);
  });

  test("oppMmrBuckets honours an explicit bucketWidth and shapes each bin", async () => {
    // Two pipeline runs happen in order:
    //   1. resolveOppMmrBucketWidth's range query — skipped here because
    //      an explicit width short-circuits it.
    //   2. The main $facet — returns { bins: [...], unknown: [...] }.
    const games = buildGames([
      () => [
        {
          bins: [
            { _id: 3500, wins: 4, losses: 2, total: 6, avgMmr: 3540, minMmr: 3500, maxMmr: 3590 },
            { _id: 3600, wins: 7, losses: 3, total: 10, avgMmr: 3645, minMmr: 3601, maxMmr: 3690 },
          ],
          unknown: [{ _id: null, wins: 5, losses: 8, total: 13 }],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.oppMmrBuckets("u1", {}, { bucketWidth: 100 })
    );
    expect(out.bucketWidth).toBe(100);
    expect(out.buckets).toHaveLength(2);
    expect(out.buckets[0]).toMatchObject({
      lo: 3500,
      hi: 3600,
      label: "3500–3599",
      total: 6,
    });
    expect(out.buckets[0].winRate).toBeCloseTo(4 / 6);
    expect(out.buckets[1].avgMmr).toBe(3645);
    expect(out.unknown.total).toBe(13);
  });

  test("oppMmrBuckets auto-picks width 50 for tight ranges, 100 for wide", async () => {
    // Two aggregations per call: (1) min/max range probe, (2) main pipeline.
    // Mock pair 1 → tight range → expect 50. Pair 2 → wide range → expect 100.
    const games = buildGames([
      () => [{ _id: null, mn: 3500, mx: 3850 }], // tight: span 350 ≤ 500
      () => [{ bins: [], unknown: [] }],
      () => [{ _id: null, mn: 2400, mx: 4500 }], // wide: span 2100 > 500
      () => [{ bins: [], unknown: [] }],
    ]);
    const svc = new AggregationsService({ games });
    const tight = /** @type {any} */ (await svc.oppMmrBuckets("u1", {}));
    expect(tight.bucketWidth).toBe(50);
    const wide = /** @type {any} */ (await svc.oppMmrBuckets("u1", {}));
    expect(wide.bucketWidth).toBe(100);
  });

  test("oppMmrBuckets guards opponent.mmr with $isNumber so int-stored values bucket correctly", async () => {
    // Regression: the agent stores opponent.mmr via int(opp.mmr). An
    // earlier cut of the pipeline used `$eq: [{ $type: ... }, "double"]`,
    // which silently dropped every row because BSON $type returns "int".
    // The replacement uses $isNumber / $type:"number" — keep that.
    let captured = null;
    const games = {
      aggregate(pipeline) {
        captured = pipeline;
        return { toArray: () => Promise.resolve([{ bins: [], unknown: [] }]) };
      },
    };
    const svc = new AggregationsService({ games });
    await svc.oppMmrBuckets("u1", {}, { bucketWidth: 100 });
    const json = JSON.stringify(captured);
    // The new pipeline reads opponent.mmr via $type:"number" (query
    // operator alias) — the literal type-name comparison must not return.
    expect(json).not.toContain('"double"');
    // The snapshot side of the fallback still references the per-game
    // opponent.mmr field as a $-prefixed expression source.
    expect(json).toContain('"$opponent.mmr"');
    // $isNumber gates the snapshot AND the fallback so int / long /
    // double values all bucket correctly.
    expect(json).toContain('"$isNumber"');
  });

  test("oppMmrBuckets falls back to the opponents-collection mmr when the game snapshot is missing", async () => {
    // Recent ranked 1v1 replays rarely carry opponent.mmr in the
    // replay payload — sc2reader doesn't expose it. The opponents
    // collection stores the SC2Pulse-fetched current MMR, and the
    // bucketing pipeline $lookups that as a fallback so a game vs a
    // 5961 opponent doesn't vanish from the chart just because the
    // replay was MMR-less.
    let captured = null;
    const games = {
      aggregate(pipeline) {
        captured = pipeline;
        return { toArray: () => Promise.resolve([{ bins: [], unknown: [] }]) };
      },
    };
    const svc = new AggregationsService({ games });
    await svc.oppMmrBuckets("u1", {}, { bucketWidth: 100 });
    const json = JSON.stringify(captured);
    expect(json).toContain('"from":"opponents"');
    expect(json).toContain('"$opponent.pulseId"');
    // Bucketing keys off the synthesised effective MMR, not the
    // raw snapshot — so fallback rows bin alongside snapshot rows.
    expect(json).toContain('"$_oppMmr"');
  });

  test("oppMmrBucketGames matches the band on the effective MMR and shapes rows", async () => {
    let captured = null;
    const games = {
      aggregate(pipeline) {
        captured = pipeline;
        return {
          toArray: () =>
            Promise.resolve([
              {
                meta: [{ total: 2 }],
                rows: [
                  {
                    id: "g1",
                    date: new Date("2026-05-01"),
                    map: "Goldenaura",
                    opponent: "AngryBird",
                    opp_race: "Z",
                    opp_strategy: null,
                    result: "Victory",
                    my_build: "P - Stargate",
                    game_length: 600,
                    macro_score: 72,
                    my_race: "Protoss",
                    my_mmr: 5450,
                    opp_mmr: 5412,
                  },
                ],
              },
            ]),
        };
      },
    };
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.oppMmrBucketGames("u1", {}, { lo: 5400, hi: 5500 })
    );
    expect(out.ok).toBe(true);
    expect(out.lo).toBe(5400);
    expect(out.hi).toBe(5500);
    expect(out.total).toBe(2);
    expect(out.count).toBe(1);
    expect(out.games[0].opponent).toBe("AngryBird");
    expect(out.games[0].opp_mmr).toBe(5412);
    const json = JSON.stringify(captured);
    // Bands on the synthesised effective MMR (snapshot OR opponents
    // fallback), exactly like the histogram, so the count matches.
    expect(json).toContain('"$_oppMmr"');
    expect(json).toContain('"from":"opponents"');
    expect(json).toContain('"$gte":5400');
    expect(json).toContain('"$lt":5500');
  });

  test("oppMmrBucketGames gates opponent MMR by the 1-year trust floor", async () => {
    // A current/last-known MMR is only a fair proxy for game-time MMR
    // on recent games; beyond the trust window the effective MMR must
    // collapse to null so an 8-year-old game can't be bucketed under
    // today's rating. Assert the date gate is wired into the pipeline.
    let captured = null;
    const games = {
      aggregate(pipeline) {
        captured = pipeline;
        return {
          toArray: () => Promise.resolve([{ meta: [], rows: [] }]),
        };
      },
    };
    const svc = new AggregationsService({ games });
    await svc.oppMmrBucketGames("u1", {}, { lo: 6100, hi: 6200 });
    // The effective-MMR $addFields gates on the game date with a $gte
    // against a Date floor before falling back to snapshot/opponents mmr.
    const addFields = captured.find(
      (s) => s.$addFields && s.$addFields._oppMmr,
    );
    expect(addFields).toBeTruthy();
    const cond = addFields.$addFields._oppMmr.$cond;
    expect(Array.isArray(cond)).toBe(true);
    expect(cond[0]).toMatchObject({ $gte: ["$date", expect.any(Date)] });
    // The far-side branch is a hard null (untrusted → missing MMR).
    expect(cond[2]).toBeNull();
    // Floor is ~365 days before now (allow a generous slack for clock
    // drift / test runtime).
    const floor = cond[0].$gte[1];
    const ageDays = (Date.now() - floor.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(364);
    expect(ageDays).toBeLessThan(366);
  });

  test("oppMmrBucketGames rejects a malformed band without touching the db", async () => {
    let called = false;
    const games = {
      aggregate() {
        called = true;
        return { toArray: () => Promise.resolve([]) };
      },
    };
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.oppMmrBucketGames("u1", {}, { lo: undefined, hi: 5500 })
    );
    expect(out.total).toBe(0);
    expect(out.games).toEqual([]);
    expect(called).toBe(false);
  });

  test("myBuildMixOverTime returns one row per (bucket, key)", async () => {
    const games = buildGames([
      () => [
        { bucket: new Date("2026-04-01"), key: "Mech", wins: 3, losses: 1, total: 4 },
        { bucket: new Date("2026-04-01"), key: "Bio", wins: 2, losses: 2, total: 4 },
        { bucket: new Date("2026-04-08"), key: "Mech", wins: 5, losses: 0, total: 5 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.myBuildMixOverTime("u1", { interval: "week" }, {})
    );
    expect(out.interval).toBe("week");
    expect(out.points).toHaveLength(3);
    expect(out.points[0].key).toBe("Mech");
    expect(out.points[0].total).toBe(4);
  });

  test("mapTrend returns one row per (bucket, map)", async () => {
    const games = buildGames([
      () => [
        { bucket: new Date("2026-04-01"), key: "Goldenaura", wins: 4, losses: 1, total: 5 },
        { bucket: new Date("2026-04-01"), key: "Site Delta", wins: 1, losses: 2, total: 3 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (
      await svc.mapTrend("u1", { interval: "week" }, {})
    );
    expect(out.points).toHaveLength(2);
    expect(out.points[0].key).toBe("Goldenaura");
  });

  test("netMmrByMatchup rounds the running totals and computes WR", async () => {
    const games = buildGames([
      () => [
        {
          summary: [{ _id: null, totalGames: 28, missingMyMmr: 13 }],
          keptPairs: [
            { _id: "P", netMmr: 84.4, avgDelta: 14.06, games: 6, wins: 4, losses: 2 },
            { _id: "Z", netMmr: -45.7, avgDelta: -9.14, games: 5, wins: 2, losses: 3 },
          ],
          droppedPairs: [{ _id: null, outlierSwing: 1 }],
        },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.netMmrByMatchup("u1", {}));
    expect(out.matchups).toHaveLength(2);
    const p = out.matchups.find((m) => m.race === "P");
    expect(p.netMmr).toBe(84);
    expect(p.avgDelta).toBeCloseTo(14.1);
    expect(p.winRate).toBeCloseTo(4 / 6);
    const z = out.matchups.find((m) => m.race === "Z");
    expect(z.netMmr).toBe(-46);
    // Diagnostic counters surface so the chart can show
    // "13 pairs from 28 games · 13 missing MMR · 1 outlier swing".
    expect(out.totalGames).toBe(28);
    expect(out.dropped.outlierSwing).toBe(1);
    expect(out.dropped.missingMyMmr).toBe(13);
  });

  test("netMmrByMatchup partitions by region so a region switch doesn't fake a phantom loss", async () => {
    // Region partitioning is the headline of the v0.7.x rewrite — a
    // streamer playing NA 4900 and EU 3500 should not see a −1400
    // attributed to whichever matchup happened to bridge the regions.
    // Inspecting the pipeline guarantees the $setWindowFields stage
    // uses ``partitionBy: "$_myRegion"`` and that ``_myRegion`` is
    // derived from ``myToonHandle``'s leading byte.
    let captured = null;
    const games = {
      aggregate(pipeline) {
        captured = pipeline;
        return {
          toArray: () =>
            Promise.resolve([
              { summary: [], keptPairs: [], droppedPairs: [] },
            ]),
        };
      },
    };
    const svc = new AggregationsService({ games });
    await svc.netMmrByMatchup("u1", {});
    const json = JSON.stringify(captured);
    expect(json).toContain('"partitionBy":"$_myRegion"');
    expect(json).toContain('"$myToonHandle"');
    // The region switch is the only branches we explicitly call out,
    // since they drive every regional partition.
    expect(json).toContain('"NA"');
    expect(json).toContain('"EU"');
    // Summary branch must run BEFORE the $match that drops
    // !myMmr games — otherwise the missingMyMmr counter is
    // always zero and the chart can't explain the disparity.
    expect(json).toContain('"missingMyMmr"');
    expect(json).toContain('"totalGames"');
  });

  test("netMmrByMatchup empty result still returns matchups[] and full dropped+totals counters", async () => {
    const games = buildGames([
      () => [{ summary: [], keptPairs: [], droppedPairs: [] }],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.netMmrByMatchup("u1", {}));
    expect(out.matchups).toEqual([]);
    expect(out.totalGames).toBe(0);
    expect(out.dropped.outlierSwing).toBe(0);
    expect(out.dropped.missingMyMmr).toBe(0);
  });
});
