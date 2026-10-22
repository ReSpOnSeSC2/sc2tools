// @ts-nocheck
"use strict";

/**
 * Build check-in shape helpers: the JS view functions and the Mongo
 * expressions every reader shares, evaluated against a real server so the
 * aggregation semantics ($ifNull on missing paths, $expr inside $or) are
 * exactly what production runs.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  NOTES_MAX_LENGTH,
  catalogKeyForName,
  customKeyForSlug,
  parseBuildKey,
  overrideActive,
  detectorView,
  withDetectorLabels,
  BUILD_INTENT_LABEL_PROJECTION,
  OVERRIDE_ACTIVE_EXPR,
  OVERRIDE_ACTIVE_FILTER,
  DETECTOR_BUILD_EXPR,
  DETECTOR_SLUG_EXPR,
  AGREES_WITH_DETECTOR_MATCH,
  COUNTED_BY_CHECKIN_EXPR,
  PLANNED_GAME_EXPR,
  isTooShortGame,
  sanitizeNotes,
} = require("../src/services/buildIntentShape");

const CUSTOM_X = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const CATALOG_Y = {
  key: "pvz-2-stargate-phoenix",
  name: "PvZ - 2 Stargate Phoenix",
  slug: null,
  source: "catalog",
};

function confirmed(build, detected, extra = {}) {
  return {
    status: "confirmed",
    applied: true,
    build,
    detected,
    notes: "",
    ...extra,
  };
}

/** One row per label situation the readers must tell apart. */
const ROWS = [
  // Plain rows: no check-in at all, or one that never applied.
  { gameId: "plain", myBuild: "PvZ - Macro", result: "Victory" },
  { gameId: "plain-custom", myBuild: "DT Rush", _customBuildSlug: "dt-rush", result: "Defeat" },
  {
    gameId: "pending",
    myBuild: "PvZ - Macro",
    result: "Victory",
    buildIntent: { status: "pending", applied: false, build: null, detected: null },
  },
  {
    gameId: "too-short",
    myBuild: "PvZ - Game Too Short",
    result: "Victory",
    buildIntent: { status: "confirmed", applied: false, build: CATALOG_Y, detected: null },
  },
  // Overrides that disagree with the detector.
  {
    gameId: "custom-over-catalog",
    myBuild: "DT Rush",
    _customBuildSlug: "dt-rush",
    result: "Victory",
    buildIntent: confirmed(CUSTOM_X, { name: "PvZ - Macro Transition (Unclassified)", slug: null }, {
      notes: "Got scouted",
    }),
  },
  {
    gameId: "catalog-over-custom",
    myBuild: "PvZ - 2 Stargate Phoenix",
    result: "Defeat",
    buildIntent: confirmed(CATALOG_Y, { name: "Other Custom", slug: "other-custom" }),
  },
  {
    gameId: "override-no-detector",
    myBuild: "PvZ - 2 Stargate Phoenix",
    result: "Victory",
    buildIntent: confirmed(CATALOG_Y, { name: null, slug: null }),
  },
  // Override that the replay executed anyway: agrees with the detector.
  {
    gameId: "executed",
    myBuild: "DT Rush",
    _customBuildSlug: "dt-rush",
    result: "Victory",
    buildIntent: confirmed(CUSTOM_X, { name: "DT Rush", slug: "dt-rush" }),
  },
];

let mongo;
let client;
let games;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  games = client.db("build_intent_shape").collection("games");
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

