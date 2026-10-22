import { describe, expect, it } from "vitest";
import {
  ANALYZER_REGIONS,
  DEFAULT_ANALYZER_FILTERS,
  describeActiveFilters,
} from "../filterContext";

describe("describeActiveFilters", () => {
  it("reports nothing for the defaults (date preset and too-short toggle aside)", () => {
    expect(describeActiveFilters({ ...DEFAULT_ANALYZER_FILTERS })).toEqual([]);
    expect(describeActiveFilters({ ...DEFAULT_ANALYZER_FILTERS, preset: "last_7d", exclude_too_short: false })).toEqual([]);
  });

  it("lists every narrowing filter in filter-bar order with a patch that clears it", () => {
    const active = describeActiveFilters({
      race: "P",
      build: "PvT - 2 Gate Expand",
      opp_race: "T",
      opp_strategy: "Terran - Proxy Reaper",
      map: "Alcyone LE",
      mmr_min: 4000,
      mmr_max: 4500,
      regions: "NA,EU",
      map_pool: "all",
      game_size: "team",
      min_minutes: 10,
      max_minutes: 20,
    });
    expect(active.map((filter) => [filter.key, filter.label, filter.value])).toEqual([
      ["race", "My race", "Protoss"],
      ["build", "My build", "PvT - 2 Gate Expand"],
      ["opp_race", "Opponent race", "Terran"],
      ["opp_strategy", "Opponent strategy", "Terran - Proxy Reaper"],
      ["map", "Map", "Alcyone LE"],
      ["mmr", "MMR", "4000–4500"],
      ["regions", "Regions", "NA, EU"],
      ["map_pool", "Games", "Ladder and custom"],
      ["game_size", "Players", "Team games"],
      ["length", "Length", "10–20 min"],
    ]);
    expect(active.find((filter) => filter.key === "mmr")?.clearPatch).toEqual({ mmr_min: undefined, mmr_max: undefined });
    expect(active.find((filter) => filter.key === "map_pool")?.clearPatch).toEqual({ map_pool: "ladder" });
    // Clearing the opponent race also clears a strategy picked for it.
    expect(active.find((filter) => filter.key === "opp_race")?.clearPatch).toEqual({
      opp_race: undefined,
      opp_strategy: undefined,
    });
  });

  it("treats a region set with every region as no filter", () => {
    expect(describeActiveFilters({ regions: ANALYZER_REGIONS.join(",") })).toEqual([]);
  });

  it("labels open-ended ranges", () => {
    expect(describeActiveFilters({ mmr_min: 5000 })[0].value).toBe("5000+");
    expect(describeActiveFilters({ max_minutes: 8 })[0].value).toBe("under 8 min");
    expect(describeActiveFilters({ map_pool: "nonladder" })[0].value).toBe("Custom only");
    expect(describeActiveFilters({ game_size: "all" })[0].value).toBe("1v1 and team");
  });
});
