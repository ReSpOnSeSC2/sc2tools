"use strict";

const { RULES, BIN_COUNT, binForDifference, decreasingPav, fitCalibration, expectedWin, inverseExpected, performanceRating } = require("../src/services/mmrExpectationMath");

/** @param {number|null} value */
const measured = value => { if (value === null) throw new Error("Expected measured probability"); return value; };

const supported = () => fitCalibration([{ bin: 0, n: 200, wins: 180 }, { bin: 23, n: 200, wins: 110 }]);

describe("fixed rating expectation math", () => {
  test("uses 48 intervals of 25 across the closed range, without collecting out-of-range tails", () => {
    expect(BIN_COUNT).toBe(48); expect(RULES.binWidth).toBe(25);
    expect(binForDifference(-600)).toEqual({ index: 0, minimum: -600, maximum: -575, center: -587.5 });
    expect(binForDifference(600)).toEqual({ index: 47, minimum: 575, maximum: 600, center: 587.5 });
    expect(binForDifference(-601)).toBeNull(); expect(binForDifference(601)).toBeNull();
    expect(binForDifference(Infinity)).toBeNull();
  });

  test("opponent-minus-player delta decreases expected player wins and pins the Elo400 fallback", () => {
    expect(expectedWin(0)).toBe(.5);
    expect(expectedWin(400)).toBeCloseTo(1/11, 12);
    expect(expectedWin(-400)).toBeCloseTo(10/11, 12);
    expect(expectedWin(NaN)).toBeNull();
    for (let difference = -1000; difference <= 1000; difference += 25) {
      expect(expectedWin(difference)).toBeGreaterThanOrEqual(measured(expectedWin(difference + 25)));
      expect(measured(expectedWin(difference)) + measured(expectedWin(-difference))).toBeCloseTo(1, 12);
    }
  });

  test("weighted decreasing PAV pools a rightward rise rather than reversing the delta convention", () => {
    const fitted = decreasingPav([{ diff: -100, success: 100, weight: 200 }, { diff: 0, success: 300, weight: 400 }, { diff: 100, success: 20, weight: 200 }]);
    expect(fitted.map(row => row.probability)).toEqual([2/3, 2/3, .1]);
  });

  test("requires 200 original games in a bin and never doubles published counts for symmetry constraints", () => {
    expect(fitCalibration([{ bin: 10, n: 199, wins: 100 }])).toEqual({ anchors: [], sampleGames: 0, supportedBins: 0, method: "elo" });
    const fitted = fitCalibration([{ bin: 9, n: 200, wins: 100 }, { bin: 10, n: 400, wins: 300 }]);
    expect(fitted.sampleGames).toBe(600); expect(fitted.supportedBins).toBe(2);
    expect(fitted.anchors).toHaveLength(4);
    expect(fitted.anchors[0].probability).toBeCloseTo(401/602, 12);
    expect(fitted.anchors[1].probability).toBeCloseTo(401/602, 12);
  });

  test("invalid bins and invalid raw counts cannot inflate an edge or become calibration evidence", () => {
    const fitted = fitCalibration([{ bin: -1, n: 1000, wins: 900 }, { bin: 48, n: 1000, wins: 100 }, { bin: 0, n: 200, wins: 201 }, { bin: 1, n: NaN, wins: 10 }, { bin: 2, n: 300, wins: -1 }]);
    expect(fitted.anchors).toEqual([]); expect(fitted.sampleGames).toBe(0);
  });

  test("calibration stays nonincreasing and rating-swap symmetric, including sparse anchors and tails", () => {
    const curve = supported();
    expect(curve.method).toBe("calibrated"); expect(expectedWin(0, curve)).toBeCloseTo(.5, 12);
    for (let difference = -1400; difference <= 1400; difference += 25) {
      expect(expectedWin(difference, curve)).toBeGreaterThanOrEqual(measured(expectedWin(difference + 25, curve)));
      expect(measured(expectedWin(difference, curve)) + measured(expectedWin(-difference, curve))).toBeCloseTo(1, 12);
    }
  });

});

describe("bounded interpolation and inverse math", () => {
  test("finite samples get no exact certainty and keep their raw original sample count", () => {
    for (const wins of [0, 200]) {
      const curve = fitCalibration([{ bin: wins === 0 ? 47 : 0, n: 200, wins }]);
      expect(curve.sampleGames).toBe(200);
      for (const difference of [-1000, -587.5, 0, 587.5, 1000]) {
        expect(expectedWin(difference, curve)).toBeGreaterThan(0);
        expect(expectedWin(difference, curve)).toBeLessThan(1);
      }
    }
  });

  test("Elo-shaped tails meet the supported endpoints without a discontinuity or edge clamp", () => {
    const curve = supported(), last = curve.anchors[curve.anchors.length - 1];
    expect(expectedWin(last.diff, curve)).toBeCloseTo(last.probability, 12);
    expect(expectedWin(last.diff + .000001, curve)).toBeCloseTo(last.probability, 8);
    expect(expectedWin(1200, curve)).toBeLessThan(measured(expectedWin(600, curve)));
    expect(curve.sampleGames).toBe(400);
  });

  test("inverse lookup round-trips measured offsets on interpolation and both tails", () => {
    for (const curve of [null, supported()]) for (const difference of [-1200, -300, 0, 200, 1200]) {
      expect(inverseExpected(measured(expectedWin(difference, curve)), curve)).toBeCloseTo(difference, 8);
    }
    expect(inverseExpected(.25)).toBeCloseTo(400*Math.log10(3), 10);
    expect(inverseExpected(0)).toBeNull(); expect(inverseExpected(1)).toBeNull();
  });

  test("a flat isotonic interval uses its midpoint and preserves swapped performance offsets", () => {
    const curve = { anchors: [{ diff: -200, probability: .7 }, { diff: -100, probability: .7 }, { diff: 100, probability: .3 }, { diff: 200, probability: .3 }] };
    expect(inverseExpected(.7, curve)).toBe(-150); expect(inverseExpected(.3, curve)).toBe(150);
    expect(measured(performanceRating(4200, 7, 10, curve)) + measured(performanceRating(4200, 3, 10, curve))).toBeCloseTo(8400, 10);
  });

  test("malformed, increasing or asymmetric stored curves safely fall back to Elo", () => {
    for (const anchors of [[{ diff: 0, probability: .8 }], [{ diff: -100, probability: .3 }, { diff: 100, probability: .7 }], [{ diff: -100, probability: .8 }, { diff: 100, probability: .3 }]]) {
      expect(expectedWin(200, { anchors })).toBe(expectedWin(200));
      expect(inverseExpected(.25, { anchors })).toBe(inverseExpected(.25));
    }
  });

  test("performance is average opposing rating minus the inverse opponent-minus-player delta", () => {
    expect(performanceRating(4200, 5, 10)).toBe(4200);
    expect(performanceRating(4200, 3, 4)).toBeCloseTo(4200+400*Math.log10(3), 10);
    expect(performanceRating(4200, 1, 4)).toBeCloseTo(4200-400*Math.log10(3), 10);
    for (const [wins,games] of [[0,10],[10,10],[0,0],[2,1],[1,NaN]]) expect(performanceRating(4200, wins, games)).toBeNull();
  });
});
