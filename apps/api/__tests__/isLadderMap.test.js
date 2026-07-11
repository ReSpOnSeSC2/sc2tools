// @ts-nocheck
"use strict";

const {
  ALL_LADDER_MAPS,
  normalizeMapName,
  buildLadderMapSet,
  buildClassifierSet,
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

  test("ALL_LADDER_MAPS spans many seasons and stays sane", () => {
    expect(ALL_LADDER_MAPS.length).toBeGreaterThan(150);
    // No empties / dupes after normalization isn't required, but the
    // list itself should have no blank entries.
    expect(ALL_LADDER_MAPS.every((m) => typeof m === "string" && m.trim())).toBe(true);
  });

  test("buildClassifierSet recognises retired ladder maps without a live pool", () => {
    const set = buildClassifierSet([]);
    // Retired maps from past seasons — the whole point of the fix.
    expect(isLadderMap("Catalyst LE", set)).toBe(true);
    expect(isLadderMap("Acropolis LE", set)).toBe(true);
    expect(isLadderMap("Cerulean Fall LE", set)).toBe(true);
    // Genuinely-not-a-ladder-map stays false.
    expect(isLadderMap("Marine Arena 9000", set)).toBe(false);
  });

  test("buildClassifierSet unions a brand-new live-pool map on top", () => {
    const set = buildClassifierSet(["Hypothetical New Map S99"]);
    expect(isLadderMap("Hypothetical New Map S99", set)).toBe(true);
    expect(isLadderMap("Site Delta", set)).toBe(true); // still has history
  });
});
