import { describe, expect, test } from "vitest";
import {
  RANK_LADDERS,
  RANK_RACES,
  rankNameFor,
  sanitizeRankRace,
} from "@/lib/multichat/rankLadders";

describe("rank ladders", () => {
  test("every race has a 10-step ladder of unique names", () => {
    for (const race of RANK_RACES) {
      const ladder = RANK_LADDERS[race];
      expect(ladder).toHaveLength(10);
      expect(new Set(ladder).size).toBe(10);
    }
  });

  test("rankNameFor clamps and themes by race", () => {
    expect(rankNameFor("protoss", 0)).toBe("Probe");
    expect(rankNameFor("protoss", 9)).toBe("Mothership");
    expect(rankNameFor("terran", 9)).toBe("Battlecruiser");
    expect(rankNameFor("zerg", 1)).toBe("Drone");
    expect(rankNameFor("protoss", 99)).toBe("Mothership");
    expect(rankNameFor("protoss", -3)).toBe("Probe");
  });

  test("sanitizeRankRace defaults to protoss", () => {
    expect(sanitizeRankRace("terran")).toBe("terran");
    expect(sanitizeRankRace("random")).toBe("protoss");
    expect(sanitizeRankRace(undefined)).toBe("protoss");
  });
});
