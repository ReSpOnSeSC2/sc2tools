import { describe, expect, it } from "vitest";
import {
  ANALYZER_REGIONS,
  DEFAULT_ANALYZER_FILTERS,
  MAX_GAME_LENGTH_MINUTES,
  PTR_REGION,
  filtersToQuery,
  normalizeGameLengthBounds,
} from "../filterContext";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

describe("filtersToQuery", () => {
  it("serializes the ranked-ladder 1v1 defaults", () => {
    const query = params(filtersToQuery(DEFAULT_ANALYZER_FILTERS));
    expect(query.get("map_pool")).toBe("ladder");
    expect(query.get("game_size")).toBe("1v1");
    expect(query.get("exclude_too_short")).toBe("true");
    expect(query.has("preset")).toBe(false);
  });

  it("sends a patch preset's patch_era, and never the preset id", () => {
    // Default: "After 5.0.17 · 12 workers" keeps 12-worker games only, so a
    // game still played on 5.0.16 after the 5.0.17 notes stays out.
    expect(params(filtersToQuery(DEFAULT_ANALYZER_FILTERS)).get("patch_era")).toBe("after");
    // "5.0.16 · 8 workers" has no dates: the version alone selects it, so
    // the 5.0.16 PTR games played before the live release are kept.
    const eightWorker = params(filtersToQuery({ preset: "patch_5_0_16" }));
    expect(eightWorker.get("patch_era")).toBe("before");
    expect(eightWorker.has("since")).toBe(false);
    expect(eightWorker.has("until")).toBe(false);
    expect(eightWorker.has("preset")).toBe(false);
    // "Before 5.0.16 · 12 workers" keeps its date and drops those PTR games.
    const before = params(filtersToQuery({ preset: "before_5_0_16", until: "2026-06-22T19:14:59.999Z" }));
    expect(before.get("patch_era")).toBe("after");
    expect(before.get("until")).toBe("2026-06-22T19:14:59.999Z");
    for (const preset of ["all", "last_7d", "custom", "season:67"]) {
      expect(params(filtersToQuery({ preset })).has("patch_era")).toBe(false);
    }
    // An explicit value wins over the preset's.
    expect(params(filtersToQuery({ preset: "after_5_0_17", patch_era: "before" })).getAll("patch_era"))
      .toEqual(["before"]);
  });

  it("omits explicit All sentinels while retaining other filters", () => {
    const query = params(
      filtersToQuery({
        map_pool: "all",
        game_size: "all",
        regions: "NA,EU",
      }),
    );
    expect(query.has("map_pool")).toBe(false);
    expect(query.has("game_size")).toBe(false);
    expect(query.get("regions")).toBe("NA,EU");
  });

  it("sends a region selection that includes PTR, and never the stored region revision", () => {
    expect(ANALYZER_REGIONS).toEqual(["NA", "EU", "KR", "CN", "SEA", PTR_REGION]);
    expect(PTR_REGION).toBe("PTR");
    const query = params(filtersToQuery({ regions: "NA,PTR", regions_rev: 1 }));
    expect(query.get("regions")).toBe("NA,PTR");
    expect(query.has("regions_rev")).toBe(false);
  });

  it("sends game-length bounds and omits the unset ones", () => {
    expect(params(filtersToQuery({ min_minutes: 10, max_minutes: 20 })).get(
      "min_minutes",
    )).toBe("10");
    expect(params(filtersToQuery({ min_minutes: 10, max_minutes: 20 })).get(
      "max_minutes",
    )).toBe("20");

    const openEnded = params(filtersToQuery({ min_minutes: 20 }));
    expect(openEnded.get("min_minutes")).toBe("20");
    expect(openEnded.has("max_minutes")).toBe(false);
  });

  it("leaves the query byte-identical when no length is chosen", () => {
    // "Any length" is the default. It must not add a parameter, or
    // every existing bookmark and cache key shifts for no reason.
    const withUndefined = filtersToQuery({
      ...DEFAULT_ANALYZER_FILTERS,
      min_minutes: undefined,
      max_minutes: undefined,
    });
    expect(withUndefined).toBe(filtersToQuery(DEFAULT_ANALYZER_FILTERS));
  });
});

describe("normalizeGameLengthBounds", () => {
  it("keeps a well-formed pair", () => {
    expect(normalizeGameLengthBounds(10, 20)).toEqual({
      min_minutes: 10,
      max_minutes: 20,
    });
  });

  it("parses the strings the number inputs hand back", () => {
    expect(normalizeGameLengthBounds("7", "13")).toEqual({
      min_minutes: 7,
      max_minutes: 13,
    });
  });

  it.each([
    ["empty", "", ""],
    ["non-numeric", "ten", "soon"],
    ["negative", -5, -1],
    ["zero", 0, 0],
    ["null", null, null],
    ["undefined", undefined, undefined],
  ])("treats %s input as no constraint", (_label, min, max) => {
    expect(normalizeGameLengthBounds(min, max)).toEqual({});
  });

  it("swaps a transposed pair rather than selecting nothing", () => {
    expect(normalizeGameLengthBounds(30, 5)).toEqual({
      min_minutes: 5,
      max_minutes: 30,
    });
  });

  it("clamps an absurd bound and floors a fractional one", () => {
    expect(normalizeGameLengthBounds(1, 999_999).max_minutes).toBe(
      MAX_GAME_LENGTH_MINUTES,
    );
    expect(normalizeGameLengthBounds(9.9, undefined).min_minutes).toBe(9);
  });
});
