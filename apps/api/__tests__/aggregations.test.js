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
});
