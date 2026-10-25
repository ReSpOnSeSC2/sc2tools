import { describe, expect, it } from "vitest";
import { analyzerViewHref, isAnalyzerViewPath, replaceViewQuery, sanitizeAnalyzerViews, sanitizeViewFilters, viewFiltersFromQuery, viewFiltersQuery } from "../analyzerViews";

describe("shareable analyzer filters", () => {
  it("round-trips false, zero, bounds, literal labels and exact aliases without credentials", () => {
    const filters = { preset: "custom" as const, since: "2026-10-01T00:00:00.000Z", until: "2026-10-20T00:00:00.000Z", race: "P", opp_race: "Z", map: "Alpha LE", map_exact: JSON.stringify(["Alpha LE", "Alpha"]), map_exact_label: "Alpha LE", macro_min: 0, mmr_min: 4000, mmr_max: 5000, regions: "EU", exclude_too_short: false, build: "A & B + pressure" };
    const query = viewFiltersQuery({ ...filters, token: "private", userId: "other", page: 8 } as typeof filters);
    expect(query.toString()).not.toMatch(/private|userId|page/);
    expect(viewFiltersFromQuery(query)).toMatchObject({ present: true, snapshot: true, filters });
  });

  it("keeps relative presets relative and only custom views retain absolute dates", () => {
    expect(viewFiltersQuery({ preset: "season:67", since: "2026-01-01", until: "2026-02-01" }).toString()).toBe("filters=1&preset=season%3A67");
    expect(sanitizeViewFilters({ since: "2026-10-01" })).toEqual({ preset: "custom", since: "2026-10-01T00:00:00.000Z" });
  });

  it("distinguishes a complete copied snapshot from a partial legacy URL overlay", () => {
    expect(viewFiltersFromQuery(new URLSearchParams("filters=1"))).toMatchObject({ present: true, snapshot: true, filters: {} });
    expect(viewFiltersFromQuery(new URLSearchParams("race=P"))).toMatchObject({ present: true, snapshot: false, keys: ["race"], filters: { race: "P" } });
    expect(viewFiltersFromQuery(new URLSearchParams("q=search&sort=date_desc"))).toMatchObject({ present: false, snapshot: false });
    expect(viewFiltersFromQuery(new URLSearchParams("race=&macro_min="))).toMatchObject({ present: true, keys: expect.arrayContaining(["race", "macro_min"]), filters: {} });
  });

  it("replaces only the supported filter keys while keeping section view state", () => {
    const query = replaceViewQuery("q=hello&sort=date_desc&race=Z&since=2020-01-01&view=table", { preset: "last_7d", race: "P" });
    expect(new URLSearchParams(query).get("q")).toBe("hello");
    expect(new URLSearchParams(query).get("sort")).toBe("date_desc");
    expect(new URLSearchParams(query).get("view")).toBe("table");
    expect(new URLSearchParams(query).get("since")).toBeNull();
    expect(new URLSearchParams(query).get("race")).toBe("P");
    expect(replaceViewQuery(query, { preset: "last_7d", race: "P" })).toBe(query);
  });

  it("drops invalid values and prototype keys and normalizes transposed bounds", () => {
    expect(sanitizeViewFilters(JSON.parse('{"__proto__":{"polluted":true},"token":"x","race":"other","mmr_min":5000,"mmr_max":4000,"regions":"EU,unknown,NA","macro_min":-1,"game_size":"ffa"}'))).toEqual({ mmr_min: 4000, mmr_max: 5000, regions: "NA,EU" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("retains bounded literal exact cohorts and drops stale chip bindings", () => {
    const map_exact = JSON.stringify(["A.* LE", "A.*", "A.*"]);
    expect(sanitizeViewFilters({ map: "A.* LE", map_exact })).toMatchObject({ map_exact: JSON.stringify(["A.* LE", "A.*"]), map_exact_label: "A.* LE" });
    expect(sanitizeViewFilters({ map: "New map", map_exact, map_exact_label: "A.* LE" })).toEqual({ map: "New map" });
    expect(sanitizeViewFilters({ map: "Wrong map", map_exact })).toMatchObject({ map: "A.* LE", map_exact_label: "A.* LE" });
    expect(() => sanitizeViewFilters({ map: "Sanctuary II", map_exact: JSON.stringify(Array.from({ length: 17 }, (_, i) => `Map${i}`)) })).toThrow("invalid exact map cohort");
    expect(viewFiltersFromQuery(new URLSearchParams('map=Sanctuary+II&map_exact=%5Bbroken'))).toMatchObject({ present: true, filters: {}, error: expect.stringContaining("invalid exact map cohort") });
    expect(sanitizeAnalyzerViews({ views: [{ id: "bad", name: "Broken exact view", filters: { map: "Sanctuary II", map_exact: "[broken" } }] }).views).toEqual([]);
  });

  it("normalizes a reversed custom date interval without changing its instants", () => {
    expect(sanitizeViewFilters({ preset: "custom", since: "2026-10-20", until: "2026-10-01" })).toEqual({ preset: "custom", since: "2026-10-01T00:00:00.000Z", until: "2026-10-20T00:00:00.000Z" });
  });

  it("restricts URLs to section routes and carries an explicit Today shortcut", () => {
    expect(analyzerViewHref({ section: "maps", filters: { race: "P" } })).toBe("/app/maps?filters=1&race=P");
    expect(analyzerViewHref({ section: "https://evil.example", filters: {} })).toBe("/app?filters=1&view=today");
    expect(isAnalyzerViewPath("/app/game/g1")).toBe(false);
    expect(isAnalyzerViewPath("/app/opponents/123")).toBe(false);
    expect(isAnalyzerViewPath("/app/opponents")).toBe(true);
  });

  it("bounds stored views, rejects duplicate identities/names and clears an orphaned default", () => {
    const raw = { views: [{ id: "one", name: "Season", section: "maps", filters: { race: "P", token: "x" } }, { id: "two", name: "season", filters: {} }, { id: "one", name: "Other", filters: {} }, { id: "bad", name: "Bad", section: "admin", filters: {} }], defaultViewId: "two" };
    expect(sanitizeAnalyzerViews(raw)).toEqual({ views: [{ id: "one", name: "Season", section: "maps", filters: { race: "P" } }], defaultViewId: null });
    expect(sanitizeAnalyzerViews({ views: Array.from({ length: 15 }, (_, i) => ({ id: `id${i}`, name: `View ${i}`, filters: {} })) }).views).toHaveLength(12);
  });
});
