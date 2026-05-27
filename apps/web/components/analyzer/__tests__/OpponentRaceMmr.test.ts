import { describe, expect, it } from "vitest";

import {
  topHeadlineMmr,
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
};

describe("topHeadlineMmr", () => {
  it("returns the top race + MMR", () => {
    expect(topHeadlineMmr(PILIPILI)).toEqual({ mmr: 5584, race: "Protoss" });
  });

  it("returns null when nothing resolved (UI falls back to stored MMR)", () => {
    const empty: PulseRaceBreakdown = {
      resolved: false,
      races: [],
      topRace: null,
      topMmr: null,
    };
    expect(topHeadlineMmr(empty)).toBeNull();
    expect(topHeadlineMmr(undefined)).toBeNull();
  });

  it("returns null when resolved but topMmr is missing", () => {
    expect(
      topHeadlineMmr({ ...PILIPILI, topRace: null, topMmr: null }),
    ).toBeNull();
  });
});
