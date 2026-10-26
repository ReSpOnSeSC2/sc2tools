import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESET,
  PATCH_5_0_17_RELEASE,
  type PresetId,
} from "@/lib/datePresets";
import { filtersToQuery } from "@/lib/filterContext";
import {
  REGIONS_REV,
  hydrateStoredFilters,
  migrateStoredRegions,
  pickPersisted,
  toStoredFilters,
} from "../AnalyzerProvider";

/**
 * Regression: drill-down filters must NOT persist across reloads.
 *
 * The Opponents/Strategies/etc. tabs read the global ``analyzer.filters``
 * blob from localStorage. Persisting the drill-down filters (map,
 * mmr_min, mmr_max, build, opp_strategy) meant a stale one, set by
 * clicking into a chart/build/MMR bucket, would silently stick and hide
 * opponents (e.g. a ranked opponent vanished from the Opponents tab
 * because an old opp_strategy/mmr filter remained in storage).
 * ``pickPersisted`` is the guard: it keeps only the filter bar's own
 * controls — now including the matchup (race / opp_race), which the
 * Matchup picker shows and edits — on both write and read, which also
 * self-heals sessions that already persisted a stale value.
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

  it("strips session-only drill-down filters so they cannot silently persist", () => {
    const out = pickPersisted({
      preset: "all",
      regions: "EU",
      // The Matchup picker's choice is a visible bar control: it persists.
      race: "Z",
      opp_race: "T",
      // Drill-down filters set by clicking into a chart/build/etc.
      map: "site delta le",
      map_exact: '["site delta le","Site Delta"]',
      map_exact_label: "site delta le",
      mmr_min: 5000,
      mmr_max: 6000,
      build: "PvT - 1 Gate Expand",
      opp_strategy: "TvP - 2-1-1",
    });
    expect(out).toEqual({ preset: "all", regions: "EU", race: "Z", opp_race: "T" });
    expect(out).not.toHaveProperty("map");
    expect(out).not.toHaveProperty("map_exact");
    expect(out).not.toHaveProperty("map_exact_label");
    expect(out).not.toHaveProperty("mmr_min");
    expect(out).not.toHaveProperty("build");
    expect(out).not.toHaveProperty("opp_strategy");
  });

  it("persists the matchup across reloads", () => {
    expect(toStoredFilters({ opp_race: "Z", race: "P", build: "PvZ - Stargate" })).toEqual({
      race: "P",
      opp_race: "Z",
      regions_rev: REGIONS_REV,
    });
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

  // Game length is a FilterBar control with visible pills and a Clear
  // button, so unlike the drill-downs above it belongs in storage: the
  // user can see it is on and can turn it off.
  it("persists the game-length bounds", () => {
    expect(pickPersisted({ min_minutes: 10, max_minutes: 20 })).toEqual({
      min_minutes: 10,
      max_minutes: 20,
    });
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

  it("moves a stored legacy 8-worker preset to the live 12-worker patch", () => {
    // "after_5_0_16" followed the live patch until 5.0.17 restored 12
    // workers; returning users land on the new live patch, re-resolved
    // (not the stale stored dates, not "All time").
    const out = hydrateStoredFilters({
      preset: "after_5_0_16" as PresetId,
      since: "2026-06-22T19:15:00.000Z",
    });
    expect(out.preset).toBe("after_5_0_17");
    expect(out.since).toBe(PATCH_5_0_17_RELEASE.toISOString());
    expect(out.until).toBeUndefined();
  });

  it("defaults a missing or unknown stored preset to auto-track current season", () => {
    expect(hydrateStoredFilters(null).preset).toBe(DEFAULT_PRESET);
    expect(hydrateStoredFilters({ preset: "bogus" as PresetId }).preset).toBe(DEFAULT_PRESET);
    expect(DEFAULT_PRESET).toBe("current_season");
    expect(hydrateStoredFilters({ preset: "after_5_0_17" }).preset).toBe("after_5_0_17");
    expect(hydrateStoredFilters({ preset: "season:68" }).preset).toBe("season:68");
  });

  it("restores a stored game-length range", () => {
    expect(
      hydrateStoredFilters({ preset: "all", min_minutes: 10, max_minutes: 20 }),
    ).toMatchObject({ min_minutes: 10, max_minutes: 20 });
  });

  it("restores a stored matchup as race letters", () => {
    const out = hydrateStoredFilters({ preset: "all", race: "zerg", opp_race: "P" });
    expect(out.race).toBe("Z");
    expect(out.opp_race).toBe("P");
  });

  it("drops an unreadable stored matchup instead of filtering on it", () => {
    const out = hydrateStoredFilters({ preset: "all", race: "x", opp_race: "" });
    expect(out).not.toHaveProperty("race");
    expect(out).not.toHaveProperty("opp_race");
    expect(filtersToQuery(out)).not.toMatch(/race=/);
  });

  it("leaves game length unset when nothing was stored", () => {
    const out = hydrateStoredFilters({ preset: "all" });
    expect(out.min_minutes).toBeUndefined();
    expect(out.max_minutes).toBeUndefined();
  });

  it("re-sanitises garbage bounds instead of forwarding them", () => {
    // localStorage is user-writable and outlives any given build, so a
    // stale or hand-edited blob must not reach the wire. A transposed
    // pair is corrected rather than left to select nothing.
    const junk = hydrateStoredFilters({
      preset: "all",
      min_minutes: -4 as unknown as number,
      max_minutes: "twenty" as unknown as number,
    });
    expect(junk.min_minutes).toBeUndefined();
    expect(junk.max_minutes).toBeUndefined();

    expect(
      hydrateStoredFilters({ preset: "all", min_minutes: 30, max_minutes: 5 }),
    ).toMatchObject({ min_minutes: 5, max_minutes: 30 });
  });
});

/**
 * PTR (Public Test Realm) games have their own region, "PTR". Region
 * selections saved before the PTR pill existed could not have meant to
 * hide them, so they gain PTR once; a selection saved since keeps the
 * user's choice, PTR off included.
 */
