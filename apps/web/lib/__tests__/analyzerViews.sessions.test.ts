import { expect, it } from "vitest";
import { analyzerViewHref, sanitizeAnalyzerViews, type AnalyzerView } from "../analyzerViews";

const COHORT = { preset: "current_season" as const, race: "P", accounts: "1-S2-1-12345", map_pool: "all" as const, game_size: "all" as const, exclude_too_short: false };

it("reads a Sessions saved view and default pointer without losing its cohort", () => {
  const prefs = sanitizeAnalyzerViews({
    views: [{ id: "sessions-one", name: "Current season sessions", section: "sessions", filters: { ...COHORT, day: "2026-10-27", before: "private-list-cursor", gamesBefore: "private-game-cursor", token: "secret" } }],
    defaultViewId: "sessions-one",
  });
  expect(prefs).toEqual({ views: [{ id: "sessions-one", name: "Current season sessions", section: "sessions", filters: COHORT }], defaultViewId: "sessions-one" });
  const href = analyzerViewHref(prefs.views[0]);
  const url = new URL(href, "https://sc2tools.invalid");
  expect(url.pathname).toBe("/app/sessions");
  expect(Object.fromEntries(url.searchParams)).toEqual({ filters: "1", preset: "current_season", race: "P", accounts: "1-S2-1-12345", map_pool: "all", game_size: "all", exclude_too_short: "false" });
  expect(href).not.toMatch(/private|secret|day=/);
});

it("admits only the Sessions list section, never a saved private report destination", () => {
  const invalid: AnalyzerView = { id: "report", name: "Private report", section: "sessions/private-report", filters: COHORT };
  expect(sanitizeAnalyzerViews({ views: [invalid], defaultViewId: "report" })).toEqual({ views: [], defaultViewId: null });
  expect(new URL(analyzerViewHref(invalid), "https://sc2tools.invalid").pathname).toBe("/app");
});
