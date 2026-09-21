// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const { CustomBuildsService } = require("../src/services/customBuilds");
const { StrategyPhasesService } = require("../src/services/strategyPhases");

function replay(gameId, count, overrides = {}) {
  return {
    gameId,
    customBuildSlug: "saved-build",
    myBuild: "Test build",
    myRace: "Terran",
    oppRace: "Zerg",
    date: new Date("2026-09-20T12:00:00.000Z"),
    map: "Test map LE",
    result: "Victory",
    durationSec: 600,
    opponent: { race: "Zerg", displayName: "Opponent One", strategy: "Test strategy" },
    events: [],
    oppEvents: [],
    macroBreakdown: {
      stats_events: Array.from({ length: 61 }, (_, index) => ({
        time: index * 10, food_workers: 50, food_used: 100, army_value: 3000,
      })),
      bases: [],
      production_buildings: [],
      unit_timeline: [0, 240, 360, 480, 600].map((time) => ({ time, my: { Marine: count }, opp: {} })),
    },
    ...overrides,
  };
}

function serviceHarness(kind, games) {
  const iterateRulePreviewPages = jest.fn(async function* () {
    for (const game of games) yield { games: [game], candidates: 1, hasMore: true };
  });
  const perGame = { iterateRulePreviewPages };
  const build = { slug: "saved-build", name: "Test build", perspective: "you", rules: [] };
  const service = kind === "custom"
    ? new CustomBuildsService({ customBuilds: { findOne: async () => build }, customBuildJobs: {} }, { perGame })
    : new StrategyPhasesService({}, { perGame });
  const evaluate = (opts) => kind === "custom"
    ? service.evaluateBuildPhases("owner", "saved-build", { ...opts, includeTransitions: false })
    : kind === "build"
      ? service.evaluateByBuildName("owner", "Test build", opts)
      : service.evaluate("owner", "Test strategy", opts);
  return { evaluate, iterateRulePreviewPages };
}

describe.each(["custom", "build", "strategy"])("%s composition comparison service", (kind) => {
  const outsider = replay("outside-cohort", 99, {
    customBuildSlug: "another-build",
    myBuild: "Another build",
    opponent: { race: "Zerg", displayName: "Other Opponent", strategy: "Another strategy" },
  });

  test("preserves real replay metadata and compares only against the other matched games", async () => {
    const games = [replay("selected", 8), replay("baseline", 2), outsider];
    const { evaluate, iterateRulePreviewPages } = serviceHarness(kind, games);
    const filters = { since: new Date("2026-09-01"), oppRace: "Z" };
    const out = await evaluate({ compareGameId: "selected", filters });
    expect(iterateRulePreviewPages).toHaveBeenCalledWith("owner", expect.objectContaining({ filters, limit: 101 }));
    expect(out.comparisonGames.map((game) => game.gameId)).toEqual(["selected", "baseline"]);
    expect(out.comparisonGames[0]).toMatchObject({
      date: "2026-09-20T12:00:00.000Z",
      map: "Test map LE",
      result: "Victory",
      myRace: "Terran",
      oppRace: "Zerg",
      opponentName: "Opponent One",
      durationSec: 600,
    });
    const checkpoint = out.checkpoints.find((row) => row.timeSec === 240);
    expect(checkpoint.reachedGames).toBe(2);
    expect(checkpoint.unitSummary.comparison).toMatchObject({
      gameId: "selected",
      status: "observed",
      baselineGames: 1,
      units: [{ token: "Marine", count: 8, median: 2, p25: 2, p75: 2, delta: 6 }],
    });
    expect(out.sampleLimit).toBe(100);
    expect(out.sampleTruncated).toBe(false);
  });

  test("a requested replay outside the matched cohort cannot become comparison data", async () => {
    const { evaluate } = serviceHarness(kind, [replay("baseline", 2), outsider]);
    const out = await evaluate({ compareGameId: "outside-cohort" });
    expect(out.comparisonGames.map((game) => game.gameId)).toEqual(["baseline"]);
    expect(out.checkpoints.find((row) => row.timeSec === 240).unitSummary.comparison)
      .toMatchObject({ gameId: "outside-cohort", status: "not_in_cohort", units: [] });
  });

  test("comparison choices obey the 100-game sample cap and expose truncation", async () => {
    const template = replay("sample", 2);
    const games = Array.from({ length: 101 }, (_, index) => ({ ...template, gameId: `game-${index}` }));
    const { evaluate } = serviceHarness(kind, games);
    const out = await evaluate({ compareGameId: "game-100" });
    expect(out.comparisonGames).toHaveLength(100);
    expect(out.comparisonGames.at(-1).gameId).toBe("game-99");
    expect(out.sampleLimit).toBe(100);
    expect(out.sampleTruncated).toBe(true);
    expect(out.flags).toContain("sample_truncated");
    expect(out.checkpoints.find((row) => row.timeSec === 240).unitSummary.comparison)
      .toMatchObject({ gameId: "game-100", status: "not_in_cohort", units: [] });
  });
});
