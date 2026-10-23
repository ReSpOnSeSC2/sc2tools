import { describe, expect, it } from "vitest";
import { ofLastGames, phaseLine } from "../scoutingCopy";
import type { OpponentPhases } from "../types";

function phases(
  typicalFinalPhase: OpponentPhases["typicalFinalPhase"],
  units?: string[],
): OpponentPhases {
  const zero = { early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0 };
  return {
    typicalFinalPhase,
    trajectory: {
      sampleSize: zero,
      crossings: { earlyMidAt: null, midAt: null, midLateAt: null, lateAt: null },
      finalPhaseDistribution: zero,
      durationP95Sec: 0,
    },
    ...(units ? { typicalLateComp: { units, sampleCount: 3, winRate: 0.5 } } : {}),
  };
}

describe("ofLastGames", () => {
  it("reads as a count out of the recent window", () => {
    expect(ofLastGames(3, 5)).toBe("3 of last 5 games");
    expect(ofLastGames(2, 2)).toBe("2 of last 2 games");
  });

  it("stays grammatical for a single game and rounds stray decimals", () => {
    expect(ofLastGames(1, 1)).toBe("1 of 1 game");
    expect(ofLastGames(2.6, 4.2)).toBe("3 of last 4 games");
  });
});

describe("phaseLine", () => {
  it("names the phase games usually end in", () => {
    expect(phaseLine(phases("early"))).toBe("Early game");
    expect(phaseLine(phases("earlyMid"))).toBe("Early/Mid game");
  });

  it("adds up to three units of the army they usually reach, in plain words", () => {
    expect(phaseLine(phases("late", ["Carrier", "VoidRay", "HighTemplar", "Archon"]))).toBe(
      "Late game · Carrier, Void Ray, High Templar",
    );
  });
});
