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
const { NOW_MS, startDb, resetDb, sampleRow, statsByKey } = require("./helpers/guideStatsSeed");

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

  test("rule-1 rows played from the revert day on stay unstamped for the backfill", async () => {
    await db.guideSamples.insertMany([
      sampleRow({ gameHash: "day-before", era: "after", eraRule: 1, playedOn: new Date("2026-09-29T00:00:00Z") }),
      sampleRow({ gameHash: "revert-day", era: "after", eraRule: 1, playedOn: new Date("2026-09-30T00:00:00Z") }),
      sampleRow({ gameHash: "no-day-old", era: "after", eraRule: 1, createdAt: new Date("2026-09-28T12:00:00Z") }),
      sampleRow({ gameHash: "no-day-new", era: "after", eraRule: 1, createdAt: new Date("2026-09-30T12:00:00Z") }),
    ]);
    expect(await relabelEraRule(db.guideSamples)).toBe(2);
    expect(await eras()).toEqual({
      "day-before": ["before", 2],
      "no-day-new": ["after", 1],
      "no-day-old": ["before", 2],
      "revert-day": ["after", 1],
    });
  });

  test("rows stamped by a later rule are never swapped", async () => {
    await db.guideSamples.insertMany([
      sampleRow({ gameHash: "rule-1", era: "after", eraRule: 1 }),
      sampleRow({ gameHash: "rule-3", era: "after", eraRule: 3 }),
    ]);
    expect(await relabelEraRule(db.guideSamples)).toBe(1);
    expect(await eras()).toEqual({ "rule-1": ["before", 2], "rule-3": ["after", 3] });
  });

  test("a recompute relabels before it aggregates", async () => {
    // 30 rule-1 "after" samples (8-worker games) from 7 users clear the
    // timing floor only once they are relabelled and stamped.
    const rows = Array.from({ length: 30 }, (_, i) =>
      sampleRow({ gameHash: `old-${String(i).padStart(2, "0")}`, era: "after", milestones: { Pylon: 18 } }));
    await db.guideSamples.insertMany(rows);
    await db.guideSamples.updateMany({}, { $unset: { eraRule: "" } });
    await new GuideStatsService(db, { logger: null, now: () => NOW_MS }).recompute();
    const docs = await statsByKey(db);
    expect(docs.get("build:before:PvZ:stargate-into-glaives").timings).toMatchObject({ samples: 30 });
    expect(docs.get("build:after:PvZ:stargate-into-glaives").timings).toBeNull();
    expect(Object.values(await eras()).every(([era, rule]) => era === "before" && rule === 2)).toBe(true);
  });
});
