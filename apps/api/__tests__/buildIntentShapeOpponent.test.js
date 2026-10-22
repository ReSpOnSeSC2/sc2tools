// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Opponent-axis shape helpers (addendum §A.2): the JS views and the Mongo
 * expressions mirror the "you" axis on ``opponent.strategy`` /
 * ``_customOpponentStrategySlug``, evaluated against a real server.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  AGREES_WITH_DETECTOR_MATCH,
  opponentOverrideActive,
  opponentDetectorView,
  withDetectorLabels,
  OPP_INTENT_LABEL_PROJECTION,
  OPP_OVERRIDE_ACTIVE_EXPR,
  OPP_OVERRIDE_ACTIVE_FILTER,
  DETECTOR_OPP_STRATEGY_EXPR,
  DETECTOR_OPP_SLUG_EXPR,
  OPP_AGREES_WITH_DETECTOR_MATCH,
  OPP_COUNTED_BY_CHECKIN_EXPR,
  OPP_PLANNED_GAME_EXPR,
} = require("../src/services/buildIntentShape");

const CUSTOM_X = { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" };
const CATALOG_Y = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };
const DT = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };

function corrected(build, detected) {
  return { status: "confirmed", applied: true, build, detected };
}

/** One row per opponent-label situation the readers must tell apart. */
const ROWS = [
  { gameId: "plain", opponent: { race: "Zerg", strategy: "Zerg - Macro" }, result: "Victory" },
  {
    gameId: "plain-custom",
    opponent: { race: "Zerg", strategy: "Ling Flood" },
    _customOpponentStrategySlug: "ling-flood",
    result: "Defeat",
  },
  {
    gameId: "not-applied",
    opponent: { race: "Zerg", strategy: "Zerg - Game Too Short" },
    result: "Victory",
    buildIntent: { opponent: { status: "confirmed", applied: false, build: CATALOG_Y, detected: null } },
  },
  {
    gameId: "custom-over-catalog",
    opponent: { race: "Zerg", strategy: "Ling Flood" },
    _customOpponentStrategySlug: "ling-flood",
    result: "Victory",
    buildIntent: {
      notes: "They hid it",
      opponent: corrected(CUSTOM_X, { name: "Zerg - Standard Play (Unclassified)", slug: null }),
    },
  },
  {
    gameId: "catalog-over-custom",
    opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
    result: "Defeat",
    buildIntent: { opponent: corrected(CATALOG_Y, { name: "Roach Rush", slug: "roach-rush" }) },
  },
  {
    gameId: "no-detector",
    opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
    result: "Victory",
    buildIntent: { opponent: corrected(CATALOG_Y, { name: null, slug: null }) },
  },
  {
    gameId: "executed",
    opponent: { race: "Zerg", strategy: "Ling Flood" },
    _customOpponentStrategySlug: "ling-flood",
    result: "Victory",
    buildIntent: { opponent: corrected(CUSTOM_X, { name: "Ling Flood", slug: "ling-flood" }) },
  },
  // A "you"-side check-in that disagrees; the opponent axis is plain.
  {
    gameId: "you-only",
    myBuild: "DT Rush",
    _customBuildSlug: "dt-rush",
    opponent: { race: "Zerg", strategy: "Zerg - Macro" },
    result: "Defeat",
    buildIntent: corrected(DT, { name: "PvZ - Macro", slug: null }),
  },
];

let mongo;
let client;
let games;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  games = client.db("build_intent_shape_opponent").collection("games");
  await games.insertMany(ROWS.map((row) => ({ userId: "u1", ...row })));
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

async function projectAll(expr) {
  const rows = await games.aggregate([
    { $project: { _id: 0, gameId: 1, value: expr } },
    { $sort: { gameId: 1 } },
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row.gameId, row.value]));
}

const byId = Object.fromEntries(ROWS.map((row) => [row.gameId, row]));

