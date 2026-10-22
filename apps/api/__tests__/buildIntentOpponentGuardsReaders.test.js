// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Custom-build readers with opponent corrections (addendum §A.4): a corrected
 * game counts for the declared opponent-perspective build in W-L
 * (``checkins`` says how many only do because of a correction), recent rows
 * carry ``planned``, and build-shape views (median timings, compositions,
 * transitions) use only games whose replay agrees with the opponent label.
 * The rule-preview reads behind them honour both axes.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { CustomBuildsService } = require("../src/services/customBuilds");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const {
  applyOverridePipeline,
  applyOpponentOverridePipeline,
} = require("../src/services/buildIntentAttribution");

const USER = "u-opp-guard-readers";
const POOL_REF = { key: "custom:pool-first", name: "Pool First", slug: "pool-first", source: "custom" };
const CATALOG_OPP_REF = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };
const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const GENERIC = "Zerg - Standard Play (Unclassified)";
const LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore", "[4:00] DarkShrine"];

const BUILDS = [
  {
    userId: USER, slug: "dt-rush", name: "DT Rush", race: "Protoss", vsRace: "Zerg",
    perspective: "you", rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 420 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    userId: USER, slug: "pool-first", name: "Pool First", race: "Zerg", vsRace: "Protoss",
    perspective: "opponent", rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 120 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    userId: USER, slug: "roach-rush", name: "Roach Rush", race: "Zerg", vsRace: "Protoss",
    perspective: "opponent", rules: [{ type: "before", name: "BuildRoachWarren", time_lt: 240 }],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  },
];

let mongo;
let client;
let games;
let service;

function game(gameId, day, fields) {
  return {
    userId: USER,
    gameId,
    date: new Date(`2026-10-${String(day).padStart(2, "0")}T18:00:00Z`),
    myRace: "Protoss",
    myBuild: "DT Rush",
    _customBuildSlug: "dt-rush",
    map: "Site Delta LE",
    durationSec: 600,
    buildLog: LOG,
    oppBuildLog: ["[0:50] SpawningPool"],
    ...fields,
  };
}

function opponent(strategy) {
  return { displayName: "Opp", race: "Zerg", strategy };
}