describe("build keys", () => {
  test("catalog keys match the web catalog slug and the randomizer ids", () => {
    expect(catalogKeyForName("PvZ - 2 Stargate Phoenix")).toBe("pvz-2-stargate-phoenix");
    expect(catalogKeyForName("  ZvT -- 12 Pool!! ")).toBe("zvt-12-pool");
    expect(catalogKeyForName("x".repeat(200))).toHaveLength(80);
  });

  test("custom keys round-trip through parseBuildKey", () => {
    expect(parseBuildKey(customKeyForSlug("dt-rush_v2.1"))).toEqual({
      source: "custom",
      slug: "dt-rush_v2.1",
    });
    expect(parseBuildKey("pvz-2-stargate-phoenix")).toEqual({
      source: "catalog",
      key: "pvz-2-stargate-phoenix",
    });
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an empty string", ""],
    ["an empty custom slug", "custom:"],
    ["a $-prefixed custom slug", "custom:$bad"],
    ["a display name", "PvZ - Upper"],
    ["whitespace", "has space"],
    ["an over-long key", "a".repeat(201)],
    ["an over-long custom slug", `custom:${"a".repeat(81)}`],
  ])("rejects %s", (_label, key) => {
    expect(parseBuildKey(key)).toBeNull();
  });
});

describe("JS row views", () => {
  const byId = Object.fromEntries(ROWS.map((row) => [row.gameId, row]));

  test("overrideActive needs a confirmed, applied build with a name", () => {
    expect(overrideActive(byId["custom-over-catalog"])).toBe(true);
    expect(overrideActive(byId.executed)).toBe(true);
    expect(overrideActive(byId.plain)).toBe(false);
    expect(overrideActive(byId.pending)).toBe(false);
    expect(overrideActive(byId["too-short"])).toBe(false);
    expect(overrideActive(null)).toBe(false);
    expect(overrideActive({ buildIntent: confirmed({ key: "k" }, null) })).toBe(false);
  });

  test("detectorView reads the classifier's label on override rows", () => {
    expect(detectorView(byId["custom-over-catalog"])).toEqual({
      myBuild: "PvZ - Macro Transition (Unclassified)",
      customBuildSlug: null,
    });
    expect(detectorView(byId["catalog-over-custom"])).toEqual({
      myBuild: "Other Custom",
      customBuildSlug: "other-custom",
    });
    expect(detectorView(byId["plain-custom"])).toEqual({
      myBuild: "DT Rush",
      customBuildSlug: "dt-rush",
    });
    // Preview rows carry the slug without the underscore.
    expect(detectorView({ myBuild: "A", customBuildSlug: "a" })).toEqual({
      myBuild: "A",
      customBuildSlug: "a",
    });
    expect(detectorView({ buildIntent: confirmed(CATALOG_Y, null) })).toEqual({
      myBuild: null,
      customBuildSlug: null,
    });
  });

  test("withDetectorLabels relabels override rows with explicit nulls", () => {
    const viewed = withDetectorLabels(byId["custom-over-catalog"]);
    expect(viewed).toEqual(expect.objectContaining({
      gameId: "custom-over-catalog",
      myBuild: "PvZ - Macro Transition (Unclassified)",
      _customBuildSlug: null,
    }));
    // A || fallback onto another slug field can never reach the declared slug.
    expect(viewed._customBuildSlug || viewed.customBuildSlug || null).toBeNull();
    expect(byId["custom-over-catalog"]._customBuildSlug).toBe("dt-rush");
    const plain = byId["plain-custom"];
    expect(withDetectorLabels(plain)).toBe(plain);
  });

  test("the label projection carries exactly what the views read", () => {
    expect(BUILD_INTENT_LABEL_PROJECTION).toEqual({
      "buildIntent.status": 1,
      "buildIntent.applied": 1,
      "buildIntent.build": 1,
      "buildIntent.detected": 1,
    });
    expect(Object.keys(BUILD_INTENT_LABEL_PROJECTION).join()).not.toMatch(/notes|suggestion/);
  });
});

