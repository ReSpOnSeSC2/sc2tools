"use strict";

const {
  normalizeMapName,
  buildLadderMapSet,
  isLadderMap,
} = require("../src/util/isLadderMap");

describe("util/isLadderMap", () => {
  test("normalizeMapName strips edition tags, case, and punctuation", () => {
    expect(normalizeMapName("Site Delta LE")).toBe("sitedelta");
    expect(normalizeMapName("site delta")).toBe("sitedelta");
    expect(normalizeMapName("Whispers of Gold")).toBe("whispersofgold");
    expect(normalizeMapName("Hard Lead TE")).toBe("hardlead");
    expect(normalizeMapName(null)).toBe("");
  });

  test("isLadderMap matches across edition-tag / casing variations", () => {
    const set = buildLadderMapSet(["Site Delta", "Goldenaura", "El Dorado"]);
    expect(isLadderMap("Site Delta LE", set)).toBe(true);
    expect(isLadderMap("site delta", set)).toBe(true);
    expect(isLadderMap("Goldenaura", set)).toBe(true);
    expect(isLadderMap("Some Arcade Map", set)).toBe(false);
  });

  test("empty pool or empty name never matches", () => {
    expect(isLadderMap("Site Delta", new Set())).toBe(false);
    expect(isLadderMap("", buildLadderMapSet(["Site Delta"]))).toBe(false);
    expect(isLadderMap("Site Delta", null)).toBe(false);
  });
});
