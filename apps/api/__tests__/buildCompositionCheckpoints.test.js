// @ts-nocheck
"use strict";

const { computeCompositions, prepareCompositionGame } = require("../src/services/buildCompositions");

function game(gameId, timeline, durationSec = 600, extra = {}) {
  return {
    gameId, durationSec, myRace: "Protoss", oppRace: "Terran", result: "Victory",
    macroBreakdown: { unit_timeline: timeline }, ...extra,
  };
}

function atFour(games, compareGameId) {
  return computeCompositions(games, { compareGameId }).checkpoints[0];
}

describe("build composition clock checkpoints", () => {
  test("uses the latest valid preceding sample in unsorted timelines, never a future army", () => {
    const checkpoint = atFour([game("a", [
      { time: 245, my: { Carrier: 9 } },
      { time: 239, my: { Stalker: 4, StalkerBurrowed: 0 } },
      { time: 235, my: { Stalker: 2 } },
      { time: 240, my: { Marine: -1 } },
    ])], "a");
    expect(checkpoint.unitSummary).toMatchObject({ metric: "snapshot_alive", observedGames: 1 });
    expect(checkpoint.unitSummary.units.map((row) => [row.token, row.mean])).toEqual([["Stalker", 4]]);
    expect(checkpoint.unitSummary.comparison.sampleTimeSec).toBe(239);
  });

  test("distinguishes observed zero, missing/stale samples, and games that ended before a checkpoint", () => {
    const checkpoint = atFour([
      game("present", [{ time: 210, my: { Marine: 8 } }]),
      game("zero", [{ time: 240, my: {} }]),
      game("stale", [{ time: 209.99, my: { Marine: 99 } }]),
      game("future-only", [{ time: 241, my: { Marine: 99 } }]),
      game("malformed", [{ time: 240, my: { Marine: "5" } }]),
      game("ended", [{ time: 230, my: { Marine: 99 } }], 239),
      game("ends-exactly", [{ time: 240, my: { Marine: 4 } }], 240),
    ]);
    expect(checkpoint).toMatchObject({ timeSec: 240, reachedGames: 6, endedGames: 1 });
    expect(checkpoint.unitSummary).toMatchObject({ observedGames: 3, missingGames: 3, emptyArmyGames: 1 });
    expect(checkpoint.unitSummary.units[0]).toMatchObject({ token: "Marine", mean: 4, median: 4, gamesPresent: 2 });
  });

  test("canonicalizes simultaneous variants and filters transient units identically to phase peaks", () => {
    const checkpoint = atFour([game("roster", [{ time: 240, my: {
      Roach: 4, RoachBurrowed: 6, Probe: 55, DroneBurrowed: 2,
      Nexus: 3, AdeptPhaseShift: 3, DisruptorPhased: 1, Interceptor: 8,
    } }])]);
    expect(checkpoint.unitSummary.units.map((row) => [row.token, row.mean])).toEqual([["Roach", 10]]);
  });

  test("partially malformed side maps cannot create false absences beside valid worker counts", () => {
    const games = [
      game("known", [{ time: 240, my: { Marine: 12 } }]),
      game("unknown-army", [{ time: 240, my: { SCV: 40, Marine: "unknown" } }]),
    ];
    const result = computeCompositions(games, { compareGameId: "unknown-army" });
    for (const summary of [result.checkpoints[0].unitSummary, result.perPhase.early.unitSummary]) {
      expect(summary).toMatchObject({ observedGames: 1, missingGames: 1 });
      expect(summary.units[0]).toMatchObject({ token: "Marine", mean: 12 });
      expect(summary.units[0].examples.absent).toBeUndefined();
      expect(summary.comparison).toMatchObject({ status: "missing", units: [] });
    }
  });

  test("keeps real opponent snapshots when opponent classifier stats are sparse", () => {
    const result = computeCompositions([game("opponent", [
      { time: 240, my: { Stalker: 3 }, opp: { Marine: 12 } },
    ])], { perspective: "opponent", compareGameId: "opponent" });
    expect(result.flags).toContain("opp_signals_sparse");
    expect(result.perPhase.early.signatures).toEqual([]);
    expect(result.checkpoints[0].unitSummary.units[0]).toMatchObject({ token: "Marine", mean: 12 });
    expect(result.checkpoints[0].unitSummary.comparison.status).toBe("observed");
  });
});

