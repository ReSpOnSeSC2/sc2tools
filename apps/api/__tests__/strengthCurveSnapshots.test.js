// @ts-nocheck
"use strict";
const { MmrExpectationService } = require("../src/services/mmrExpectation");
const { fitCalibration, expectedWin } = require("../src/services/mmrExpectationMath");
const { finishStrength } = require("../src/services/strengthAdjusted");
const { StrengthCurveSnapshots } = require("../src/services/strengthCurveSnapshots");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const calibrated = extra => ({ ruleVersion: 1, ...fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]), ...extra });
function fixture(doc = calibrated()) {
  let now = 1000;
  const coll = { findOne: jest.fn(async () => doc), replaceOne: jest.fn(async () => ({ acknowledged: true })) };
  const games = { aggregate: jest.fn(() => ({ toArray: async () => [{ bin: 0, n: 300, wins: 200 }] })) };
  const service = new MmrExpectationService({ games, db: { collection: () => coll } }, { now: () => now });
  return { service, coll, games, doc, advance: ms => { now += ms; }, setClock: value => { now = value; } };
}

test("one bounded immutable envelope drives exact math and emitted evidence metadata", async () => {
  const f = fixture(); const snapshot = await f.service.snapshot();
  const key = snapshot.dependency.keyPart, p = expectedWin(200, snapshot.curve);
  expect(snapshot.dependency.isCurrent()).toBe(true);
  expect(Object.isFrozen(snapshot.curve)).toBe(true); expect(Object.isFrozen(snapshot.curve.anchors[0])).toBe(true);
  f.doc.anchors[0].probability = .99; f.doc.sampleGames = 99999;
  expect(expectedWin(200, snapshot.curve)).toBe(p); expect(snapshot.curve.sampleGames).toBe(400);
  expect((await f.service.snapshot()).dependency.keyPart).toBe(key);
  expect(f.coll.findOne).toHaveBeenCalledWith({ _id: "corpus-1v1" }); expect(f.coll.findOne).toHaveBeenCalledTimes(1);
});

test.each(["sampleGames", "supportedBins"])("%s alone changes both the complete key and response metadata", async field => {
  const f = fixture(), first = await f.service.snapshot();
  const original = finishStrength({ ratedGames: 1, ratedWins: 1, expectedWins: .5 }, first.curve);
  f.doc[field] += 1; f.advance(60000); const next = await f.service.snapshot();
  expect(next.dependency.keyPart).not.toBe(first.dependency.keyPart);
  expect(next.curve.anchors).toEqual(first.curve.anchors);
  expect(finishStrength({ ratedGames: 1, ratedWins: 1, expectedWins: .5 }, next.curve).expectation[field]).toBe(original.expectation[field] + 1);
  expect(first.dependency.isCurrent()).toBe(false);
});

test.each([null, { ruleVersion: 2 }, calibrated({ anchors: [] }), new Error("unavailable")])("baseline Elo fallback keeps one sixty-second lazy read and never rebuilds", async value => {
  const f = fixture(value); if (value instanceof Error) f.coll.findOne.mockRejectedValue(value);
  const [a, b] = await Promise.all([f.service.snapshot(), f.service.snapshot()]);
  expect(a.curve).toBeNull(); expect(a).toBe(b); expect(a.dependency.isCurrent()).toBe(true);
  expect(await f.service.curve()).toBeNull(); expect(f.coll.findOne).toHaveBeenCalledTimes(1);
  f.advance(60000); expect(a.dependency.isCurrent()).toBe(false);
  const next = await f.service.snapshot(); expect(next.dependency.keyPart).not.toBe(a.dependency.keyPart);
  expect(f.coll.findOne).toHaveBeenCalledTimes(2); expect(f.games.aggregate).not.toHaveBeenCalled();
});

test.each(["400", -1, Infinity, { large: "x".repeat(10000) }])("unsupported metadata bypasses retention without changing the baseline value", async sampleGames => {
  const f = fixture(calibrated({ sampleGames }));
  expect(await f.service.snapshot()).toEqual({ curve: f.doc, dependency: null });
  expect(await f.service.curve()).toBe(f.doc); expect(f.coll.findOne).toHaveBeenCalledTimes(1);
});

