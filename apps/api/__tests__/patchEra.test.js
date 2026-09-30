// @ts-nocheck
"use strict";

/**
 * util/patchEra.js — the three forms of the 12-worker / 8-worker era rule
 * must agree: the query ``$match`` (ladderMeta's original), the
 * aggregation expression (guide_stats pipelines) and the JS function
 * (ingest capture). Every row of the matrix is evaluated by all three
 * against a real mongod, and each row pins its expected era.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  PATCH_5_0_16_BUILD,
  PATCH_5_0_16_RELEASE,
  PATCH_5_0_17_BUILD,
  PATCH_5_0_17_RELEASE,
  PATCH_ERA_RULE,
  PATCH_ERAS,
  buildEraMatch,
  eraExpression,
  eraForGame,
  isEightWorkerGame,
} = require("../src/util/patchEra");
const ladderMeta = require("../src/services/ladderMeta");

const MINUTE_MS = 60_000;
/** 12-worker game before 5.0.16. */
const PRE_WINDOW_DATE = new Date(PATCH_5_0_16_RELEASE.getTime() - MINUTE_MS);
/** 8-worker patch 5.0.16. */
const IN_WINDOW_DATE = new Date(PATCH_5_0_16_RELEASE.getTime() + MINUTE_MS);
/** 12-worker game again from 5.0.17. */
const POST_WINDOW_DATE = new Date(PATCH_5_0_17_RELEASE.getTime() + MINUTE_MS);

/**
 * Each row: [label, fields, expected era]. "after" = the 12-worker game,
 * "before" = the 8-worker patch. ``date`` is a Date when present (stored rows).
 */
const MATRIX = [
  // 1. A release string decides alone.
  ["version 5.0.16", { gameVersion: "5.0.16.97425", date: PRE_WINDOW_DATE }, "before"],
  ["version 5.0.16 first build", { gameVersion: `5.0.16.${PATCH_5_0_16_BUILD}` }, "before"],
  ["version 5.0.16 hotfix", { gameVersion: "5.0.16.97563", gameBuild: 97563 }, "before"],
  ["version 5.0.16 unparsable build", { gameVersion: "5.0.16.beta", date: POST_WINDOW_DATE }, "before"],
  ["version 5.0.15", { gameVersion: "5.0.15.95299", date: IN_WINDOW_DATE }, "after"],
  ["version 5.0.17", { gameVersion: "5.0.17.98000", gameBuild: 98000, date: IN_WINDOW_DATE }, "after"],
  ["version wins over build", { gameVersion: "5.0.17.1", gameBuild: 97425 }, "after"],
  ["version wins over build (8-worker)", { gameVersion: "5.0.16.97425", gameBuild: 1 }, "before"],
  ["version 5.0.160 is not 5.0.16", { gameVersion: "5.0.160.1" }, "after"],
  ["version 15.0.16 is not 5.0.16", { gameVersion: "15.0.16.1" }, "after"],
  ["version without the build", { gameVersion: "5.0.16" }, "after"],
  ["version empty", { gameVersion: "", date: IN_WINDOW_DATE }, "after"],
  ["version no dots", { gameVersion: "97425" }, "after"],
  // 2. Else the numeric build.
  ["build 5.0.16", { gameBuild: PATCH_5_0_16_BUILD, date: PRE_WINDOW_DATE }, "before"],
  ["build before 5.0.16", { gameBuild: PATCH_5_0_16_BUILD - 1, date: IN_WINDOW_DATE }, "after"],
  ["build double", { gameBuild: 97364.5 }, "before"],
  ["null version falls to build", { gameVersion: null, gameBuild: 97425, date: POST_WINDOW_DATE }, "before"],
  // 3. Else the date.
  ["string build ignored", { gameBuild: "97425", date: PRE_WINDOW_DATE }, "after"],
  ["null build + version fall to date", { gameBuild: null, gameVersion: null, date: IN_WINDOW_DATE }, "before"],
  ["date before 5.0.16", { date: PRE_WINDOW_DATE }, "after"],
  ["date at 5.0.16 release", { date: new Date(PATCH_5_0_16_RELEASE.getTime()) }, "before"],
  ["date in the 8-worker window", { date: IN_WINDOW_DATE }, "before"],
  ["date just before 5.0.17", { date: new Date(PATCH_5_0_17_RELEASE.getTime() - 1) }, "before"],
  ["date at 5.0.17 release", { date: new Date(PATCH_5_0_17_RELEASE.getTime()) }, "after"],
  ["date after 5.0.17", { date: POST_WINDOW_DATE }, "after"],
  // No era.
  ["no era: nothing", {}, null],
  ["no era: string date", { date: IN_WINDOW_DATE.toISOString() }, null],
  ["no era: null date", { date: null }, null],
];

