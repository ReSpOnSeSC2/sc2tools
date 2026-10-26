import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, resolvePreset } from "@/lib/datePresets";
import {
  DEFAULT_ANALYZER_FILTERS,
  FILTER_LABELS,
  activeRegionCodes,
  applyFilterPatch,
  defaultAnalyzerFilters,
  describeActiveFilters,
  filtersToQuery,
  normalizeRaceCode,
  withMyRace,
  withOppRace,
  type AnalyzerFilters,
} from "@/lib/filterContext";

const DEFAULTS: AnalyzerFilters = defaultAnalyzerFilters();

/** Every facet moved off its default at once. */
const EVERYTHING: AnalyzerFilters = {
  ...DEFAULTS,
  preset: "last_30d",
  since: "2026-09-20T00:00:00.000Z",
  until: "2026-10-19T23:59:59.999Z",
  regions: "NA,EU",
  map_pool: "all",
  game_size: "team",
  min_minutes: 10,
  max_minutes: 20,
  exclude_too_short: false,
  race: "P",
  opp_race: "Z",
  build: "PvZ - Stargate Opener",
  opp_strategy: "ZvP - 12 Pool",
  map: "Ghost River",
  mmr_min: 4000,
  mmr_max: 5000,
};

function keysOf(filters: AnalyzerFilters): string[] {
  return describeActiveFilters(filters).map((f) => f.key);
}

describe("defaultAnalyzerFilters", () => {
  it("is the product defaults with the current season resolved", () => {
    expect(DEFAULTS).toEqual({
      ...DEFAULT_ANALYZER_FILTERS,
      since: resolvePreset("current_season").since?.toISOString(),
      until: expect.any(String),
    });
    expect(DEFAULTS.preset).toBe(DEFAULT_PRESET);
  });
});

describe("describeActiveFilters", () => {
  it("clears the full exact alias cohort with the visible map chip", () => {
    const filters = { map: "Alpha LE", map_exact: '["Alpha LE","Alpha"]', map_exact_label: "Alpha LE" };
    const chip = describeActiveFilters(filters).find((entry) => entry.key === "map")!;
    const cleared = applyFilterPatch(filters, chip.clearPatch);
    expect(filtersToQuery(cleared)).toBe("");
    expect(cleared.map_exact).toBeUndefined(); expect(cleared.map_exact_label).toBeUndefined();
  });

  it("lists nothing for the defaults", () => {
    expect(describeActiveFilters(DEFAULTS)).toEqual([]);
    expect(describeActiveFilters({ ...DEFAULT_ANALYZER_FILTERS })).toEqual([]);
  });

  it("gives one entry per non-default facet, in chip order", () => {
    expect(keysOf(EVERYTHING)).toEqual([
      "preset",
      "regions",
      "map_pool",
      "game_size",
      "length",
      "exclude_too_short",
      "race",
      "opp_race",
      "build",
      "opp_strategy",
      "map",
      "mmr",
    ]);
  });

  it("labels each facet in plain words from FILTER_LABELS", () => {
    const byKey = Object.fromEntries(
      describeActiveFilters(EVERYTHING).map((f) => [f.key, `${f.label}: ${f.value}`]),
    );
    expect(byKey).toEqual({
      preset: "Date range: Last 30 days",
      regions: "Regions: NA, EU",
      map_pool: "Game type: Both",
      game_size: "Game size: Team",
      length: "Length: 10–20 min",
      exclude_too_short: "Too-short games: Shown",
      race: "Your race: Protoss",
      opp_race: "Opponent race: Zerg",
      build: "Your build: PvZ - Stargate Opener",
      opp_strategy: "Opponent strategy: ZvP - 12 Pool",
      map: "Map: Ghost River",
      mmr: "MMR: 4000–5000",
    });
    for (const f of describeActiveFilters(EVERYTHING)) {
      expect(f.label).toBe(FILTER_LABELS[f.key]);
    }
  });

  it("marks the Strategies drill-downs, and only those, as set in Strategies", () => {
    const setIn = describeActiveFilters(EVERYTHING)
      .filter((f) => f.setIn)
      .map((f) => [f.key, f.setIn]);
    expect(setIn).toEqual([
      ["build", "Strategies"],
      ["opp_strategy", "Strategies"],
    ]);
  });

  it("clears exactly one facet with each clearPatch", () => {
    const all = describeActiveFilters(EVERYTHING);
    for (const chip of all) {
      const after = applyFilterPatch(EVERYTHING, chip.clearPatch);
      expect(keysOf(after), chip.key).toEqual(
        all.map((f) => f.key).filter((k) => k !== chip.key),
      );
    }
  });

  it("puts the date range back on the auto-tracked current season", () => {
    const [preset] = describeActiveFilters({ ...DEFAULTS, preset: "all" });
    expect(preset.value).toBe("All time");
    expect(applyFilterPatch({ ...DEFAULTS, preset: "all" }, preset.clearPatch)).toEqual({ ...DEFAULTS, until: expect.any(String) });
  });

  it("names a custom range by its dates", () => {
    const [chip] = describeActiveFilters({
      ...DEFAULTS,
      preset: "custom",
      since: "2026-03-02T12:00:00.000Z",
      until: "2026-04-10T12:00:00.000Z",
    });
    expect(chip.key).toBe("preset");
    expect(chip.value).toMatch(/2026.*–.*2026/);
    expect(chip.value).toMatch(/Mar/);
    expect(chip.value).toMatch(/Apr/);
  });

  it("treats a full or unreadable region list as every region", () => {
    expect(keysOf({ ...DEFAULTS, regions: "NA,EU,KR,CN,SEA,PTR" })).toEqual([]);
    expect(keysOf({ ...DEFAULTS, regions: "XX" })).toEqual([]);
    expect(keysOf({ ...DEFAULTS, regions: " " })).toEqual([]);
    expect(describeActiveFilters({ ...DEFAULTS, regions: "kr, na" })[0].value).toBe("NA, KR");
  });

  it("describes custom-only games and open-ended lengths and MMR", () => {
    const values = (f: AnalyzerFilters) => describeActiveFilters(f).map((d) => d.value);
    expect(values({ ...DEFAULTS, map_pool: "nonladder" })).toEqual(["Custom games"]);
    expect(values({ ...DEFAULTS, game_size: "all" })).toEqual(["All"]);
    expect(values({ ...DEFAULTS, min_minutes: 20 })).toEqual(["20+ min"]);
    expect(values({ ...DEFAULTS, max_minutes: 10 })).toEqual(["< 10 min"]);
    expect(values({ ...DEFAULTS, mmr_min: 4200 })).toEqual(["4200+"]);
    expect(values({ ...DEFAULTS, mmr_max: 3000 })).toEqual(["Up to 3000"]);
  });

  it("names a Random opponent and ignores an unreadable race", () => {
    expect(describeActiveFilters({ ...DEFAULTS, opp_race: "R" })[0].value).toBe("Random");
    expect(keysOf({ ...DEFAULTS, race: "?" })).toEqual([]);
  });
});