describe("JS row views", () => {
  test("opponentOverrideActive needs a confirmed, applied opponent build with a name", () => {
    expect(opponentOverrideActive(byId["custom-over-catalog"])).toBe(true);
    expect(opponentOverrideActive(byId.executed)).toBe(true);
    expect(opponentOverrideActive(byId.plain)).toBe(false);
    expect(opponentOverrideActive(byId["not-applied"])).toBe(false);
    expect(opponentOverrideActive(byId["you-only"])).toBe(false);
    expect(opponentOverrideActive(null)).toBe(false);
    expect(opponentOverrideActive({ buildIntent: { opponent: corrected({ key: "k" }, null) } })).toBe(false);
  });

  test("opponentDetectorView reads the classifier's opponent label on correction rows", () => {
    expect(opponentDetectorView(byId["custom-over-catalog"])).toEqual({
      strategy: "Zerg - Standard Play (Unclassified)",
      customStrategySlug: null,
    });
    expect(opponentDetectorView(byId["catalog-over-custom"])).toEqual({
      strategy: "Roach Rush",
      customStrategySlug: "roach-rush",
    });
    expect(opponentDetectorView(byId["plain-custom"])).toEqual({
      strategy: "Ling Flood",
      customStrategySlug: "ling-flood",
    });
    // Preview rows carry the slug without the underscore.
    expect(opponentDetectorView({ opponent: { strategy: "A" }, customOpponentStrategySlug: "a" }))
      .toEqual({ strategy: "A", customStrategySlug: "a" });
    expect(opponentDetectorView({})).toEqual({ strategy: null, customStrategySlug: null });
  });

  test("withDetectorLabels swaps both axes with explicit nulls and never mutates the row", () => {
    const both = {
      ...byId["you-only"],
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
      buildIntent: {
        ...byId["you-only"].buildIntent,
        opponent: corrected(CUSTOM_X, { name: null, slug: null }),
      },
    };
    const viewed = withDetectorLabels(both);
    expect(viewed).toEqual(expect.objectContaining({
      myBuild: "PvZ - Macro",
      _customBuildSlug: null,
      opponent: { race: "Zerg", strategy: null },
      _customOpponentStrategySlug: null,
    }));
    expect(both.opponent.strategy).toBe("Ling Flood");
    expect(both._customOpponentStrategySlug).toBe("ling-flood");

    const oppOnly = withDetectorLabels(byId["catalog-over-custom"]);
    expect(oppOnly.opponent).toEqual({ race: "Zerg", strategy: "Roach Rush" });
    expect(oppOnly._customOpponentStrategySlug).toBe("roach-rush");
    expect(oppOnly).not.toHaveProperty("myBuild");
    expect(withDetectorLabels(byId.plain)).toBe(byId.plain);
  });

  test("the opponent label projection carries exactly what the views read", () => {
    expect(OPP_INTENT_LABEL_PROJECTION).toEqual({
      "buildIntent.opponent.status": 1,
      "buildIntent.opponent.applied": 1,
      "buildIntent.opponent.build": 1,
      "buildIntent.opponent.detected": 1,
    });
  });
});

describe("Mongo expressions", () => {
  test("OPP_OVERRIDE_ACTIVE_EXPR and OPP_OVERRIDE_ACTIVE_FILTER agree with the JS view", async () => {
    const active = await projectAll(OPP_OVERRIDE_ACTIVE_EXPR);
    for (const row of ROWS) {
      expect([row.gameId, active[row.gameId]]).toEqual([row.gameId, opponentOverrideActive(row)]);
    }
    const filtered = await games.find(OPP_OVERRIDE_ACTIVE_FILTER).project({ _id: 0, gameId: 1 }).toArray();
    expect(filtered.map((row) => row.gameId).sort()).toEqual(
      Object.keys(active).filter((id) => active[id]).sort(),
    );
  });

  test("DETECTOR_OPP_STRATEGY_EXPR / DETECTOR_OPP_SLUG_EXPR mirror opponentDetectorView", async () => {
    const names = await projectAll(DETECTOR_OPP_STRATEGY_EXPR);
    const slugs = await projectAll(DETECTOR_OPP_SLUG_EXPR);
    for (const row of ROWS) {
      const view = opponentDetectorView(row);
      expect([row.gameId, names[row.gameId]]).toEqual([row.gameId, view.strategy]);
      expect([row.gameId, slugs[row.gameId]]).toEqual([row.gameId, view.customStrategySlug]);
    }
  });

  test("OPP_AGREES_WITH_DETECTOR_MATCH drops only disagreeing corrections and composes with $and", async () => {
    const ids = async (filter) => (await games.find(filter).project({ _id: 0, gameId: 1 }).toArray())
      .map((row) => row.gameId).sort();
    expect(await ids({ $and: [{ userId: "u1" }, OPP_AGREES_WITH_DETECTOR_MATCH] })).toEqual([
      "executed", "not-applied", "plain", "plain-custom", "you-only",
    ]);
    // Both $or fragments survive side by side.
    expect(await ids({
      $and: [{ userId: "u1" }, AGREES_WITH_DETECTOR_MATCH, OPP_AGREES_WITH_DETECTOR_MATCH],
    })).toEqual(["executed", "not-applied", "plain", "plain-custom"]);
  });

  test("OPP_COUNTED_BY_CHECKIN_EXPR counts games that count only through a correction", async () => {
    const perRow = await projectAll(OPP_COUNTED_BY_CHECKIN_EXPR);
    expect(perRow).toEqual({
      "catalog-over-custom": 1,
      "custom-over-catalog": 1,
      executed: 0,
      "no-detector": 1,
      "not-applied": 0,
      plain: 0,
      "plain-custom": 0,
      "you-only": 0,
    });
  });

  test("OPP_PLANNED_GAME_EXPR serves detector + shared notes only while a correction is written", async () => {
    const planned = await projectAll(OPP_PLANNED_GAME_EXPR);
    expect(planned["custom-over-catalog"]).toEqual({
      detected: "Zerg - Standard Play (Unclassified)",
      notes: "They hid it",
    });
    expect(planned["no-detector"]).toEqual({ detected: null, notes: "" });
    expect(planned.executed).toEqual({ detected: "Ling Flood", notes: "" });
    expect(planned.plain).toBeNull();
    expect(planned["not-applied"]).toBeNull();
    expect(planned["you-only"]).toBeNull();
  });
});
