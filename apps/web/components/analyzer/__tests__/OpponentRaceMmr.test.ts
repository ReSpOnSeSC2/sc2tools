import { describe, expect, it } from "vitest";

import {
  headlineModesDiffer,
  isMmrMode,
  selectHeadlineMmr,
  type PulseRaceBreakdown,
} from "../OpponentRaceMmr";

const PILIPILI: PulseRaceBreakdown = {
  resolved: true,
  races: [
    { race: "Protoss", mmr: 5584, games: 7387, league: "Master", region: "NA" },
    { race: "Zerg", mmr: 5081, games: 1163, league: "Master", region: "NA" },
    { race: "Terran", mmr: 4667, games: 509, league: "Diamond", region: "NA" },
  ],
  topRace: "Protoss",
  topMmr: 5584,
  mostPlayedVsYouRace: "Zerg",
  mostPlayedVsYouMmr: 5081,
};

describe("selectHeadlineMmr", () => {
  it("returns the top race in top mode", () => {
    expect(selectHeadlineMmr(PILIPILI, "top")).toEqual({
      mmr: 5584,
      race: "Protoss",
    });
  });

  it("returns the race played vs you most in vsYou mode", () => {
    expect(selectHeadlineMmr(PILIPILI, "vsYou")).toEqual({
      mmr: 5081,
      race: "Zerg",
    });
  });

  it("falls back to top when the vs-you race has no resolved MMR", () => {
    const b: PulseRaceBreakdown = {
      ...PILIPILI,
      mostPlayedVsYouRace: "Terran",
      mostPlayedVsYouMmr: null,
    };
    expect(selectHeadlineMmr(b, "vsYou")).toEqual({ mmr: 5584, race: "Protoss" });
  });

  it("returns null when nothing resolved (UI falls back to stored MMR)", () => {
    const empty: PulseRaceBreakdown = {
      resolved: false,
      races: [],
      topRace: null,
      topMmr: null,
      mostPlayedVsYouRace: null,
      mostPlayedVsYouMmr: null,
    };
    expect(selectHeadlineMmr(empty, "top")).toBeNull();
    expect(selectHeadlineMmr(undefined, "vsYou")).toBeNull();
  });
});

describe("headlineModesDiffer", () => {
  it("is true when top race != most-played-vs-you race", () => {
    expect(headlineModesDiffer(PILIPILI)).toBe(true);
  });

  it("is false when they're the same race (toggle would be a no-op)", () => {
    expect(
      headlineModesDiffer({ ...PILIPILI, mostPlayedVsYouRace: "Protoss" }),
    ).toBe(false);
  });

  it("is false when unresolved", () => {
    expect(headlineModesDiffer(undefined)).toBe(false);
  });
});

describe("isMmrMode", () => {
  it("guards the persisted value", () => {
    expect(isMmrMode("top")).toBe(true);
    expect(isMmrMode("vsYou")).toBe(true);
    expect(isMmrMode("nonsense")).toBe(false);
    expect(isMmrMode(null)).toBe(false);
  });
});
