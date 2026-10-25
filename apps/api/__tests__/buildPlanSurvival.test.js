"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { STATS_GAME_MATCH } = require("../src/util/gameVisibility");
const { planFacets, finishPlan, planGroupFields, planHeldRate } = require("../src/services/buildPlanSurvival");

/** @type {import('mongodb-memory-server').MongoMemoryServer} */
let mongo;
/** @type {import('mongodb').MongoClient} */
let client;
/** @type {import('mongodb').Collection} */
let games;
const owner = "synthetic-plan-owner";
const declared = { source: "custom", key: "custom:dt", slug: "dt", name: "DT Rush" };
const visible = { userId: owner, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true } };
const bucket = { $switch: { branches: [
  { case: { $in: [{ $toLower: "$result" }, ["win", "victory"]] }, then: "win" },
  { case: { $in: [{ $toLower: "$result" }, ["loss", "defeat"]] }, then: "loss" },
], default: null } };
/** @param {string} gameId @param {{name:string,slug?:string|null}|null} detected @param {Record<string,any>} [patch] */
const row = (gameId, detected, patch = {}) => ({ userId: owner, gameId, myBuild: declared.name, _customBuildSlug: "dt",
  result: "Victory", durationSec: 900, opponent: { strategy: "Zerg - Rush" },
  buildIntent: { status: "confirmed", applied: true, build: declared, detected }, ...patch });
const aggregate = async () => finishPlan((await games.aggregate([
  { $match: visible }, { $set: { _bucket: bucket } }, { $facet: planFacets("$_bucket") },
]).toArray())[0]);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect();
  games = client.db("synthetic_build_plan").collection("games");
});
afterEach(async () => { await games.deleteMany({}); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });

test("the declared cohort includes different detector labels and excludes ordinary/hidden/deleted/foreign/resumed rows", async () => {
  await games.insertMany([
    row("same", { name: "DT Rush", slug: "dt" }),
    row("unknown", null, { result: "Defeat" }),
    row("renamed", { name: "Renamed same identity", slug: "dt" }),
    row("collision", { name: "DT Rush", slug: "different" }, { result: "Defeat" }),
    row("other-win", { name: "Macro transition", slug: null }, { durationSec: 600 }),
    row("other-loss", { name: "Macro transition", slug: null }, { result: "Defeat", durationSec: 1200 }),
    row("tie", null, { result: "Tie" }),
    row("ordinary", null, { buildIntent: undefined }),
    row("hidden", null, { excluded: true }), row("deleted", null, { _deleted: true }),
    row("pending", null, { _deletionPending: true }), row("foreign", null, { userId: "another-owner" }),
    row("resumed", null, { isResumedFromReplay: true }),
  ]);
  const plan = await aggregate();
  expect(plan).toMatchObject({ declared: 7, held: 4, knockedOff: 3, heldDecided: 3, knockedOffDecided: 3,
    knockedInto: [{ name: "Macro transition", count: 2 }, { name: "DT Rush", count: 1 }],
    knockedBy: [{ name: "Zerg - Rush", count: 3 }], durationSamples: 3, durationEstimated: true });
  expect(plan.heldRate).toBeCloseTo(4 / 7); expect(plan.heldWR).toBeCloseTo(2 / 3);
  expect(plan.knockedOffWR).toBeCloseTo(1 / 3); expect(plan.medianKnockedOffDurationSec).toBeCloseTo(900);
  const [performance] = await games.aggregate([{ $match: visible }, { $group: { _id: null, total: { $sum: 1 }, ...planGroupFields() } }]).toArray();
  expect(performance).toMatchObject({ total: 8, planDeclared: 7, planHeld: 4 });
  expect(planHeldRate(performance)).toBeCloseTo(4 / 7);
});

test("ranked differences have deterministic ties and retain only the top five", async () => {
  await games.insertMany(["F", "A", "E", "B", "D", "C"].map(name => row(name, { name, slug: name })));
  expect((await aggregate()).knockedInto).toEqual(["A", "B", "C", "D", "E"].map(name => ({ name, count: 1 })));
});

test("unmeasured/invalid lengths do not become zero-minute observations and draws do not become losses", async () => {
  await games.insertMany([undefined, null, -5, "600", Infinity].map((durationSec, index) => row(String(index), { name: "Other" }, { durationSec, result: "Tie" })));
  expect(await aggregate()).toMatchObject({ declared: 5, held: 0, knockedOff: 5, heldWR: null, knockedOffWR: null,
    heldDecided: 0, knockedOffDecided: 0, durationSamples: 0, medianKnockedOffDurationSec: null });
});

test("a malformed or unconfirmed intent never inflates the declared sample", async () => {
  await games.insertMany([row("pending", null, { buildIntent: { status: "pending", build: declared } }),
    row("missing", null, { buildIntent: { status: "confirmed", build: null } }),
    row("empty", null, { buildIntent: { status: "confirmed", build: { name: "" } } }),
    row("too-short", null, { myBuild: "PvZ - Game Too Short", _customBuildSlug: null,
      buildIntent: { status: "confirmed", applied: false, build: declared, detected: null } }),
  ]);
  expect(await aggregate()).toMatchObject({ declared: 0, heldRate: null, heldWR: null, knockedOffWR: null, knockedInto: [], knockedBy: [] });
});

test("list/card rates are absent until five declared games", () => {
  expect(planHeldRate({ planDeclared: 4, planHeld: 4 })).toBeNull();
  expect(planHeldRate({ planDeclared: 5, planHeld: 0 })).toBe(0);
  expect(planHeldRate({ planDeclared: 5, planHeld: 5 })).toBe(1);
});
