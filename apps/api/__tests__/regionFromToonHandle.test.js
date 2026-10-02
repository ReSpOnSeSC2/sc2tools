// @ts-nocheck
"use strict";

const {
  regionFromToonHandle,
  isLadderRegion,
  ladderRegionFromToonHandle,
  PTR_REGION,
  REGION_HANDLE_PREFIX,
  REGION_LABELS,
} = require("../src/util/regionFromToonHandle");

// eslint-disable-next-line max-lines-per-function
describe("util/regionFromToonHandle", () => {
  test("maps every Battle.net region segment to its label", () => {
    expect(regionFromToonHandle("1-S2-1-267727")).toBe("NA");
    expect(regionFromToonHandle("2-S2-1-267727")).toBe("EU");
    expect(regionFromToonHandle("3-S2-1-267727")).toBe("KR");
    expect(regionFromToonHandle("5-S2-1-267727")).toBe("CN");
    expect(regionFromToonHandle("6-S2-1-267727")).toBe("SEA");
  });

  test("maps a Public Test Realm 98- handle to PTR", () => {
    expect(regionFromToonHandle("98-S2-1-30230")).toBe("PTR");
    expect(regionFromToonHandle("98-S2-1-25175")).toBe(PTR_REGION);
    expect(PTR_REGION).toBe("PTR");
  });

  test("compares the whole region segment, not its first character", () => {
    // "9" and "981" share a leading character with PTR's "98", and
    // "12" with NA's "1"; none of them is a known region.
    expect(regionFromToonHandle("9-S2-1-1")).toBeNull();
    expect(regionFromToonHandle("981-S2-1-1")).toBeNull();
    expect(regionFromToonHandle("12-S2-1-1")).toBeNull();
    expect(regionFromToonHandle("4-S2-1-1")).toBeNull();
  });

  test("returns null for malformed and non-string input", () => {
    expect(regionFromToonHandle("")).toBeNull();
    expect(regionFromToonHandle("   ")).toBeNull();
    expect(regionFromToonHandle("constructor-S2-1-1")).toBeNull();
    expect(regionFromToonHandle("__proto__-S2-1-1")).toBeNull();
    expect(regionFromToonHandle("toString")).toBeNull();
    expect(regionFromToonHandle(null)).toBeNull();
    expect(regionFromToonHandle(undefined)).toBeNull();
    expect(regionFromToonHandle(98)).toBeNull();
    expect(regionFromToonHandle({})).toBeNull();
  });

  test("REGION_LABELS lists every label in display order, PTR last", () => {
    expect(REGION_LABELS).toEqual(["NA", "EU", "KR", "CN", "SEA", "PTR"]);
    expect(Object.isFrozen(REGION_LABELS)).toBe(true);
  });

  test("REGION_HANDLE_PREFIX is the inverse of regionFromToonHandle", () => {
    expect(REGION_HANDLE_PREFIX).toEqual({
      NA: "1",
      EU: "2",
      KR: "3",
      CN: "5",
      SEA: "6",
      PTR: "98",
    });
    expect(Object.isFrozen(REGION_HANDLE_PREFIX)).toBe(true);
    for (const label of REGION_LABELS) {
      const prefix = REGION_HANDLE_PREFIX[label];
      expect(regionFromToonHandle(`${prefix}-S2-1-1`)).toBe(label);
    }
  });

  test("isLadderRegion is true only for regions with an SC2Pulse ladder", () => {
    for (const region of ["NA", "EU", "KR", "CN", "SEA"]) {
      expect(isLadderRegion(region)).toBe(true);
    }
    expect(isLadderRegion("PTR")).toBe(false);
    expect(isLadderRegion("U")).toBe(false);
    expect(isLadderRegion("na")).toBe(false);
    expect(isLadderRegion("constructor")).toBe(false);
    expect(isLadderRegion("")).toBe(false);
    expect(isLadderRegion(null)).toBe(false);
    expect(isLadderRegion(undefined)).toBe(false);
    expect(isLadderRegion(1)).toBe(false);
  });

  test("ladderRegionFromToonHandle reads a PTR handle as region-unknown", () => {
    expect(ladderRegionFromToonHandle("1-S2-1-267727")).toBe("NA");
    expect(ladderRegionFromToonHandle("6-S2-1-267727")).toBe("SEA");
    expect(ladderRegionFromToonHandle("98-S2-1-30230")).toBeNull();
    expect(ladderRegionFromToonHandle("9-S2-1-1")).toBeNull();
    expect(ladderRegionFromToonHandle(null)).toBeNull();
  });
});
