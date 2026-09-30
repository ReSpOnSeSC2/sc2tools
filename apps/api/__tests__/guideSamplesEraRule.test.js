// @ts-nocheck
"use strict";

/**
 * services/guideSamples.js relabelEraRule — samples stored under era rule 1
 * ("after" = patch 5.0.16 and later) are relabelled to rule 2 ("after" =
 * the 12-worker game, "before" = the 8-worker patch 5.0.16) once, and the
 * guide_stats recompute runs it before reading any sample.
 */

const { relabelEraRule } = require("../src/services/guideSamples");
const { GuideStatsService } = require("../src/services/guideStats");
const { NOW_MS, startDb, resetDb, sampleRow } = require("./helpers/guideStatsSeed");

describe("guide_samples era rule", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_samples_era_rule"));
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function eras() {
    const rows = await db.guideSamples.find({}, { projection: { _id: 0, gameHash: 1, era: 1, eraRule: 1 } })
      .sort({ gameHash: 1 }).toArray();
    return Object.fromEntries(rows.map((r) => [r.gameHash, [r.era, r.eraRule]]));
  }

  test("swaps rule-1 labels once, stamps them, and leaves rule-2 rows alone", async () => {
    await db.guideSamples.insertMany([
      sampleRow({ gameHash: "old-after", era: "after", eraRule: undefined }),
      sampleRow({ gameHash: "old-before", era: "before", eraRule: undefined }),
      sampleRow({ gameHash: "new-after", era: "after" }),
      sampleRow({ gameHash: "new-before", era: "before" }),
    ]);
    await db.guideSamples.updateMany({ gameHash: /^old-/ }, { $unset: { eraRule: "" } });

    expect(await relabelEraRule(db.guideSamples)).toBe(2);
    const once = await eras();
    expect(once).toEqual({
      "new-after": ["after", 2],
      "new-before": ["before", 2],
      // The 8-worker patch's games were "after" under rule 1.
      "old-after": ["before", 2],
      "old-before": ["after", 2],
    });
    expect(await relabelEraRule(db.guideSamples)).toBe(0);
    expect(await eras()).toEqual(once);
  });

  test("a recompute relabels before it aggregates", async () => {
    await db.guideSamples.insertOne(sampleRow({ gameHash: "old-after", era: "after" }));
    await db.guideSamples.updateOne({ gameHash: "old-after" }, { $unset: { eraRule: "" } });
    await new GuideStatsService(db, { logger: null, now: () => NOW_MS }).recompute();
    expect(await eras()).toEqual({ "old-after": ["before", 2] });
  });
});