describe("selected game comparisons", () => {
  test("excludes the selected game from every baseline statistic and includes observed absences", () => {
    const games = [
      game("selected", [{ time: 240, my: { Marine: 100, Raven: 2 } }]),
      game("peer-a", [{ time: 240, my: { Marine: 4, Marauder: 2 } }]),
      game("peer-b", [{ time: 240, my: { Marine: 8 } }]),
      game("peer-zero", [{ time: 240, my: {} }]),
      game("peer-missing", []),
    ];
    const summary = atFour(games, "selected").unitSummary;
    expect(summary.units.find((row) => row.token === "Marine").mean).toBe(28);
    expect(summary.comparison).toMatchObject({ gameId: "selected", status: "observed", baselineGames: 3 });
    expect(summary.comparison.units).toEqual(expect.arrayContaining([
      { token: "Marine", count: 100, median: 4, p25: 2, p75: 6, delta: 96 },
      { token: "Raven", count: 2, median: 0, p25: 0, p75: 0, delta: 2 },
      { token: "Marauder", count: 0, median: 0, p25: 0, p75: 1, delta: 0 },
    ]));
    const phaseComparison = computeCompositions(games, { compareGameId: "selected" }).perPhase.early.unitSummary.comparison;
    expect(phaseComparison).toMatchObject({ status: "observed", baselineGames: 3 });
  });

  test("returns null baseline statistics for a single observed replay", () => {
    const comparison = atFour([game("only", [{ time: 240, my: { Marine: 5 } }])], "only").unitSummary.comparison;
    expect(comparison).toMatchObject({ baselineGames: 0, units: [
      { token: "Marine", count: 5, median: null, p25: null, p75: null, delta: null },
    ] });
  });

  test("keeps an empty selected army as observed with zero counts for baseline units", () => {
    const comparison = atFour([
      game("zero", [{ time: 240, my: {} }]),
      game("peer", [{ time: 240, my: { Marine: 8 } }]),
    ], "zero").unitSummary.comparison;
    expect(comparison).toMatchObject({ status: "observed", baselineGames: 1, units: [
      { token: "Marine", count: 0, median: 8, p25: 8, p75: 8, delta: -8 },
    ] });
  });

  test.each([
    ["missing", "missing"], ["ended", "not_reached"], ["not-our-replay", "not_in_cohort"],
  ])("reports the selected %s replay honestly without comparison numbers", (selected, status) => {
    const comparison = atFour([
      game("observed", [{ time: 240, my: { Marine: 2 } }]),
      game("missing", []), game("ended", [], 120),
    ], selected).unitSummary.comparison;
    expect(comparison).toEqual({ gameId: selected, status, baselineGames: 1, units: [] });
  });

  test("never resolves selected IDs outside the supplied cohort", () => {
    const result = computeCompositions([], { compareGameId: "private-other-user-game" });
    expect(result.comparisonGames).toEqual([]);
    expect(result.perPhase.early.unitSummary.comparison.status).toBe("not_in_cohort");
    expect(result.checkpoints.every((point) => point.unitSummary.comparison.status === "not_in_cohort")).toBe(true);
  });
});

describe("cohort evidence and compact preparation", () => {
  test("selects true typical/high/absent evidence across the entire cohort, beyond the 25-ID cap", () => {
    const games = Array.from({ length: 30 }, (_, index) => game(`g${index}`, [
      { time: 240, my: { Marine: index === 29 ? 50 : 2 } },
    ]));
    games.push(game("zero", [{ time: 239, my: {} }]));
    const row = atFour(games).unitSummary.units[0];
    expect(row.sampleGameIds).toHaveLength(25);
    expect(row.whenPresent).toEqual({ median: 2, p25: 2, p75: 2 });
    expect(row.examples).toEqual({
      typical: { gameId: "g0", count: 2, timeSec: 240 },
      high: { gameId: "g29", count: 50, timeSec: 240 },
      absent: { gameId: "zero", count: 0, timeSec: 239 },
    });
  });

  test("records independent peak times and takes the earliest actual sample on peak ties", () => {
    const result = computeCompositions([game("transition", [
      { time: 220, my: { Roach: 6 } },
      { time: 200, my: { Roach: 6 } },
      { time: 240, my: { Ravager: 4 } },
    ])]);
    const units = result.perPhase.early.unitSummary.units;
    expect(units.find((row) => row.token === "Roach").examples.high.timeSec).toBe(200);
    expect(units.find((row) => row.token === "Ravager").examples.high.timeSec).toBe(240);
    expect(result.perPhase.early.window).toEqual({ medianStartSec: 0, medianEndSec: 600 });
  });

  test("prepared records preserve raw output while retaining no timeline or classifier trajectory", () => {
    const original = game("metadata", Array.from({ length: 601 }, (_, time) => ({ time, my: { Stalker: time % 10 } })), 600, {
      date: new Date("2026-09-01T12:00:00Z"), map: "Map name", opponent: { displayName: "Opponent" },
    });
    const metadata = { ...original };
    delete metadata.macroBreakdown;
    const prepared = prepareCompositionGame(original);
    const compact = { ...metadata, _phasePrepared: prepared };
    expect(computeCompositions([compact], { compareGameId: original.gameId }))
      .toEqual(computeCompositions([original], { compareGameId: original.gameId }));
    expect(prepared).not.toHaveProperty("macroBreakdown");
    expect(prepared).not.toHaveProperty("unit_timeline");
    expect(prepared.classified).not.toHaveProperty("trajectory");
    expect(Object.keys(prepared.checkpoints)).toHaveLength(5);
    expect(JSON.stringify(prepared).length).toBeLessThan(5000);
  });

  test("100-game payload remains bounded and exposes only compact, valid selector metadata", () => {
    const games = Array.from({ length: 100 }, (_, index) => game(`g${index}`, [
      { time: 240, my: { Marine: index % 30, Marauder: 2 } },
    ], 600, { map: "m".repeat(10000), date: "not-a-date", opponent: { displayName: "Player" } }));
    const result = computeCompositions(games, { compareGameId: "g0" });
    expect(result.comparisonGames).toHaveLength(100);
    expect(result.comparisonGames[0]).toMatchObject({ date: null, map: "m".repeat(160), opponentName: "Player" });
    expect(JSON.stringify(result).length).toBeLessThan(60000);
  });
});
