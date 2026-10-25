import { describe, expect, it } from "vitest";
import { ordinal, percentileOf } from "../benchmarks";

const table = { n: 50, deciles: [10,20,30,40,50,60,70,80,90] };
describe("benchmark percentile interpolation", () => {
  it("uses measured deciles and labels unknown tails without extrapolated precision", () => {
    expect(percentileOf(table, 62)).toEqual({ value: 62, label: "62nd" });
    expect(percentileOf(table, 10)).toEqual({ value: 10, label: "10th" });
    expect(percentileOf(table, 90)).toEqual({ value: 90, label: "90th" });
    expect(percentileOf(table, -500)).toEqual({ value: 10, label: "<10th" });
    expect(percentileOf(table, 500)).toEqual({ value: 90, label: ">90th" });
  });
  it("uses the tied interval's midpoint and refuses malformed/non-monotonic/low-sample tables", () => {
    expect(percentileOf({ n: 50, deciles: Array(9).fill(50) }, 50)).toEqual({ value: 50, label: "50th" });
    expect(percentileOf({ n: 50, deciles: [10,20,30,40,40,40,70,80,90] }, 40)).toEqual({ value: 50, label: "50th" });
    for (const bad of [{ ...table, n: 49 }, { ...table, n: Infinity }, { ...table, deciles: null },
      { ...table, deciles: [1] }, { ...table, deciles: [10,20,30,40,35,60,70,80,90] }, { ...table, deciles: Array(9).fill(NaN) }]) expect(percentileOf(bad, 40)).toBeNull();
    expect(percentileOf(table, NaN)).toBeNull(); expect(percentileOf(table, null)).toBeNull();
  });
  it("formats ordinal exceptions correctly", () => {
    expect([1,2,3,11,12,13,21,22,23].map(ordinal)).toEqual(["1st","2nd","3rd","11th","12th","13th","21st","22nd","23rd"]);
  });
});