describe("util/patchEra", () => {
  let mongo;
  let client;
  let coll;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    coll = client.db("sc2tools_test_patch_era").collection("rows");
    await coll.insertMany(MATRIX.map(([label, fields]) => ({ label, ...fields })));
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  test("$match, aggregation expression and JS agree on every row, and on its expected era", async () => {
    const byMatch = new Map();
    for (const era of PATCH_ERAS) {
      const rows = await coll.find(buildEraMatch(era)).project({ label: 1 }).toArray();
      for (const row of rows) {
        expect(byMatch.has(row.label)).toBe(false); // branches are exclusive
        byMatch.set(row.label, era);
      }
    }
    const byExpr = new Map(
      (await coll.aggregate([{ $project: { label: 1, era: eraExpression() } }]).toArray())
        .map((row) => [row.label, row.era]),
    );
    const expected = new Map(MATRIX.map(([label, , era]) => [label, era]));
    const docs = await coll.find({}).toArray();
    expect(docs).toHaveLength(MATRIX.length);
    for (const doc of docs) {
      const fromMatch = byMatch.get(doc.label) ?? null;
      expect({ label: doc.label, era: fromMatch }).toEqual({ label: doc.label, era: expected.get(doc.label) });
      expect({ label: doc.label, era: byExpr.get(doc.label) }).toEqual({ label: doc.label, era: fromMatch });
      if (typeof doc.date === "string") continue; // JS accepts ISO strings (ingest payloads) by design
      expect({ label: doc.label, era: eraForGame(doc) }).toEqual({ label: doc.label, era: fromMatch });
    }
  });

  test("the 8-worker window is 5.0.16 until today's 5.0.17 revert", () => {
    expect(PATCH_ERA_RULE).toBe(2);
    expect(PATCH_5_0_17_RELEASE.toISOString()).toBe("2026-09-30T04:00:00.000Z");
    expect(PATCH_5_0_17_BUILD).toBeNull();
    expect(isEightWorkerGame({ gameVersion: "5.0.16.97425" })).toBe(true);
    expect(isEightWorkerGame({ gameVersion: "5.0.17.98000" })).toBe(false);
    expect(isEightWorkerGame({ gameVersion: "5.0.15.95299" })).toBe(false);
    expect(isEightWorkerGame({ date: IN_WINDOW_DATE })).toBe(true);
    expect(isEightWorkerGame({})).toBe(false);
    expect(isEightWorkerGame(null)).toBe(false);
    expect(eraForGame(null)).toBeNull();
  });

  test("ingest payloads carry an ISO date string", () => {
    expect(eraForGame({ date: IN_WINDOW_DATE.toISOString() })).toBe("before");
    expect(eraForGame({ date: PRE_WINDOW_DATE.toISOString() })).toBe("after");
    expect(eraForGame({ date: POST_WINDOW_DATE.toISOString() })).toBe("after");
    expect(eraForGame({ date: "not a date" })).toBeNull();
  });

  test("ladderMeta keeps re-exporting the moved constants", () => {
    expect(ladderMeta.PATCH_5_0_16_BUILD).toBe(PATCH_5_0_16_BUILD);
    expect(ladderMeta.PATCH_5_0_16_RELEASE).toBe(PATCH_5_0_16_RELEASE);
    expect(ladderMeta.PATCH_ERA_AFTER).toBe("after");
    expect(ladderMeta.PATCH_ERA_BEFORE).toBe("before");
  });
});
