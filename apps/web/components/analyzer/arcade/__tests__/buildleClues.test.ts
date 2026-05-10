import { describe, expect, test } from "vitest";
import {
  buildleEmoji,
  clueFor,
  deriveFeatures,
  deriveFirstAggression,
  deriveOpeningUnit,
  deriveTechPath,
} from "../modes/games/buildle";

describe("Buildle feature derivation", () => {
  test("tech path keywords map to bucket", () => {
    expect(deriveTechPath("Mech opener")).toBe("mech");
    expect(deriveTechPath("Bio + medivac")).toBe("bio");
    expect(deriveTechPath("Skytoss carriers")).toBe("air");
  });
  test("opening unit picked off keyword first, race default last", () => {
    expect(deriveOpeningUnit("Reaper FE")).toBe("Reaper");
    expect(deriveOpeningUnit("Hellion harass")).toBe("Hellion");
    expect(deriveOpeningUnit("Macro game", "Z")).toBe("Zergling");
  });
  test("first-aggression bucket reads the cheese vs macro keywords", () => {
    expect(deriveFirstAggression("Proxy reaper")).toBe("<4 min");
    expect(deriveFirstAggression("2-base allin")).toBe("4–6 min");
    expect(deriveFirstAggression("Macro 3 base")).toBe("9+ min");
    expect(deriveFirstAggression("Generic build")).toBe("6–9 min");
  });
});

describe("Buildle clue + emoji grid", () => {
  const truth = deriveFeatures("Reaper FE", "T");
  test("clueFor returns match on identical axis", () => {
    const c = clueFor("openingUnit", truth, truth);
    expect(c.state).toBe("match");
  });
  test("clueFor returns miss on differing axis", () => {
    const guess = deriveFeatures("Macro mech", "T");
    expect(clueFor("openingUnit", guess, truth).state).toBe("miss");
  });
  test("emoji grid is the right size and shape", () => {
    const grid = buildleEmoji(["Reaper FE"], "Reaper FE", truth, ["Reaper FE"]);
    expect(grid.split("\n").length).toBe(2); // header + 1 row
    expect(grid).toContain("🟩"); // at least one matched axis
  });
});
