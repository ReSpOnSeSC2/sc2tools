// @ts-nocheck
"use strict";

/**
 * util/mmrBracketing — bucket helpers shared by the MMR-stats
 * service and (via the response shape) the analyzer charts.
 */

const {
  parseBucketWidth,
  bucketFor,
  bracketLabel,
  isBucketInRange,
  parseMmrDelta,
  DEFAULT_BUCKET_WIDTH,
  MIN_BUCKET_WIDTH,
  MAX_BUCKET_WIDTH,
} = require("../src/util/mmrBracketing");

describe("util/mmrBracketing", () => {
  describe("parseBucketWidth", () => {
    test("falls back to default on missing / nullish / blank input", () => {
      expect(parseBucketWidth(undefined)).toBe(DEFAULT_BUCKET_WIDTH);
      expect(parseBucketWidth(null)).toBe(DEFAULT_BUCKET_WIDTH);
      expect(parseBucketWidth("")).toBe(DEFAULT_BUCKET_WIDTH);
    });

    test("snaps to nearest 25 so adjacent URLs share cache keys", () => {
      expect(parseBucketWidth(200)).toBe(200);
      expect(parseBucketWidth(201)).toBe(200);
      expect(parseBucketWidth(213)).toBe(225);
      expect(parseBucketWidth("250")).toBe(250);
    });

    test("clamps below the min and above the max", () => {
      expect(parseBucketWidth(1)).toBe(MIN_BUCKET_WIDTH);
      expect(parseBucketWidth(0)).toBe(MIN_BUCKET_WIDTH);
      expect(parseBucketWidth(99999)).toBe(MAX_BUCKET_WIDTH);
    });

    test("rejects garbage", () => {
      expect(parseBucketWidth("not a number")).toBe(DEFAULT_BUCKET_WIDTH);
      expect(parseBucketWidth({})).toBe(DEFAULT_BUCKET_WIDTH);
    });
  });

  describe("bucketFor", () => {
    test("floors to the bucket's lower bound", () => {
      expect(bucketFor(4500, 200)).toBe(4400);
      expect(bucketFor(4400, 200)).toBe(4400);
      expect(bucketFor(4599, 200)).toBe(4400);
      expect(bucketFor(4600, 200)).toBe(4600);
    });

    test("works for non-200 widths", () => {
      expect(bucketFor(4500, 250)).toBe(4500);
      expect(bucketFor(4499, 250)).toBe(4250);
      expect(bucketFor(4501, 100)).toBe(4500);
    });
  });

  describe("bracketLabel", () => {
    test("renders inclusive boundaries the user can read", () => {
      expect(bracketLabel(4400, 200)).toBe("4400–4599");
      expect(bracketLabel(4500, 250)).toBe("4500–4749");
      expect(bracketLabel(4000, 500)).toBe("4000–4499");
    });
  });

  describe("isBucketInRange", () => {
    test("drops sub-floor and above-ceiling buckets", () => {
      expect(isBucketInRange(800)).toBe(false);
      expect(isBucketInRange(1000)).toBe(true);
      expect(isBucketInRange(4400)).toBe(true);
      expect(isBucketInRange(8000)).toBe(false);
      expect(isBucketInRange(7999)).toBe(true);
    });
  });

  describe("parseMmrDelta", () => {
    test("returns undefined on missing / blank / negative", () => {
      expect(parseMmrDelta(undefined)).toBeUndefined();
      expect(parseMmrDelta(null)).toBeUndefined();
      expect(parseMmrDelta("")).toBeUndefined();
      expect(parseMmrDelta(-1)).toBeUndefined();
      expect(parseMmrDelta("not a number")).toBeUndefined();
    });

    test("rounds and clamps", () => {
      expect(parseMmrDelta(100)).toBe(100);
      expect(parseMmrDelta("200")).toBe(200);
      expect(parseMmrDelta(199.5)).toBe(200);
      expect(parseMmrDelta(99999)).toBeLessThanOrEqual(8000);
    });
  });
});
