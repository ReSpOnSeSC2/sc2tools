// @ts-nocheck
"use strict";

const {
  canonicalRaceName,
  canonicalRaceLetter,
  pickRaceMmr,
} = require("../src/services/oppMmrStamp");

describe("services/oppMmrStamp", () => {
  test("canonicalRaceName normalises every spelling", () => {
    expect(canonicalRaceName("Protoss")).toBe("Protoss");
    expect(canonicalRaceName("protoss")).toBe("Protoss");
    expect(canonicalRaceName("P")).toBe("Protoss");
    expect(canonicalRaceName("t")).toBe("Terran");
    expect(canonicalRaceName("ZERG")).toBe("Zerg");
    expect(canonicalRaceName("Random")).toBe("Random");
    // Unknown / unrecorded race → null (we won't guess).
    expect(canonicalRaceName("U")).toBeNull();
    expect(canonicalRaceName("")).toBeNull();
    expect(canonicalRaceName(null)).toBeNull();
  });

  test("canonicalRaceLetter returns the first letter or null", () => {
    expect(canonicalRaceLetter("Protoss")).toBe("P");
    expect(canonicalRaceLetter("z")).toBe("Z");
    expect(canonicalRaceLetter("U")).toBeNull();
  });

  test("pickRaceMmr selects the matching race, never the highest", () => {
    // The bug: opponent played Protoss, but we contributed their (higher)
    // Terran rating. pickRaceMmr must return the Protoss row regardless of
    // ordering / magnitude.
    const races = [
      { race: "Terran", mmr: 6159, region: "EU" },
      { race: "Protoss", mmr: 4200, region: "EU" },
    ];
    expect(pickRaceMmr(races, "Protoss")).toEqual({ mmr: 4200, region: "EU" });
    expect(pickRaceMmr(races, "P")).toEqual({ mmr: 4200, region: "EU" });
    expect(pickRaceMmr(races, "Terran")).toEqual({ mmr: 6159, region: "EU" });
  });

  test("pickRaceMmr returns null when there's no team for that race", () => {
    const races = [{ race: "Terran", mmr: 6159, region: "EU" }];
    // Opponent has no Zerg team → we stamp nothing rather than borrow.
    expect(pickRaceMmr(races, "Zerg")).toBeNull();
    expect(pickRaceMmr(races, "U")).toBeNull();
    expect(pickRaceMmr([], "Terran")).toBeNull();
    expect(pickRaceMmr(null, "Terran")).toBeNull();
  });

  test("pickRaceMmr rounds and drops non-positive ratings", () => {
    expect(pickRaceMmr([{ race: "Zerg", mmr: 4123.6 }], "Zerg")).toEqual({
      mmr: 4124,
      region: null,
    });
    expect(pickRaceMmr([{ race: "Zerg", mmr: 0 }], "Zerg")).toBeNull();
  });
});
