// @ts-nocheck
"use strict";

/**
 * Build check-in suggestion for the opponent's build
 * (services/buildIntentSuggest.js ``suggestOpponent``,
 * ``detectedOpponentOption``, ``opponentDetectorLabel``): the detector's
 * opponent label when it is an opponent option, else the closest
 * opponent-perspective custom build by rules. Pure, no Mongo.
 */

const {
  detectedOpponentOption,
  opponentDetectorLabel,
  suggestOpponent,
  executedFor,
  detectedOptionKey,
} = require("../src/services/buildIntentSuggest");
const { parseBuildLogLines } = require("../src/services/perGameCompute");

const POOL = "Zerg - 12 Pool";
const EIGHT_POOL = "Zerg - 8 Pool";
const BANE = "ZvP - Ling Bane Bust";

function option(name, extra = {}) {
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
  return { ...option(name), key: `custom:${slug}`, slug, source: "custom", group: "yours", ruleCount };
}

const OPP_OPTIONS = [
  customOption("roach-rush", "Their Roach Rush", 2),
  customOption("hatch-first", "Their Hatch First", 2),
  customOption("bare", "Rule-less read", 0),
  option(POOL),
  option(BANE),
];

const OPP_RULES = new Map([
  ["roach-rush", {
    rules: [
      { type: "before", name: "BuildSpawningPool", time_lt: 90 },
      { type: "before", name: "BuildRoachWarren", time_lt: 200 },
    ],
    updatedAt: 3,
  }],
  ["hatch-first", {
    rules: [
      { type: "before", name: "BuildHatchery", time_lt: 40 },
      { type: "before", name: "BuildSpawningPool", time_lt: 120 },
    ],
    updatedAt: 9,
  }],
  ["bare", { rules: [], updatedAt: 1 }],
]);

const POOL_FIRST_EVENTS = parseBuildLogLines(
  ["[0:17] SpawningPool", "[0:50] Hatchery", "[2:30] RoachWarren"],
  null,
);
const GAME = { myRace: "Protoss", date: new Date("2026-10-20T18:00:00Z"), gameVersion: "5.0.17.98000" };
const EIGHT_WORKER_GAME = { myRace: "Protoss", date: new Date("2026-08-01T18:00:00Z"), gameVersion: "5.0.16.97425" };

function suggest(over) {
  return suggestOpponent({
    game: GAME,
    detector: { strategy: null, customStrategySlug: null },
    events: POOL_FIRST_EVENTS,
    builds: OPP_OPTIONS,
    customRules: OPP_RULES,
    ...over,
  });
}

describe("opponentDetectorLabel", () => {
  test("maps the opponent view onto the shape the shared helpers read", () => {
    expect(opponentDetectorLabel({ strategy: POOL, customStrategySlug: "x" }))
      .toEqual({ myBuild: POOL, customBuildSlug: "x" });
  });

  test("executed and the detected key work on the opponent axis", () => {
    const label = opponentDetectorLabel({ strategy: EIGHT_POOL, customStrategySlug: null });
    expect(executedFor({ key: "zerg-12-pool", name: POOL, slug: null, source: "catalog" }, label)).toBe(true);
    expect(detectedOptionKey(label, OPP_OPTIONS)).toBe("zerg-12-pool");
  });
});

describe("detectedOpponentOption", () => {
  test("a custom slug among the opponent options wins", () => {
    expect(detectedOpponentOption({ strategy: "Their Roach Rush", customStrategySlug: "roach-rush" }, OPP_OPTIONS))
      .toEqual(expect.objectContaining({ key: "custom:roach-rush" }));
  });

  test("an unknown custom slug names nothing, even when the name is a catalog option", () => {
    expect(detectedOpponentOption({ strategy: POOL, customStrategySlug: "gone" }, OPP_OPTIONS)).toBeNull();
  });

  test("catalog names match era-neutrally", () => {
    expect(detectedOpponentOption({ strategy: EIGHT_POOL, customStrategySlug: null }, OPP_OPTIONS))
      .toEqual(expect.objectContaining({ key: "zerg-12-pool" }));
  });

  test.each([
    "Zerg - Standard Play (Unclassified)",
    "Zerg - Roach/Ravager Comp",
    "ZvP - Game Too Short",
    "PvZ - 2 Stargate Phoenix",
  ])("%s names no option", (strategy) => {
    expect(detectedOpponentOption({ strategy, customStrategySlug: null }, OPP_OPTIONS)).toBeNull();
  });
});

describe("suggestOpponent", () => {
  test("the detected catalog strategy is suggested with the game's era spelling", () => {
    expect(suggest({ detector: { strategy: POOL, customStrategySlug: null } })).toEqual({
      key: "zerg-12-pool",
      name: POOL,
      slug: null,
      source: "catalog",
      reason: "detected",
      passedRules: null,
      ruleCount: null,
    });
    expect(suggest({ game: EIGHT_WORKER_GAME, detector: { strategy: EIGHT_POOL, customStrategySlug: null } }))
      .toEqual(expect.objectContaining({ key: "zerg-12-pool", name: EIGHT_POOL, reason: "detected" }));
  });

  test("a detected custom build carries its rule score (all rules when the events are unreadable)", () => {
    const detector = { strategy: "Their Roach Rush", customStrategySlug: "roach-rush" };
    expect(suggest({ detector })).toEqual(expect.objectContaining({
      key: "custom:roach-rush", reason: "detected", passedRules: 2, ruleCount: 2,
    }));
    expect(suggest({ detector, events: null })).toEqual(expect.objectContaining({
      key: "custom:roach-rush", reason: "detected", passedRules: 2, ruleCount: 2,
    }));
  });

  test("without a detected option the closest opponent build by rules is suggested", () => {
    const out = suggest({ detector: { strategy: "Zerg - Standard Play (Unclassified)", customStrategySlug: null } });
    expect(out).toEqual(expect.objectContaining({
      key: "custom:roach-rush", source: "custom", slug: "roach-rush", reason: "rules", passedRules: 2, ruleCount: 2,
    }));
  });

  test("nothing is suggested below half the rules, without events or without options", () => {
    const hatchOnly = new Map([["hatch-first", OPP_RULES.get("hatch-first")]]);
    const lateEvents = parseBuildLogLines(["[3:00] SpawningPool", "[3:30] Hatchery"], null);
    expect(suggest({ customRules: hatchOnly, events: lateEvents })).toBeNull();
    expect(suggest({ events: null })).toBeNull();
    expect(suggest({ builds: [] })).toBeNull();
    expect(suggestOpponent({ game: GAME, detector: { strategy: null, customStrategySlug: null }, events: null, builds: OPP_OPTIONS }))
      .toBeNull();
  });
});
