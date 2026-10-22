import { describe, expect, it } from "vitest";
import { gameTitle, matchupLabel } from "../gameTitle";

describe("matchupLabel", () => {
  it("builds PvZ-style labels from names or codes", () => {
    expect(matchupLabel("Protoss", "Zerg")).toBe("PvZ");
    expect(matchupLabel("t", " P ")).toBe("TvP");
    expect(matchupLabel("Random", "Terran")).toBe("RvT");
  });

  it("is null when either race is unknown", () => {
    expect(matchupLabel("Protoss", null)).toBeNull();
    expect(matchupLabel("", "Zerg")).toBeNull();
    expect(matchupLabel("Xel'Naga", "Zerg")).toBeNull();
  });
});

describe("gameTitle", () => {
  it("reads result, matchup and map", () => {
    expect(
      gameTitle({ result: "Defeat", myRace: "Protoss", map: "Alcyone LE", opponent: { race: "Zerg" } }),
    ).toBe("Defeat · PvZ on Alcyone LE");
  });

  it("accepts both result vocabularies", () => {
    const base = { myRace: "Terran", map: "Ghost River", opponent: { race: "Terran" } };
    expect(gameTitle({ ...base, result: "Win" })).toBe("Victory · TvT on Ghost River");
    expect(gameTitle({ ...base, result: "Victory" })).toBe("Victory · TvT on Ghost River");
    expect(gameTitle({ ...base, result: "Loss" })).toBe("Defeat · TvT on Ghost River");
    expect(gameTitle({ ...base, result: "Tie" })).toBe("Tie · TvT on Ghost River");
  });

  it("drops whatever is unknown", () => {
    expect(gameTitle({ result: "Defeat", myRace: "Protoss", opponent: { race: "Zerg" } })).toBe("Defeat · PvZ");
    expect(gameTitle({ result: "Victory", map: " Alcyone LE " })).toBe("Victory · Alcyone LE");
    expect(gameTitle({ result: "Undecided", myRace: "Zerg", map: "", opponent: null })).toBeNull();
    expect(gameTitle({})).toBeNull();
  });
});
