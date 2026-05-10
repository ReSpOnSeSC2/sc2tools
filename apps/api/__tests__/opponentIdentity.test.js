// @ts-nocheck
"use strict";

/**
 * Pure-helper tests for the cross-toon merge filter. The integration
 * tests in opponentsCrossToonMerge.test.js exercise the full Mongo
 * stack; this file pins the filter shape so a future caller adding
 * its own ``$or`` doesn't accidentally collide with ours.
 */

const {
  opponentGamesFilter,
  attachOpponentIdsToFilter,
} = require("../src/util/opponentIdentity");

describe("opponentGamesFilter", () => {
  test("returns $or when both ids are present", () => {
    expect(
      opponentGamesFilter({
        pulseId: "1-S2-1-437579",
        pulseCharacterId: "340543107",
      }),
    ).toEqual({
      $or: [
        { "opponent.pulseId": "1-S2-1-437579" },
        { "opponent.pulseCharacterId": "340543107" },
      ],
    });
  });

  test("returns plain equality when only pulseId is present", () => {
    expect(
      opponentGamesFilter({ pulseId: "1-S2-1-437579" }),
    ).toEqual({ "opponent.pulseId": "1-S2-1-437579" });
  });

  test("returns plain equality when only pulseCharacterId is present", () => {
    expect(
      opponentGamesFilter({ pulseCharacterId: "340543107" }),
    ).toEqual({ "opponent.pulseCharacterId": "340543107" });
  });

  test("returns null when neither id is present", () => {
    expect(opponentGamesFilter({})).toBeNull();
    expect(opponentGamesFilter({ pulseId: "", pulseCharacterId: "" })).toBeNull();
    expect(opponentGamesFilter(null)).toBeNull();
  });

  test("trims whitespace on either id", () => {
    expect(
      opponentGamesFilter({
        pulseId: "  1-S2-1-1  ",
        pulseCharacterId: " 999 ",
      }),
    ).toEqual({
      $or: [
        { "opponent.pulseId": "1-S2-1-1" },
        { "opponent.pulseCharacterId": "999" },
      ],
    });
  });
});

describe("attachOpponentIdsToFilter", () => {
  test("merges plain equality into the parent filter", () => {
    const filter = { userId: "u1", date: { $gte: new Date(0) } };
    const out = attachOpponentIdsToFilter(filter, { pulseId: "p1" });
    expect(out).toBe(filter);
    expect(filter["opponent.pulseId"]).toBe("p1");
    expect(filter.userId).toBe("u1");
  });

  test("wraps two-branch $or in $and so the parent's $or stays separate", () => {
    const filter = { userId: "u1", $or: [{ a: 1 }, { b: 2 }] };
    attachOpponentIdsToFilter(filter, {
      pulseId: "p1",
      pulseCharacterId: "c1",
    });
    expect(Array.isArray(filter.$and)).toBe(true);
    expect(filter.$and).toEqual([
      {
        $or: [
          { "opponent.pulseId": "p1" },
          { "opponent.pulseCharacterId": "c1" },
        ],
      },
    ]);
    // Parent $or is untouched.
    expect(filter.$or).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("returns null when neither id is usable", () => {
    const filter = { userId: "u1" };
    const out = attachOpponentIdsToFilter(filter, {});
    expect(out).toBeNull();
    // Filter must NOT have been mutated with a partial identity clause.
    expect(filter).toEqual({ userId: "u1" });
  });
});
