// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const { CustomBuildsService } = require("../src/services/customBuilds");

describe("custom-build phase projection", () => {
  test.each([
    {
      rulePerspective: "you",
      requestedPerspective: "opponent",
      expectedHydration: "opponent",
    },
    {
      rulePerspective: "opponent",
      requestedPerspective: "you",
      expectedHydration: "you",
    },
  ])(
    "hydrates only the $expectedHydration rule side in bounded macro pages",
    async ({ rulePerspective, requestedPerspective, expectedHydration }) => {
      const filters = { map: ["Rorschach LE"] };
      const iterateRulePreviewPages = jest.fn(async function* (_userId, opts) {
        expect(opts).toEqual(expect.objectContaining({
          limit: 101,
          pageSize: 25,
          perspective: expectedHydration,
          includeMacroBreakdown: true,
          filters,
          match: {
            _customBuildSlug: "phase-projection",
            "opponent.strategy": "Terran - Bio",
          },
          metadataFilter: expect.any(Function),
        }));
        yield { games: [], candidates: 0, hasMore: false };
      });
      const build = {
        slug: "phase-projection",
        name: "Phase projection",
        race: rulePerspective === "opponent" ? "Terran" : "Protoss",
        vsRace: rulePerspective === "opponent" ? "Protoss" : "Terran",
        perspective: rulePerspective,
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      };
      const service = new CustomBuildsService(
        {
          customBuilds: {
            findOne: jest.fn(async () => build),
          },
          customBuildJobs: {},
        },
        { perGame: { iterateRulePreviewPages } },
      );

      const result = await service.evaluateBuildPhases(
        "phase-user",
        build.slug,
        {
          includeTransitions: false,
          perspective: requestedPerspective,
          strategyName: "Terran - Bio",
          filters,
        },
      );

      expect(iterateRulePreviewPages).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expect.objectContaining({
        slug: build.slug,
        perspective: requestedPerspective,
      }));
      expect(result).not.toHaveProperty("transitions");
    },
  );

  test("retains only bounded phase summaries across a large cohort", async () => {
    const unitCounts = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`SyntheticUnit${index}`, index + 1]),
    );
    const macroBreakdown = {
      stats_events: [{ time: 0, food_workers: 12, food_used: 12, army_value: 0 }],
      bases: [],
      production_buildings: [],
      unit_timeline: [{ time: 0, my: unitCounts, opp: {} }],
    };
    const iterateRulePreviewPages = jest.fn(async function* () {
      for (let index = 0; index < 101; index += 1) {
        yield {
          games: [{
            gameId: `phase-${index}`,
            customBuildSlug: "bounded-phase",
            myRace: "Protoss",
            oppRace: "Terran",
            opponent: { race: "Terran", strategy: "Terran - Bio" },
            durationSec: 60,
            result: "Victory",
            events: Array.from({ length: 500 }, (_, eventIndex) => ({
              name: `Event${eventIndex}`,
              time: eventIndex,
            })),
            macroBreakdown,
          }],
          candidates: 1,
          hasMore: index < 100,
        };
      }
    });
    const service = new CustomBuildsService(
      { customBuilds: {}, customBuildJobs: {} },
      { perGame: { iterateRulePreviewPages } },
    );

    const cohort = await service._listForRulePhases("phase-user", {
      limit: 101,
      pageSize: 25,
      perspective: "you",
      phasePerspective: "you",
      slug: "bounded-phase",
      strategyName: null,
      match: { _customBuildSlug: "bounded-phase" },
    });

    expect(cohort.truncated).toBe(true);
    expect(cohort.games).toHaveLength(100);
    for (const game of cohort.games) {
      expect(game).not.toHaveProperty("events");
      expect(game).not.toHaveProperty("macroBreakdown");
      for (const phase of Object.values(game._phasePrepared.phases)) {
        if (!phase) continue;
        expect(phase.allUnits.length).toBeLessThanOrEqual(64);
        expect(phase.tech.length).toBeLessThanOrEqual(128);
        expect(phase.upgrades.length).toBeLessThanOrEqual(128);
      }
    }
  });
});
