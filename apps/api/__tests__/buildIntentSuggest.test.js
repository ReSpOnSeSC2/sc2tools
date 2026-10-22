// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in suggestion engine (services/buildIntentSuggest.js): the
 * declared / randomizer / detected / rules / usual ladder, randomizer
 * consistency, ``executed`` and the generic-label rule. Pure, no Mongo.
 */

const {
  isGenericLabel,
  twelvePoolName,
  rulesForBuild,
  executedFor,
  detectedOptionKey,
  suggestIntent,
} = require("../src/services/buildIntentSuggest");
const { evaluateRules } = require("../src/services/buildRulesEvaluator");
const { parseBuildLogLines } = require("../src/services/perGameCompute");

const PHOENIX = "PvZ - 2 Stargate Phoenix";
const ROBO = "PvZ - Robo Opener";
const TWELVE = "ZvP - 12 Pool Rush";
const EIGHT = "ZvP - 8 Pool Rush";

function catalogOption(name, extra = {}) {
  return {
    key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    name,
    slug: null,
    source: "catalog",
    games: 0,
    wins: 0,
    losses: 0,
    checkins: 0,
    lastPlayedAt: null,
    inRandomizer: false,
    group: "all",
    ...extra,
  };
}

function customOption(slug, name, ruleCount) {
  return {
    ...catalogOption(name),
    key: `custom:${slug}`,
    slug,
    source: "custom",
    group: "yours",
    ruleCount,
  };
}

const OPTIONS = [
  customOption("dt", "DT Rush", 2),
  customOption("void", "Void Ray Opener", 4),
  customOption("void-b", "Void Ray B", 4),
  customOption("plain", "Rule-less", 0),
  catalogOption(PHOENIX),
  catalogOption(ROBO),
];

const RULES = new Map([
  ["dt", {
    rules: [
      { type: "before", name: "BuildTwilightCouncil", time_lt: 300 },
      { type: "before", name: "BuildDarkShrine", time_lt: 400 },
    ],
    updatedAt: 10,
  }],
  ["void", {
    rules: [
      { type: "before", name: "BuildGateway", time_lt: 200 },
      { type: "before", name: "BuildStargate", time_lt: 240 },
      { type: "before", name: "BuildFleetBeacon", time_lt: 400 },
      { type: "before", name: "BuildDarkShrine", time_lt: 400 },
    ],
    updatedAt: 5,
  }],
  ["void-b", {
    rules: [
      { type: "before", name: "BuildGateway", time_lt: 200 },
      { type: "before", name: "BuildStargate", time_lt: 240 },
      { type: "before", name: "BuildFleetBeacon", time_lt: 400 },
      { type: "before", name: "BuildDarkShrine", time_lt: 400 },
    ],
    updatedAt: 9,
  }],
  ["plain", { rules: [], updatedAt: 1 }],
]);

const STARGATE_EVENTS = parseBuildLogLines(
  ["[0:12] Pylon", "[1:30] Gateway", "[3:00] Stargate", "[3:30] CyberneticsCore"],
  null,
);
const GAME = { myRace: "Protoss", date: new Date("2026-10-20T18:00:00Z"), gameVersion: "5.0.17.98000" };
const EIGHT_WORKER_GAME = { myRace: "Zerg", date: new Date("2026-08-01T18:00:00Z"), gameVersion: "5.0.16.97425" };

function suggest(over) {
  return suggestIntent({
    game: GAME,
    detector: { myBuild: null, customBuildSlug: null },
    events: STARGATE_EVENTS,
    builds: OPTIONS,
    usualKey: null,
    customRules: RULES,
    ...over,
  });
}

describe("generic labels", () => {
  test.each([
    ["PvZ - Macro Transition (Unclassified)", true],
    ["Unclassified - PvZ", true],
    ["PvZ - Game Too Short", true],
    ["Protoss - Standard Play (Unclassified)", true],
    ["Protoss - Chargelot/Archon Comp", true],
    [PHOENIX, false],
    ["Zerg - 12 Pool", false],
    [null, false],
  ])("%s → %s", (label, generic) => {
    expect(isGenericLabel(label)).toBe(generic);
  });

  test("the 8-worker pool names map to their era-neutral name", () => {
    expect(twelvePoolName(EIGHT)).toBe(TWELVE);
    expect(twelvePoolName(TWELVE)).toBe(TWELVE);
    expect(twelvePoolName(PHOENIX)).toBe(PHOENIX);
    expect(twelvePoolName("")).toBeNull();
  });
});