async function correct(gameId, build = POOL_REF) {
  await games.updateOne(
    { userId: USER, gameId },
    applyOpponentOverridePipeline(build, { origin: "web", via: "web" }),
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  const db = client.db("build_intent_opponent_guard_readers");
  games = db.collection("games");
  const builds = db.collection("custom_builds");
  await builds.insertMany(BUILDS.map((build) => ({ ...build })));
  await games.insertMany([
    // Corrected to Pool First; the replay was generic. Counts only via the correction.
    game("corrected-win", 20, {
      opponent: opponent(GENERIC), result: "Victory", buildIntent: { notes: "They hid the pool" },
    }),
    // Corrected to Pool First; the replay matched another saved opponent build.
    game("corrected-loss", 19, {
      opponent: opponent("Roach Rush"), _customOpponentStrategySlug: "roach-rush", result: "Defeat",
    }),
    // Corrected and the replay executed it: counts, but not as a correction.
    game("executed", 18, {
      opponent: opponent("Pool First"), _customOpponentStrategySlug: "pool-first", result: "Victory",
    }),
    game("plain-pool", 17, {
      opponent: opponent("Pool First"), _customOpponentStrategySlug: "pool-first", result: "Victory",
    }),
    game("plain-roach", 16, {
      opponent: opponent("Roach Rush"), _customOpponentStrategySlug: "roach-rush", result: "Defeat",
    }),
    // A "you"-side check-in only: the opponent axis is untouched.
    game("you-checkin", 15, {
      myBuild: "PvZ - Macro", _customBuildSlug: null,
      opponent: opponent("Pool First"), _customOpponentStrategySlug: "pool-first", result: "Defeat",
    }),
    // Quarantined rows never count, correction or not.
    game("resumed", 14, {
      opponent: opponent(GENERIC), result: "Victory", isResumedFromReplay: true,
    }),
  ]);
  await correct("corrected-win");
  await correct("corrected-loss");
  await correct("executed");
  await correct("resumed");
  await games.updateOne({ userId: USER, gameId: "you-checkin" }, applyOverridePipeline(DT_REF, {}));
  service = new CustomBuildsService(
    { games, customBuilds: builds, customBuildJobs: db.collection("custom_build_jobs") },
    { perGame: new PerGameComputeService({ games }) },
  );
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("opponent-perspective custom build readers", () => {
  test("library stats count corrected games for the declared slug and report check-ins", async () => {
    const stats = await service.evaluateAllStats(USER);
    const bySlug = Object.fromEntries(stats.map((row) => [row.slug, row]));
    expect(bySlug["pool-first"]).toEqual(expect.objectContaining({
      total: 5, wins: 3, losses: 2, checkins: 2, winRate: 0.6,
    }));
    // The detector's Roach Rush label on a corrected game never counts for it.
    expect(bySlug["roach-rush"]).toEqual(expect.objectContaining({
      total: 1, wins: 0, losses: 1, checkins: 0,
    }));
    // "You"-side builds count only "you"-side check-ins.
    expect(bySlug["dt-rush"]).toEqual(expect.objectContaining({ total: 6, checkins: 1 }));

    const paged = await service.evaluateAllStats(USER, { slugs: ["pool-first"] });
    expect(paged).toEqual([expect.objectContaining({ slug: "pool-first", total: 5, checkins: 2 })]);
  });

  test("build matches report check-ins and planned rows; median timings sample agreeing games", async () => {
    const hydrate = jest.spyOn(service, "_hydrateClassifiedTimingSample");
    const detail = await service.evaluateBuild(USER, "pool-first");

    expect(detail.totals).toEqual(expect.objectContaining({
      wins: 3, losses: 2, total: 5, checkins: 2, winRate: 0.6,
    }));
    const planned = Object.fromEntries(detail.recent.map((row) => [row.gameId, row.planned]));
    expect(planned).toEqual({
      "corrected-win": { detected: GENERIC, notes: "They hid the pool" },
      "corrected-loss": { detected: "Roach Rush", notes: "" },
      executed: { detected: "Pool First", notes: "" },
      "plain-pool": null,
      "you-checkin": null,
    });
    expect(detail.recent.every((row) => !("buildIntent" in row))).toBe(true);
    expect(detail.resumedRecent).toEqual([
      expect.objectContaining({ gameId: "resumed", planned: null, isResumedFromReplay: true }),
    ]);
    const sampled = hydrate.mock.calls[0][1].map((row) => row.gameId);
    expect(sampled).toEqual(["executed", "plain-pool", "you-checkin"]);
  });

  test("a \"you\" build's matches ignore opponent corrections", async () => {
    const hydrate = jest.spyOn(service, "_hydrateClassifiedTimingSample");
    const detail = await service.evaluateBuild(USER, "dt-rush");
    expect(detail.totals).toEqual(expect.objectContaining({ total: 6, checkins: 1 }));
    const planned = Object.fromEntries(detail.recent.map((row) => [row.gameId, row.planned]));
    expect(planned["corrected-win"]).toBeNull();
    expect(planned["you-checkin"]).toEqual({ detected: "PvZ - Macro", notes: "" });
    // Opponent corrections never narrow a "you" build's timing sample.
    const sampled = hydrate.mock.calls[0][1].map((row) => row.gameId);
    expect(sampled).toEqual(["corrected-win", "corrected-loss", "executed", "plain-pool", "plain-roach"]);
  });

  test("opponent compositions and transitions use only games agreeing on the opponent axis", async () => {
    const listed = jest.spyOn(service, "_listForRulePhases");
    const pages = jest.spyOn(service.perGame, "iterateRulePreviewPages");

    await service.evaluateBuildPhases(USER, "pool-first", { includeTransitions: true });
    expect(pages.mock.calls[0][1]).toEqual(expect.objectContaining({
      view: "agreeing",
      agreeOn: "opponent",
      match: { _customOpponentStrategySlug: "pool-first" },
    }));
    const cohort = await listed.mock.results[0].value;
    expect(cohort.games.map((row) => row.gameId)).toEqual(["executed", "plain-pool", "you-checkin"]);
  });

  test("a strategy-scoped \"you\" cohort agrees on both axes; an unscoped one on \"you\" only", async () => {
    const listed = jest.spyOn(service, "_listForRulePhases");
    const pages = jest.spyOn(service.perGame, "iterateRulePreviewPages");

    await service.evaluateBuildPhases(USER, "dt-rush", {
      includeTransitions: false,
      strategyName: "Pool First",
    });
    expect(pages.mock.calls[0][1]).toEqual(expect.objectContaining({
      view: "agreeing",
      agreeOn: "both",
      match: { _customBuildSlug: "dt-rush", "opponent.strategy": "Pool First" },
    }));
    const scoped = await listed.mock.results[0].value;
    expect(scoped.games.map((row) => row.gameId)).toEqual(["executed", "plain-pool"]);

    await service.evaluateBuildPhases(USER, "dt-rush", { includeTransitions: false });
    expect(pages.mock.calls[1][1]).toEqual(expect.objectContaining({ view: "agreeing", agreeOn: "you" }));
    const unscoped = await listed.mock.results[1].value;
    expect(unscoped.games.map((row) => row.gameId)).toEqual([
      "corrected-win", "corrected-loss", "executed", "plain-pool", "plain-roach",
    ]);
  });
});

describe("rule-preview views (perGameCompute) on the opponent axis", () => {
  async function collect(opts) {
    const perGame = new PerGameComputeService({ games });
    const out = [];
    for await (const page of perGame.iterateRulePreviewPages(USER, opts)) out.push(...page.games);
    return out;
  }

  const labels = (rows) => rows.map((g) => [
    g.gameId, g.opponent?.strategy ?? null, g.customOpponentStrategySlug ?? null,
  ]);

  test("the detector view relabels opponent corrections for the caller and the metadata gate", async () => {
    const gated = [];
    const viewed = await collect({
      view: "detector",
      perspective: "both",
      metadataFilter: (row) => {
        gated.push([row.gameId, row.opponent?.strategy ?? null, row._customOpponentStrategySlug ?? null]);
        return true;
      },
    });
    const detector = [
      ["corrected-win", GENERIC, null],
      ["corrected-loss", "Roach Rush", "roach-rush"],
      ["executed", "Pool First", "pool-first"],
      ["plain-pool", "Pool First", "pool-first"],
      ["plain-roach", "Roach Rush", "roach-rush"],
      ["you-checkin", "Pool First", "pool-first"],
    ];
    expect(labels(viewed)).toEqual(detector);
    expect(gated).toEqual(detector);
    // Both axes swap at once: the "you" check-in row reads its detector label.
    expect(viewed.find((row) => row.gameId === "you-checkin").myBuild).toBe("PvZ - Macro");
    expect(viewed.every((row) => !("buildIntent" in row))).toBe(true);

    const effective = await collect({});
    expect(labels(effective).slice(0, 2)).toEqual([
      ["corrected-win", "Pool First", "pool-first"],
      ["corrected-loss", "Pool First", "pool-first"],
    ]);
  });

  test("listForRulePreview's detector view reports the opponent detector slug explicitly", async () => {
    const perGame = new PerGameComputeService({ games });
    const detector = await perGame.listForRulePreview(USER, { view: "detector" });
    expect(labels(detector).slice(0, 3)).toEqual([
      ["corrected-win", GENERIC, null],
      ["corrected-loss", "Roach Rush", "roach-rush"],
      ["executed", "Pool First", "pool-first"],
    ]);
    const effective = await perGame.listForRulePreview(USER, {});
    expect(effective[0]).toEqual(expect.objectContaining({
      gameId: "corrected-win",
      opponent: expect.objectContaining({ strategy: "Pool First" }),
    }));
    expect(effective[0]).not.toHaveProperty("customOpponentStrategySlug");
    expect(effective[0]).not.toHaveProperty("buildIntent");
  });

  test("the agreeing view drops disagreeing rows on the requested axis", async () => {
    const ids = (rows) => rows.map((row) => row.gameId);
    const perGame = new PerGameComputeService({ games });
    const all = ["corrected-win", "corrected-loss", "executed", "plain-pool", "plain-roach", "you-checkin"];

    expect(ids(await collect({ view: "agreeing" })))
      .toEqual(all.filter((id) => id !== "you-checkin"));
    expect(ids(await collect({ view: "agreeing", agreeOn: "opponent" })))
      .toEqual(["executed", "plain-pool", "plain-roach", "you-checkin"]);
    expect(ids(await collect({ view: "agreeing", agreeOn: "both" })))
      .toEqual(["executed", "plain-pool", "plain-roach"]);
    // A caller's own $and joins the agreement clauses instead of replacing them.
    expect(ids(await collect({
      view: "agreeing",
      agreeOn: "both",
      match: { $and: [{ "opponent.strategy": "Pool First" }] },
    }))).toEqual(["executed", "plain-pool"]);
    expect(ids(await perGame.listForRulePreview(USER, { view: "agreeing", agreeOn: "opponent" })))
      .toEqual(["executed", "plain-pool", "plain-roach", "you-checkin"]);
  });

  test("a catalog correction with no detector label reads null labels in the detector view", async () => {
    await games.insertOne(game("catalog-no-label", 13, { opponent: { displayName: "Opp", race: "Zerg" } }));
    await correct("catalog-no-label", CATALOG_OPP_REF);
    try {
      const viewed = await collect({ view: "detector", match: { gameId: "catalog-no-label" } });
      expect(labels(viewed)).toEqual([["catalog-no-label", null, null]]);
      const effective = await collect({ match: { gameId: "catalog-no-label" } });
      expect(labels(effective)).toEqual([["catalog-no-label", "Zerg - 12 Pool", null]]);
    } finally {
      await games.deleteOne({ gameId: "catalog-no-label" });
    }
  });
});