describe("Mongo expressions", () => {
  test("OVERRIDE_ACTIVE_EXPR and OVERRIDE_ACTIVE_FILTER agree", async () => {
    const active = await projectAll(OVERRIDE_ACTIVE_EXPR);
    expect(active).toEqual({
      "catalog-over-custom": true,
      "custom-over-catalog": true,
      executed: true,
      "override-no-detector": true,
      pending: false,
      plain: false,
      "plain-custom": false,
      "too-short": false,
    });
    const filtered = await games.find(OVERRIDE_ACTIVE_FILTER).project({ _id: 0, gameId: 1 }).toArray();
    expect(filtered.map((row) => row.gameId).sort()).toEqual(
      Object.keys(active).filter((id) => active[id]).sort(),
    );
  });

  test("DETECTOR_BUILD_EXPR / DETECTOR_SLUG_EXPR mirror detectorView", async () => {
    const names = await projectAll(DETECTOR_BUILD_EXPR);
    const slugs = await projectAll(DETECTOR_SLUG_EXPR);
    for (const row of ROWS) {
      const view = detectorView(row);
      expect([row.gameId, names[row.gameId]]).toEqual([row.gameId, view.myBuild]);
      expect([row.gameId, slugs[row.gameId]]).toEqual([row.gameId, view.customBuildSlug]);
    }
  });

  test("AGREES_WITH_DETECTOR_MATCH drops only disagreeing overrides inside a $and", async () => {
    const agreeing = await games
      .find({ $and: [{ userId: "u1" }, AGREES_WITH_DETECTOR_MATCH] })
      .project({ _id: 0, gameId: 1 })
      .toArray();
    expect(agreeing.map((row) => row.gameId).sort()).toEqual([
      "executed", "pending", "plain", "plain-custom", "too-short",
    ]);
  });

  test("COUNTED_BY_CHECKIN_EXPR counts games that count only through a check-in", async () => {
    const [byLabel] = await games.aggregate([
      { $match: { userId: "u1" } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          checkins: { $sum: COUNTED_BY_CHECKIN_EXPR },
        },
      },
    ]).toArray();
    expect(byLabel).toEqual({ _id: null, total: ROWS.length, checkins: 3 });
    const perRow = await projectAll(COUNTED_BY_CHECKIN_EXPR);
    expect(perRow.executed).toBe(0);
    expect(perRow["custom-over-catalog"]).toBe(1);
    expect(perRow["override-no-detector"]).toBe(1);
    expect(perRow.pending).toBe(0);
  });

  test("PLANNED_GAME_EXPR serves detector + notes only while an override is written", async () => {
    const planned = await projectAll(PLANNED_GAME_EXPR);
    expect(planned["custom-over-catalog"]).toEqual({
      detected: "PvZ - Macro Transition (Unclassified)",
      notes: "Got scouted",
    });
    expect(planned["override-no-detector"]).toEqual({ detected: null, notes: "" });
    expect(planned.executed).toEqual({ detected: "DT Rush", notes: "" });
    expect(planned.plain).toBeNull();
    expect(planned.pending).toBeNull();
    expect(planned["too-short"]).toBeNull();
  });
});

describe("guards", () => {
  test("isTooShortGame uses duration or the detector's too-short label", () => {
    expect(isTooShortGame({ durationSec: 44 })).toBe(true);
    expect(isTooShortGame({ durationSec: 45 })).toBe(false);
    expect(isTooShortGame({ durationSec: 0, myBuild: "PvZ - Macro" })).toBe(false);
    expect(isTooShortGame({ myBuild: "PvZ - Game Too Short" })).toBe(true);
    // The detector label decides, not a declared build covering it.
    expect(isTooShortGame({
      myBuild: "DT Rush",
      buildIntent: confirmed(CUSTOM_X, { name: "Protoss - Game Too Short", slug: null }),
    })).toBe(true);
    expect(isTooShortGame(null)).toBe(false);
  });

  test("sanitizeNotes trims, strips control characters and caps the length", () => {
    expect(sanitizeNotes("  went  \u0007DTs\n\tlate  ")).toBe("went  DTs\n\tlate");
    expect(sanitizeNotes("")).toBe("");
    expect(sanitizeNotes(42)).toBeNull();
    expect(sanitizeNotes("a".repeat(NOTES_MAX_LENGTH))).toHaveLength(NOTES_MAX_LENGTH);
    expect(sanitizeNotes("a".repeat(NOTES_MAX_LENGTH + 1))).toBeNull();
    expect(sanitizeNotes(` ${"a".repeat(NOTES_MAX_LENGTH)} `)).toHaveLength(NOTES_MAX_LENGTH);
  });
});