describe("stored region selections and PTR", () => {
  it("adds PTR to a selection saved before PTR could be picked", () => {
    const out = hydrateStoredFilters({ preset: "all", regions: "NA,EU" });
    expect(out.regions).toBe("NA,EU,PTR");
    // The revision is storage bookkeeping: never a filter, never sent.
    expect(out).not.toHaveProperty("regions_rev");
    expect(new URLSearchParams(filtersToQuery(out).slice(1)).get("regions"))
      .toBe("NA,EU,PTR");
    expect(filtersToQuery(out)).not.toContain("regions_rev");
  });

  it("stamps every write with the region revision", () => {
    expect(REGIONS_REV).toBe(1);
    expect(toStoredFilters({ preset: "all", regions: "NA,EU,PTR" })).toEqual({
      preset: "all",
      regions: "NA,EU,PTR",
      regions_rev: REGIONS_REV,
    });
    expect(toStoredFilters({ preset: "all" })).toEqual({
      preset: "all",
      regions_rev: REGIONS_REV,
    });
  });

  it("leaves an already-migrated selection without PTR alone", () => {
    // Legacy NA,EU → NA,EU,PTR; the user then turns PTR off, which is
    // written with the revision and survives the next load.
    const migrated = hydrateStoredFilters({ preset: "all", regions: "NA,EU" });
    const ptrOff = toStoredFilters({ ...migrated, regions: "NA,EU" });
    expect(ptrOff.regions_rev).toBe(REGIONS_REV);
    const reloaded = hydrateStoredFilters(pickPersisted(ptrOff));
    expect(reloaded.regions).toBe("NA,EU");
    expect(reloaded).not.toHaveProperty("regions_rev");
  });

  it("has no region selection for fresh storage or storage without one", () => {
    expect(hydrateStoredFilters(null).regions).toBeUndefined();
    expect(hydrateStoredFilters({ preset: "all" }).regions).toBeUndefined();
    expect(hydrateStoredFilters({ preset: "all", regions_rev: REGIONS_REV }).regions)
      .toBeUndefined();
  });

  it("collapses a legacy selection that becomes every region to no filter", () => {
    // All five ladder regions plus PTR is all six: the FilterBar's
    // "no region filter", which also keeps games with no region.
    expect(migrateStoredRegions("NA,EU,KR,CN,SEA", undefined)).toBeUndefined();
  });

  it("orders, de-duplicates and keeps known regions only when migrating", () => {
    expect(migrateStoredRegions(" eu , NA,eu ", undefined)).toBe("NA,EU,PTR");
    expect(migrateStoredRegions("KR,XX", 0)).toBe("KR,PTR");
    // No known region: the old FilterBar showed every region on.
    expect(migrateStoredRegions("XX", undefined)).toBeUndefined();
    expect(migrateStoredRegions("", undefined)).toBeUndefined();
    expect(migrateStoredRegions(42, undefined)).toBeUndefined();
    // A revision written by this build is trusted as chosen.
    expect(migrateStoredRegions("SEA", REGIONS_REV)).toBe("SEA");
    expect(migrateStoredRegions("PTR", REGIONS_REV)).toBe("PTR");
  });

  it("keeps the region revision through the storage read path", () => {
    expect(pickPersisted({ regions: "NA", regions_rev: REGIONS_REV })).toEqual({
      regions: "NA",
      regions_rev: REGIONS_REV,
    });
  });
});
