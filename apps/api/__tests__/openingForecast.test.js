// @ts-nocheck
"use strict";
const { openingForecast } = require("../src/services/openingForecast");
const row = (name, extra = {}) => ({ myRace: "Protoss", opponent: { race: "Zerg", strategy: name }, durationSec: 600, map: "Alcyone", ...extra });
const ctx = { myRace: "P", oppRace: "Z" };
const prior = { matchup: "ZvP", n: 100, bandLabel: "4000–4499", openers: [{ build: "Hatch First", frequency: .6 }, { build: "12 Pool", frequency: .4 }] };

test("single observation remains visibly Low; prior-only never pretends to have personal evidence", () => {
  expect(openingForecast([row("12 Pool")], ctx)).toMatchObject({ effectiveN: 1, confidence: "Low", sampleSize: 1, top: [{ name: "12 Pool", probability: 1, samples: 1, of: 1, why: ["1 of last 1 vs you"] }] });
  expect(openingForecast([], { ...ctx, prior })).toMatchObject({ effectiveN: 0, confidence: "Low", sampleSize: 0, top: [{ name: "Hatch First", probability: .6, samples: 0 }, { name: "12 Pool", probability: .4 }] });
});

test("golden posterior combines three prior games with exponential recency and the current map", () => {
  const result = openingForecast([row("12 Pool"), row("Hatch First", { map: "Other" })], { ...ctx, map: "Alcyone", prior });
  expect(result).toMatchSnapshot();
  const poolWeight = 1.5 + 3 * .4, hatchWeight = Math.pow(2, -1 / 8) + 3 * .6;
  expect(result.top.find(r => r.name === "12 Pool").probability).toBeCloseTo(poolWeight / (poolWeight + hatchWeight), 6);
});

test("without own-rating prior supplied, observations alone are used; wrong prior perspective is rejected", () => {
  const result = openingForecast([row("12 Pool")], ctx);
  expect(result.prior).toBeNull();
  expect(openingForecast([row("12 Pool")], { ...ctx, prior: { ...prior, matchup: "PvZ" } })).toEqual(result);
});

test("map upweight changes rank while the count-only reasons retain raw observations", () => {
  const rows = [row("Hatch First", { map: "Other" }), row("12 Pool")];
  expect(openingForecast(rows, ctx).top[0].name).toBe("Hatch First");
  expect(openingForecast(rows, { ...ctx, map: "Alcyone" }).top[0]).toMatchObject({ name: "12 Pool", samples: 1, of: 2, why: ["1 of last 2 vs you", "1 of 1 on Alcyone"] });
});

test("unknown and omitted-tail probability is retained rather than inflating three displayed rows", () => {
  const result = openingForecast([row("A"), row("B"), row("C"), row("D"), row("")], ctx);
  expect(result.top).toHaveLength(3);
  expect(result.otherProbability).toBeGreaterThan(0);
  expect(result.top.reduce((sum, item) => sum + item.probability, result.otherProbability)).toBeCloseTo(1, 5);
  const partialPrior = openingForecast([], { ...ctx, prior: { ...prior, openers: [{ build: "A", frequency: .2 }] } });
  expect(partialPrior.top[0].probability).toBe(.2);
  expect(partialPrior.otherProbability).toBe(.8);
});

test("matchup, visibility, too-short and resumed guards precede the50-row cap", () => {
  const excluded = [row("Wrong matchup", { myRace: "Terran" }), row("Hidden", { excluded: true }), row("Deleted", { _deleted: true }), row("Pending", { _deletionPending: true }), row("Resumed", { isResumedFromReplay: true }), row("Too short", { durationSec: 20 })];
  const result = openingForecast([...excluded, ...Array.from({ length: 70 }, () => row("Hatch First"))], ctx);
  expect(result.sampleSize).toBe(50);
  expect(result.top.map(r => r.name)).toEqual(["Hatch First"]);
  expect(openingForecast([row("Hatch First")], { myRace: "Random", oppRace: "Zerg", prior }).top).toEqual([]);
});

test("prior floor, malformed distribution and deterministic ties", () => {
  expect(openingForecast([], { ...ctx, prior: { ...prior, n: 49 } }).top).toEqual([]);
  expect(openingForecast([], { ...ctx, prior: { ...prior, openers: [{ build: "A", frequency: .9 }, { build: "B", frequency: .9 }] } }).top).toEqual([]);
  const tied = { ...prior, openers: [{ build: "B", frequency: .5 }, { build: "A", frequency: .5 }] };
  expect(openingForecast([], { ...ctx, prior: tied }).top.map(r => r.name)).toEqual(["A", "B"]);
});

test("personal confidence excludes all prior mass and reaches Medium/High on evidence alone", () => {
  expect(openingForecast(Array.from({ length: 4 }, () => row("A")), ctx).confidence).toBe("Medium");
  expect(openingForecast(Array.from({ length: 20 }, () => row("A")), ctx).confidence).toBe("High");
  expect(openingForecast([row("A")], { ...ctx, prior }).confidence).toBe("Low");
});
