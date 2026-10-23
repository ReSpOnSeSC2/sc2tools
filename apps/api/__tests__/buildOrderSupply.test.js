"use strict";
const { stampBuildSupply } = require("../src/services/buildOrderSupply");

describe("build-order supply samples", () => {
  test("uses the last sample at/before construction start, keeping fractional supply", () => {
    const events = [{ time: 19, name: "Pylon" }, { time: 20, name: "Marine" }, { time: 27, name: "Zergling" }];
    const stats = [{ time: 30, food_used: 25 }, { time: 20, food_used: 18.5 }, { time: 10, food_used: 15 }];
    expect(stampBuildSupply(events, stats).map(row => [row.supply, row.supplyApprox])).toEqual([[15, true], [18.5, true], [18.5, true]]);
    expect(events).toEqual([{ time: 19, name: "Pylon" }, { time: 20, name: "Marine" }, { time: 27, name: "Zergling" }]);
    expect(stats[0].time).toBe(30);
  });
  test("does not invent pre-sample supply, use invalid samples or overwrite exact event counts", () => {
    const events = [{ time: 0 }, { time: 15 }, { time: 20, supply: 17, supplyApprox: false }];
    const stats = [{ time: NaN, food_used: 12 }, { time: 10, food_used: -1 }, { time: 11, food_used: Infinity }, { time: 15, food_used: 0 }];
    expect(stampBuildSupply(events, stats)).toEqual([{ time: 0 }, { time: 15, supply: 0, supplyApprox: true }, { time: 20, supply: 17, supplyApprox: false }]);
    expect(stampBuildSupply(events, null)).toEqual(events);
  });
});