describe("withOppRace (the global matchup setter)", () => {
  it("sets the opponent race as a letter", () => {
    expect(withOppRace(DEFAULTS, "Z")).toEqual({ ...DEFAULTS, opp_race: "Z" });
    expect(filtersToQuery(withOppRace(DEFAULTS, "zerg"))).toMatch(/opp_race=Z/);
  });

  it("clears the matchup without leaving an empty key behind", () => {
    const out = withOppRace({ ...DEFAULTS, opp_race: "T" }, undefined);
    expect(out).not.toHaveProperty("opp_race");
  });

  it("drops a strategy picked for another race, and keeps it when widening to All", () => {
    const zerg = { ...DEFAULTS, opp_race: "Z", opp_strategy: "ZvP - 12 Pool" };
    expect(withOppRace(zerg, "T")).toEqual({ ...DEFAULTS, opp_race: "T" });
    expect(withOppRace(zerg, undefined)).toEqual({ ...DEFAULTS, opp_strategy: "ZvP - 12 Pool" });
  });

  it("returns the same object when nothing changes", () => {
    const zerg = { ...DEFAULTS, opp_race: "Z" };
    expect(withOppRace(zerg, "Z")).toBe(zerg);
  });
});

describe("withMyRace", () => {
  it("sets your race and drops a build picked for another race", () => {
    const protoss = { ...DEFAULTS, race: "P", build: "PvZ - Stargate Opener" };
    expect(withMyRace(protoss, "Z")).toEqual({ ...DEFAULTS, race: "Z" });
    expect(withMyRace(protoss, undefined)).toEqual({ ...DEFAULTS, build: "PvZ - Stargate Opener" });
  });
});

describe("small helpers", () => {
  it("normalizeRaceCode keeps a race letter and nothing else", () => {
    expect(normalizeRaceCode("Protoss")).toBe("P");
    expect(normalizeRaceCode(" t ")).toBe("T");
    expect(normalizeRaceCode("Random")).toBe("R");
    expect(normalizeRaceCode("")).toBeUndefined();
    expect(normalizeRaceCode("x")).toBeUndefined();
    expect(normalizeRaceCode(3)).toBeUndefined();
  });

  it("activeRegionCodes returns pill order and falls back to every region", () => {
    expect(activeRegionCodes("eu,na")).toEqual(["NA", "EU"]);
    expect(activeRegionCodes(undefined)).toEqual(["NA", "EU", "KR", "CN", "SEA", "PTR"]);
    expect(activeRegionCodes("nope")).toEqual(["NA", "EU", "KR", "CN", "SEA", "PTR"]);
  });

  it("applyFilterPatch removes keys the patch sets to undefined", () => {
    const out = applyFilterPatch({ ...DEFAULTS, map: "Ghost River" }, { map: undefined });
    expect(Object.prototype.hasOwnProperty.call(out, "map")).toBe(false);
  });
});
