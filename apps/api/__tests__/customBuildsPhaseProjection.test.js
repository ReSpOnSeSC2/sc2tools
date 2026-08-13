// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const { CustomBuildsService } = require("../src/services/customBuilds");

describe("custom-build phase projection", () => {
  test.each([
    {
      rulePerspective: "you",
      requestedPerspective: "opponent",
      expectedHydration: "you",
    },
    {
      rulePerspective: "opponent",
      requestedPerspective: "you",
      expectedHydration: "opponent",
    },
  ])(
    "hydrates only the $expectedHydration rule side in bounded macro pages",
    async ({ rulePerspective, requestedPerspective, expectedHydration }) => {
      const filters = { map: ["Rorschach LE"] };
      const iterateRulePreviewPages = jest.fn(async function* (_userId, opts) {
        expect(opts).toEqual(expect.objectContaining({
          limit: 1000,
          pageSize: 25,
          perspective: expectedHydration,
          includeMacroBreakdown: true,
          filters,
          match: { "opponent.strategy": "Terran - Bio" },
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
});
