// @ts-nocheck
"use strict";

/**
 * util/patchEra.js — the three forms of the 5.0.16 era rule must agree:
 * the query ``$match`` (ladderMeta's original), the aggregation
 * expression (guide_stats pipelines) and the JS function (ingest capture).
 * Every row of the matrix is evaluated by all three against a real mongod.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  PATCH_5_0_16_BUILD,
  PATCH_5_0_16_RELEASE,
  PATCH_ERAS,
  buildEraMatch,
  eraExpression,
  eraForGame,
} = require("../src/util/patchEra");
const ladderMeta = require("../src/services/ladderMeta");

const BEFORE_DATE = new Date(PATCH_5_0_16_RELEASE.getTime() - 60_000);
const AFTER_DATE = new Date(PATCH_5_0_16_RELEASE.getTime() + 60_000);

/** Each row: [label, fields]. ``date`` is always a Date when present (stored rows). */
const MATRIX = [
  ["build after", { gameBuild: PATCH_5_0_16_BUILD, date: BEFORE_DATE }],
  ["build before", { gameBuild: PATCH_5_0_16_BUILD - 1, date: AFTER_DATE }],
  ["build wins over version", { gameBuild: 1, gameVersion: "5.0.16.97425", date: AFTER_DATE }],
  ["build double", { gameBuild: 97364.5 }],
  ["version after", { gameVersion: "5.0.16.97425", date: BEFORE_DATE }],
  ["version before", { gameVersion: "5.0.15.95299", date: AFTER_DATE }],
  ["version exact", { gameVersion: `5.0.16.${PATCH_5_0_16_BUILD}` }],
  ["version unparsable", { gameVersion: "5.0.16.beta", date: AFTER_DATE }],
  ["version empty", { gameVersion: "", date: AFTER_DATE }],
  ["version no dots", { gameVersion: "97425" }],
  ["version leading zeros", { gameVersion: "5.0.16.0097425" }],
  ["version negative", { gameVersion: "5.0.16.-3" }],
  ["version int32 overflow", { gameVersion: "5.0.16.99999999999" }],
  ["version trailing dot", { gameVersion: "5.0.16." }],
  ["version plus sign", { gameVersion: "5.0.16.+97425" }],
  ["version whitespace", { gameVersion: "5.0.16. 97425" }],
  ["string build ignored", { gameBuild: "97425", date: BEFORE_DATE }],
  ["null build + version", { gameBuild: null, gameVersion: "5.0.16.97425" }],
  ["null version falls to date", { gameVersion: null, date: AFTER_DATE }],
  ["date after", { date: AFTER_DATE }],
  ["date before", { date: BEFORE_DATE }],
  ["date at release", { date: new Date(PATCH_5_0_16_RELEASE.getTime()) }],
  ["no era: nothing", {}],
  ["no era: string date", { date: AFTER_DATE.toISOString() }],
  ["no era: null date", { date: null }],
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

  test("$match, aggregation expression and JS agree on every row", async () => {
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
    const docs = await coll.find({}).toArray();
    for (const doc of docs) {
      const fromMatch = byMatch.get(doc.label) ?? null;
      expect({ label: doc.label, era: byExpr.get(doc.label) }).toEqual({ label: doc.label, era: fromMatch });
      if (typeof doc.date === "string") continue; // JS accepts ISO strings (ingest payloads) by design
      expect({ label: doc.label, era: eraForGame(doc) }).toEqual({ label: doc.label, era: fromMatch });
    }
  });

  test("expected eras on the anchor rows", () => {
    expect(eraForGame({ gameBuild: PATCH_5_0_16_BUILD })).toBe("after");
    expect(eraForGame({ gameVersion: "5.0.15.95299" })).toBe("before");
    expect(eraForGame({ gameVersion: "5.0.16.beta", date: AFTER_DATE })).toBe("before");
    expect(eraForGame({ date: PATCH_5_0_16_RELEASE })).toBe("after");
    expect(eraForGame({})).toBeNull();
    expect(eraForGame(null)).toBeNull();
  });

  test("ingest payloads carry an ISO date string", () => {
    expect(eraForGame({ date: AFTER_DATE.toISOString() })).toBe("after");
    expect(eraForGame({ date: BEFORE_DATE.toISOString() })).toBe("before");
    expect(eraForGame({ date: "not a date" })).toBeNull();
  });

  test("ladderMeta keeps re-exporting the moved constants", () => {
    expect(ladderMeta.PATCH_5_0_16_BUILD).toBe(PATCH_5_0_16_BUILD);
    expect(ladderMeta.PATCH_5_0_16_RELEASE).toBe(PATCH_5_0_16_RELEASE);
    expect(ladderMeta.PATCH_ERA_AFTER).toBe("after");
    expect(ladderMeta.PATCH_ERA_BEFORE).toBe("before");
  });
});