test("old IO keeps its pre-read epoch even when it overwrites the baseline memo after successful publish", async () => {
  const f = fixture(), gate = deferred(); f.coll.findOne.mockReturnValueOnce(gate.promise);
  const old = f.service.snapshot(); await Promise.resolve(); await f.service.recompute();
  const published = await f.service.snapshot(); expect(published.dependency.isCurrent()).toBe(true);
  gate.resolve(f.doc); expect((await old).dependency).toBeNull();
  expect(await f.service.curve()).toBe(f.doc); expect((await f.service.snapshot()).dependency).toBeNull();
  expect(published.dependency.isCurrent()).toBe(false); expect(f.coll.findOne).toHaveBeenCalledTimes(1);
  f.advance(60000); expect((await f.service.snapshot()).dependency.isCurrent()).toBe(true);
});

test("a load started during recompute cannot acquire the final publication epoch", async () => {
  const f = fixture(), write = deferred(), read = deferred();
  f.coll.replaceOne.mockReturnValueOnce(write.promise);
  const recompute = f.service.recompute(); await Promise.resolve(); await Promise.resolve();
  f.coll.findOne.mockReturnValueOnce(read.promise); const old = f.service.snapshot();
  write.resolve({ acknowledged: true }); await recompute;
  const published = await f.service.snapshot(); read.resolve(f.doc);
  expect((await old).dependency).toBeNull(); expect(published.dependency.isCurrent()).toBe(false);
  expect((await f.service.snapshot()).dependency).toBeNull();
});

test.each(["aggregate", "publish"])("failed or unknown %s retires authority but preserves the original baseline memo", async phase => {
  const f = fixture(), before = await f.service.snapshot(), error = new Error("unknown outcome");
  if (phase === "aggregate") f.games.aggregate.mockImplementationOnce(() => { throw error; });
  else f.coll.replaceOne.mockRejectedValueOnce(error);
  await expect(f.service.recompute()).rejects.toBe(error);
  expect(before.dependency.isCurrent()).toBe(false); expect(await f.service.curve()).toBe(f.doc);
  expect((await f.service.snapshot()).dependency).toBeNull(); expect(f.coll.findOne).toHaveBeenCalledTimes(1);
});

test("nonfinite clocks deny retention and a new memo with identical data never reuses old identity", async () => {
  const f = fixture(), first = await f.service.snapshot(); f.advance(60000);
  const next = await f.service.snapshot(); expect(next.curve).toEqual(first.curve);
  expect(next.dependency.keyPart).not.toBe(first.dependency.keyPart);
  f.setClock(-Infinity); expect(next.dependency.isCurrent()).toBe(false);
});

test("an unacknowledged publish preserves baseline return and curve, but grants no retention proof", async () => {
  const f = fixture(); f.coll.replaceOne.mockResolvedValueOnce({ acknowledged: false });
  await expect(f.service.recompute()).resolves.toMatchObject({ method: "calibrated" });
  expect(await f.service.curve()).not.toBeNull(); expect((await f.service.snapshot()).dependency).toBeNull();
  expect(f.coll.findOne).not.toHaveBeenCalled();
});

test.each(["curve proxy", "anchor proxy", "anchor accessor"])("%s bypasses snapshot copying without evaluating its getter", mode => {
  const getter = jest.fn(() => 999), raw = calibrated(); let memo;
  if (mode === "anchor accessor") Object.defineProperty(raw.anchors, "0", { get: getter });
  if (mode === "anchor proxy") raw.anchors[0] = new Proxy(raw.anchors[0], { get: getter });
  const value = mode === "curve proxy" ? new Proxy(raw, { get: getter }) : raw;
  const snapshots = new StrengthCurveSnapshots(() => memo, () => 1000);
  memo = snapshots.memo(value, 61000, snapshots.origin());
  const result = snapshots.capture(memo);
  expect(Object.is(result.curve, value)).toBe(true); expect(result.dependency).toBeNull(); expect(getter).not.toHaveBeenCalled();
});
