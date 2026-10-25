"use strict";
const { boundedReferenceBuildOrder, validateReferenceBuildOrder } = require("../src/validation/referenceBuildOrder");
const base = { v: 1, source: "game", sourceGameId: "private-game", steps: [{ t: null, supply: 14, action: "Unknown reference", supplyApprox: true }] };
describe("bounded reference build order", () => {
  test("accepts genuine untimed/approximate/unknown reference content without rules", () => {
    expect(validateReferenceBuildOrder(base)).toEqual({ valid: true, value: base });
    expect(validateReferenceBuildOrder({ ...base, steps: [{ t: 0, supply: null, action: "BuildPylon" }] }).valid).toBe(true);
  });
  test.each([
    { ...base, v: 2 }, { ...base, source: "url" }, { ...base, steps: Array(121).fill(base.steps[0]) },
    { ...base, steps: [{ ...base.steps[0], t: -1 }] }, { ...base, steps: [{ ...base.steps[0], t: 86401 }] },
    { ...base, steps: [{ ...base.steps[0], supply: 1001 }] }, { ...base, steps: [{ ...base.steps[0], action: " " }] },
    { ...base, steps: [{ ...base.steps[0], action: "💠".repeat(81) }] }, { ...base, steps: [{ ...base.steps[0], note: "x".repeat(141) }] },
  ])("rejects invalid or over-cap values", value => { expect(validateReferenceBuildOrder(value).valid).toBe(false); });
  test("bounds projection before validation and rejects rather than silently truncating oversized content", () => {
    const value = { ...base, unknown: { child: "x".repeat(1_000_000) }, steps: [{ ...base.steps[0], action: "💠".repeat(10_000), unknown: { large: true } }] };
    const clone = /** @type {any} */ (boundedReferenceBuildOrder(value));
    expect(clone).not.toHaveProperty("unknown"); expect(clone.steps[0]).not.toHaveProperty("unknown"); expect(clone.steps[0].action.length).toBe(162);
    expect(validateReferenceBuildOrder(value).valid).toBe(false);
  });
});
