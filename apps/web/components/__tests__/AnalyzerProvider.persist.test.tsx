import { describe, expect, it } from "vitest";
import {
  hydrateStoredFilters,
  pickPersisted,
} from "../AnalyzerProvider";

/**
 * Regression: drill-down filters must NOT persist across reloads.
 *
 * The Opponents/Strategies/etc. tabs read the global ``analyzer.filters``
 * blob from localStorage. The FilterBar only surfaces date range, region,
 * and "hide too-short" — so persisting the drill-down filters (race,
 * opp_race, map, mmr_min, mmr_max, build, opp_strategy) meant a stale one,
 * set by clicking into a chart/build/MMR bucket, would silently stick and
 * hide opponents (e.g. a ranked opponent vanished from the Opponents tab
 * because an old opp_strategy/mmr filter remained in storage with no
 * visible chip and no way to clear it). ``pickPersisted`` is the guard:
 * it strips everything except the user-visible global controls, on both
 * write and read, which also self-heals sessions that already persisted a
 * stale value.
 */
describe("pickPersisted", () => {
  it("keeps only the user-visible global filter controls", () => {
    const out = pickPersisted({
      preset: "current_season",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-03-31T23:59:59.999Z",
      regions: "NA,EU",
      exclude_too_short: true,
      map_pool: "ladder",
      game_size: "1v1",
    });
    expect(out).toEqual({
      preset: "current_season",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-03-31T23:59:59.999Z",
      regions: "NA,EU",
      exclude_too_short: true,
      map_pool: "ladder",
      game_size: "1v1",
    });
  });

  it("strips invisible drill-down filters so they cannot silently persist", () => {
    const out = pickPersisted({
      preset: "all",
      regions: "EU",
      // Drill-down filters set by clicking into a chart/build/etc.
      race: "Z",
      opp_race: "T",
      map: "site delta le",
      mmr_min: 5000,
      mmr_max: 6000,
      build: "PvT - 1 Gate Expand",
      opp_strategy: "TvP - 2-1-1",
    });
    expect(out).toEqual({ preset: "all", regions: "EU" });
    expect(out).not.toHaveProperty("race");
    expect(out).not.toHaveProperty("mmr_min");
    expect(out).not.toHaveProperty("build");
    expect(out).not.toHaveProperty("opp_strategy");
  });

  it("omits undefined keys entirely", () => {
    const out = pickPersisted({ preset: "today", since: undefined });
    expect(out).toEqual({ preset: "today" });
    expect(Object.prototype.hasOwnProperty.call(out, "since")).toBe(false);
  });

  it("persists explicit All choices instead of collapsing them to missing", () => {
    expect(
      pickPersisted({ map_pool: "all", game_size: "all" }),
    ).toEqual({ map_pool: "all", game_size: "all" });
  });
});

describe("hydrateStoredFilters", () => {
  it("defaults fresh and legacy storage to ranked-ladder 1v1", () => {
    expect(hydrateStoredFilters(null)).toMatchObject({
      map_pool: "ladder",
      game_size: "1v1",
      exclude_too_short: true,
    });
    expect(hydrateStoredFilters({ preset: "all" })).toMatchObject({
      preset: "all",
      map_pool: "ladder",
      game_size: "1v1",
    });
  });

  it("preserves explicit All and other stored preferences", () => {
    expect(
      hydrateStoredFilters({
        preset: "custom",
        since: "2026-01-01T00:00:00.000Z",
        map_pool: "all",
        game_size: "all",
        exclude_too_short: false,
      }),
    ).toMatchObject({
      preset: "custom",
      since: "2026-01-01T00:00:00.000Z",
      map_pool: "all",
      game_size: "all",
      exclude_too_short: false,
    });
  });
});
