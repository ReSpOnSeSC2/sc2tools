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

  test("matchups returns rows with computed winRate", async () => {
    const games = buildGames([
      () => [
        { name: "vs P", wins: 4, losses: 2, total: 6 },
        { name: "vs T", wins: 1, losses: 3, total: 4 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any[]} */ (await svc.matchups("u1", {}));
    expect(out[0].winRate).toBeCloseTo(4 / 6);
    expect(out[1].winRate).toBeCloseTo(1 / 4);
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

  test("mapsDiagnostic returns every distinct raw map value with counts", async () => {
    const games = buildGames([
      () => [
        { value: "10000 Feet LE", kind: "string", length: 13, count: 86 },
        { value: "Equilibrium LE", kind: "string", length: 14, count: 25 },
        { value: "10000 Feet LE ", kind: "string", length: 14, count: 12 },
        { value: "", kind: "empty", length: 0, count: 3 },
        { value: null, kind: "missing", length: null, count: 2 },
      ],
    ]);
    const svc = new AggregationsService({ games });
    const out = /** @type {any} */ (await svc.mapsDiagnostic("u1"));
    expect(out.distinct).toBe(5);
    expect(out.total).toBe(86 + 25 + 12 + 3 + 2);
    expect(out.rows[0].value).toBe("10000 Feet LE");
    // The trailing-space row is preserved so the user can see the
    // collision their eyes can't see in the headline panel.
    expect(out.rows[2].value).toBe("10000 Feet LE ");
    expect(out.rows[2].length).toBe(14);
    expect(out.rows[3].kind).toBe("empty");
    expect(out.rows[4].kind).toBe("missing");
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