describe("evaluateRules counts", () => {
  test("reports passed and total rules additively", () => {
    const out = evaluateRules(RULES.get("void").rules, STARGATE_EVENTS);
    expect(out).toEqual(expect.objectContaining({ pass: false, passedCount: 2, ruleCount: 4 }));
    expect(evaluateRules([], STARGATE_EVENTS)).toEqual({ pass: true, almost: false, passedCount: 0, ruleCount: 0 });
    expect(evaluateRules(RULES.get("void").rules.slice(0, 2), STARGATE_EVENTS))
      .toEqual({ pass: true, almost: false, passedCount: 2, ruleCount: 2 });
  });

  test("legacy signature rows evaluate like rules", () => {
    expect(rulesForBuild({ signature: [{ unit: "Stargate", beforeSec: 240, count: 1 }, { nope: 1 }] }))
      .toEqual([{ type: "count_min", name: "BuildStargate", time_lt: 240, count: 1 }]);
    expect(rulesForBuild({ rules: [{ name: "BuildGateway", type: "before", time_lt: 1 }, null] }))
      .toEqual([{ name: "BuildGateway", type: "before", time_lt: 1 }]);
    expect(rulesForBuild({})).toEqual([]);
  });
});

describe("suggestIntent", () => {
  test("a declaration always wins", () => {
    const out = suggest({
      declared: { key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom", at: new Date(), via: "agent" },
      randomizer: OPTIONS[4],
      detector: { myBuild: ROBO, customBuildSlug: null },
    });
    expect(out).toEqual({
      suggestion: {
        key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom",
        reason: "declared", passedRules: null, ruleCount: null,
      },
      randomizerDeviated: false,
    });
  });

  describe("randomizer roll", () => {
    const phoenixRoll = { key: "pvz-2-stargate-phoenix", name: PHOENIX, slug: null, source: "catalog" };

    test.each([
      ["a generic detector label", "PvZ - Macro Transition (Unclassified)"],
      ["no detector label", null],
      ["the same build", PHOENIX],
    ])("a catalog roll stands with %s", (_label, detected) => {
      const out = suggest({ randomizer: phoenixRoll, detector: { myBuild: detected, customBuildSlug: null } });
      expect(out.suggestion).toEqual({ ...phoenixRoll, reason: "randomizer", passedRules: null, ruleCount: null });
      expect(out.randomizerDeviated).toBe(false);
    });

    test("a catalog roll the replay deviated from falls back to the detected build", () => {
      const out = suggest({ randomizer: phoenixRoll, detector: { myBuild: ROBO, customBuildSlug: null } });
      expect(out.suggestion).toEqual(expect.objectContaining({ name: ROBO, reason: "detected" }));
      expect(out.randomizerDeviated).toBe(true);
    });

    test("pool openers compare era-neutrally and keep the game's era name", () => {
      const roll = { key: "zvp-12-pool-rush", name: TWELVE, slug: null, source: "catalog" };
      const out = suggestIntent({
        game: EIGHT_WORKER_GAME,
        detector: { myBuild: EIGHT, customBuildSlug: null },
        events: null,
        builds: [catalogOption(TWELVE)],
        randomizer: roll,
      });
      expect(out.suggestion).toEqual(expect.objectContaining({ key: "zvp-12-pool-rush", name: EIGHT, reason: "randomizer" }));
      expect(out.randomizerDeviated).toBe(false);
    });

    test("a custom roll stands when rule-less, unknown, unreadable or at least 60 % passed", () => {
      const plain = { key: "custom:plain", name: "Rule-less", slug: "plain", source: "custom" };
      expect(suggest({ randomizer: plain }).suggestion.reason).toBe("randomizer");
      const ghost = { key: "custom:ghost", name: "Ghost", slug: "ghost", source: "custom" };
      expect(suggest({ randomizer: ghost }).suggestion.reason).toBe("randomizer");
      const voidRoll = { key: "custom:void", name: "Void Ray Opener", slug: "void", source: "custom" };
      expect(suggest({ randomizer: voidRoll, events: null }).suggestion).toEqual(expect.objectContaining({
        reason: "randomizer", passedRules: null, ruleCount: null,
      }));
      const passing = new Map(RULES);
      passing.set("void", { rules: RULES.get("void").rules.slice(0, 3), updatedAt: 5 });
      const withEvents = suggest({
        randomizer: voidRoll,
        customRules: passing,
        events: parseBuildLogLines(["[1:30] Gateway", "[3:00] Stargate"], null),
      });
      expect(withEvents.suggestion).toEqual(expect.objectContaining({
        key: "custom:void", reason: "randomizer", passedRules: 2, ruleCount: 3,
      }));
      expect(withEvents.randomizerDeviated).toBe(false);
    });

    test("a custom roll under 60 % deviates (unless the classifier picked it)", () => {
      const voidRoll = { key: "custom:void", name: "Void Ray Opener", slug: "void", source: "custom" };
      const deviated = suggest({ randomizer: voidRoll, detector: { myBuild: PHOENIX, customBuildSlug: null } });
      expect(deviated.randomizerDeviated).toBe(true);
      expect(deviated.suggestion).toEqual(expect.objectContaining({ key: "pvz-2-stargate-phoenix", reason: "detected" }));
      const picked = suggest({ randomizer: voidRoll, detector: { myBuild: "Void Ray Opener", customBuildSlug: "void" } });
      expect(picked.randomizerDeviated).toBe(false);
      expect(picked.suggestion).toEqual(expect.objectContaining({ key: "custom:void", reason: "randomizer", passedRules: 2, ruleCount: 4 }));
    });
  });

  describe("best match", () => {
    test("the detector's custom build, with its rule counts", () => {
      const out = suggest({ detector: { myBuild: "DT Rush", customBuildSlug: "dt" } });
      expect(out.suggestion).toEqual({
        key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom",
        reason: "detected", passedRules: 0, ruleCount: 2,
      });
      const unreadable = suggest({ detector: { myBuild: "DT Rush", customBuildSlug: "dt" }, events: null });
      expect(unreadable.suggestion).toEqual(expect.objectContaining({ passedRules: 2, ruleCount: 2 }));
    });

    test("the detector's catalog build, era-normalised", () => {
      expect(suggest({ detector: { myBuild: ROBO, customBuildSlug: null } }).suggestion)
        .toEqual({ key: "pvz-robo-opener", name: ROBO, slug: null, source: "catalog", reason: "detected", passedRules: null, ruleCount: null });
      const eight = suggestIntent({
        game: EIGHT_WORKER_GAME,
        detector: { myBuild: EIGHT, customBuildSlug: null },
        events: null,
        builds: [catalogOption(TWELVE)],
      });
      expect(eight.suggestion).toEqual(expect.objectContaining({ key: "zvp-12-pool-rush", name: EIGHT, reason: "detected" }));
    });

    test("a deleted custom detector build is not an option", () => {
      const out = suggest({ detector: { myBuild: "Gone", customBuildSlug: "gone" } });
      expect(out.suggestion).toEqual(expect.objectContaining({ reason: "rules" }));
    });

    test("custom builds ranked by passed ratio, then rule count, recency and slug", () => {
      // void and void-b both pass 2/4 = 50 %; dt passes 0/2. void-b is newer.
      expect(suggest({}).suggestion).toEqual({
        key: "custom:void-b", name: "Void Ray B", slug: "void-b", source: "custom",
        reason: "rules", passedRules: 2, ruleCount: 4,
      });
      const sameAge = new Map(RULES);
      sameAge.set("void-b", { ...RULES.get("void-b"), updatedAt: 5 });
      expect(suggest({ customRules: sameAge }).suggestion.key).toBe("custom:void");
      const fewer = new Map(RULES);
      fewer.set("dt", { rules: RULES.get("void").rules.slice(0, 2), updatedAt: 1 });
      expect(suggest({ customRules: fewer }).suggestion).toEqual(expect.objectContaining({
        key: "custom:dt", passedRules: 2, ruleCount: 2,
      }));
    });

    test("below half the rules, the usual build, else nothing", () => {
      const weak = parseBuildLogLines(["[1:30] Gateway"], null);
      const noRules = suggest({ events: weak, usualKey: "pvz-robo-opener" });
      expect(noRules.suggestion).toEqual(expect.objectContaining({ key: "pvz-robo-opener", reason: "usual" }));
      expect(suggest({ events: weak }).suggestion).toBeNull();
      expect(suggest({ events: null, usualKey: "missing-key" }).suggestion).toBeNull();
    });
  });
});

describe("executed and detected keys", () => {
  test("custom builds compare slugs; catalog builds era-neutral names", () => {
    const dt = { key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom" };
    expect(executedFor(dt, { myBuild: "DT Rush", customBuildSlug: "dt" })).toBe(true);
    expect(executedFor(dt, { myBuild: "DT Rush", customBuildSlug: null })).toBe(false);
    const pool = { key: "zvp-12-pool-rush", name: EIGHT, slug: null, source: "catalog" };
    expect(executedFor(pool, { myBuild: TWELVE, customBuildSlug: null })).toBe(true);
    expect(executedFor(pool, { myBuild: "ZvP - Hatch First Macro", customBuildSlug: null })).toBe(false);
    expect(executedFor(null, { myBuild: TWELVE, customBuildSlug: null })).toBe(false);
  });

  test("the detector label's option key", () => {
    expect(detectedOptionKey({ myBuild: "DT Rush", customBuildSlug: "dt" }, OPTIONS)).toBe("custom:dt");
    expect(detectedOptionKey({ myBuild: PHOENIX, customBuildSlug: null }, OPTIONS)).toBe("pvz-2-stargate-phoenix");
    expect(detectedOptionKey({ myBuild: "PvZ - Macro Transition (Unclassified)", customBuildSlug: null }, OPTIONS)).toBeNull();
    expect(detectedOptionKey({ myBuild: "Somebody Else's", customBuildSlug: "other" }, OPTIONS)).toBeNull();
  });
});
