import { describe, expect, it } from "vitest";
import {
  OPPONENT_PROFILE_MIN_PLAYERS,
  mapRows,
  meetsPlayerFloor,
  opponentHeading,
  opponentMetaTitle,
  strategyShares,
} from "../communityOpponent";

describe("community opponent helpers", () => {
  it("titles by race and Pulse id, never anything else", () => {
    expect(opponentMetaTitle({ race: "Zerg", pulseCharacterId: "994428" })).toBe("Zerg opponent · Pulse #994428");
    expect(opponentMetaTitle({ race: "P", pulseCharacterId: null })).toBe("Protoss opponent");
    // A toon handle in the id slot is never shown.
    expect(opponentMetaTitle({ race: "Terran", pulseCharacterId: "1-S2-1-267727" })).toBe("Terran opponent");
    expect(opponentMetaTitle({ race: undefined, pulseCharacterId: "7" })).toBe("Opponent · Pulse #7");
  });

  it("names the page by race", () => {
    expect(opponentHeading("Zerg")).toBe("Zerg opponent scouting profile");
    expect(opponentHeading("")).toBe("Opponent scouting profile");
  });

  it("publishes only at the player floor", () => {
    expect(OPPONENT_PROFILE_MIN_PLAYERS).toBe(5);
    expect(meetsPlayerFloor({ contributors: 5 })).toBe(true);
    expect(meetsPlayerFloor({ contributors: 4 })).toBe(false);
    expect(meetsPlayerFloor({ contributors: Number.NaN })).toBe(false);
  });

  it("turns strategy counts into shares, most-seen first", () => {
    expect(strategyShares({ B: 1, A: 3, C: 0 })).toEqual([
      { name: "A", games: 3, share: 0.75 },
      { name: "B", games: 1, share: 0.25 },
    ]);
    expect(strategyShares({})).toEqual([]);
  });

  it("sorts maps by games, then name, dropping empty rows", () => {
    expect(
      mapRows({
        Zeta: { wins: 1, losses: 1 },
        Alpha: { wins: 2, losses: 0 },
        Big: { wins: 3, losses: 2 },
        Empty: { wins: 0, losses: 0 },
      }).map((row) => [row.map, row.games, row.winRate]),
    ).toEqual([
      ["Big", 5, 0.6],
      ["Alpha", 2, 1],
      ["Zeta", 2, 0.5],
    ]);
  });
});
