// @ts-nocheck
"use strict";
// Matchup time series under a captured curve proof: one curve drives the Mongo expectation and every rating window,
// and work under a proof never joins in-flight chart work. Without a proof the original join and curve read stay.
const { AggregationsService } = require("../src/services/aggregations");
const { expectationExpression } = require("../src/services/strengthAdjusted");
const { fitCalibration } = require("../src/services/mmrExpectationMath");

const serviceCurve = { ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]) };
const proofCurve = { ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 300, wins: 240 }, { bin: 23, n: 300, wins: 120 }]) };
const proof = (curve, keyPart) => ({ curve, dependency: keyPart ? { keyPart, expiresAt: 61000, isCurrent: () => true } : null });
const sample = (day, win) => ({ date: new Date(`2026-01-0${day}T12:00:00Z`), win, opponent: 4200, rated: true, expected: 0.4 });
const FACET = { points: [{ bucket: new Date("2026-01-01T00:00:00Z"), race: "Z", wins: 2, losses: 1, total: 3 }],
  ratingSeries: [{ _id: { myRace: "P", race: "Z" }, totalGames: 3, samples: [sample(3, 1), sample(2, 0), sample(1, 1)] },
    { _id: { myRace: "T", race: "P" }, totalGames: 2, samples: [sample(2, 1), sample(1, 0)] }] };
const isProbe = pipeline => pipeline.some(stage => stage.$group?._id === null && stage.$group.minDate);
const expectation = pipeline => pipeline.find(stage => stage.$addFields?._strengthExpected).$addFields._strengthExpected.$cond[1];

function fixture({ holdProbe } = {}) {
  const log = [], facets = [], probes = [];
  const games = { aggregate: jest.fn(pipeline => {
    const probe = isProbe(pipeline);
    log.push(probe ? "probe" : "facet"); (probe ? probes : facets).push(pipeline);
    return { toArray: async () => {
      if (probe) { if (holdProbe) await holdProbe; return [{ minDate: new Date("2026-01-01"), maxDate: new Date("2026-01-03") }]; }
      return [structuredClone(FACET)];
    } };
  }) };
  const mmrExpectation = { curve: jest.fn(async () => { log.push("curve"); return serviceCurve; }) };
  return { service: new AggregationsService({ games }, { mmrExpectation }), games, mmrExpectation, log, facets, probes };
}

test("a captured proof drives the Mongo expectation and every rating window, and the memo is never read", async () => {
  const f = fixture();
  const body = await f.service.matchupTimeseries("u1", { interval: "month", groupByOwnRace: true }, {}, proof(proofCurve, "strength1:p"));
  expect(f.mmrExpectation.curve).not.toHaveBeenCalled();
  expect(f.facets).toHaveLength(1);
  expect(expectation(f.facets[0])).toEqual(expectationExpression(proofCurve));
  expect(expectation(f.facets[0])).not.toEqual(expectationExpression(serviceCurve));
  expect(body.ratingSeries.map(row => row.matchup)).toEqual(["PvZ", "TvP"]);
  for (const row of body.ratingSeries) {
    expect(row.expectation).toEqual({ method: "calibrated", eloScale: expect.any(Number), sampleGames: 600, supportedBins: proofCurve.supportedBins });
  }
});

test("an Elo proof (no curve) stays Elo instead of falling back to the memo", async () => {
  const f = fixture();
  const body = await f.service.matchupTimeseries("u1", { interval: "month" }, {}, proof(null, null));
  expect(f.mmrExpectation.curve).not.toHaveBeenCalled();
  expect(expectation(f.facets[0])).toEqual(expectationExpression(null));
  for (const row of body.ratingSeries) expect(row.expectation.method).toBe("elo");
});

test("without a proof the original join key, probe-then-curve order and memo read are unchanged", async () => {
  const f = fixture(), run = jest.spyOn(f.service.trendsRequests, "run");
  const opts = { interval: "day", tz: "UTC", groupByOwnRace: true };
  const body = await f.service.matchupTimeseries("u1", opts, {});
  expect(run.mock.calls[0][0]).toEqual(["matchupTimeseries", "u1", {}, opts]);
  expect(f.log).toEqual(["probe", "curve", "facet"]);
  expect(expectation(f.facets[0])).toEqual(expectationExpression(serviceCurve));
  for (const row of body.ratingSeries) expect(row.expectation.sampleGames).toBe(400);
});

test("work under different proofs never shares a computation, while proof-less requests still join", async () => {
  const f = fixture(), opts = { interval: "month" };
  await Promise.all([f.service.matchupTimeseries("u1", opts, {}, proof(proofCurve, "strength1:p")),
    f.service.matchupTimeseries("u1", opts, {}, proof(serviceCurve, "strength1:s"))]);
  expect(f.facets.map(expectation)).toEqual([expectationExpression(proofCurve), expectationExpression(serviceCurve)]);
  const g = fixture();
  await Promise.all([g.service.matchupTimeseries("u1", opts, {}), g.service.matchupTimeseries("u1", opts, {})]);
  expect(g.facets).toHaveLength(1); expect(g.mmrExpectation.curve).toHaveBeenCalledTimes(1);
});

test("different proofs share the owner's curve-independent date-range probe, and another owner never does", async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ holdProbe: held }), opts = { interval: "day" };
  const pending = Promise.all([f.service.matchupTimeseries("user-a", opts, {}, proof(proofCurve, "strength1:p")),
    f.service.matchupTimeseries("user-a", opts, {}, proof(serviceCurve, "strength1:s")),
    f.service.matchupTimeseries("user-b", opts, {}, proof(proofCurve, "strength1:p"))]);
  release(); await pending;
  expect(f.probes.map(pipeline => pipeline[0].$match.userId)).toEqual(["user-a", "user-b"]);
  expect(f.facets).toHaveLength(3);
});
