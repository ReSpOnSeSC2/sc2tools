import { describe, expect, test } from "vitest";
import {
  buildleEmoji,
  clueFor,
  deriveFeatures,
  deriveFirstAggression,
  deriveOpeningUnit,
  deriveTechPath,
  openingMeta,
} from "../modes/games/buildle";
import type { BuildleFeatures } from "../modes/games/buildle";

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

describe("Buildle clue states — exact match", () => {
  const truth = deriveFeatures("Reaper FE", "T");
  test("clueFor returns match on identical axis values", () => {
    expect(clueFor("openingUnit", truth, truth).state).toBe("match");
    expect(clueFor("race", truth, truth).state).toBe("match");
    expect(clueFor("techPath", truth, truth).state).toBe("match");
    expect(clueFor("firstAggression", truth, truth).state).toBe("match");
  });
});

describe("Buildle clue states — near (tech path)", () => {
  test("mech ↔ ground is near", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "mech", openingUnit: "Tank", firstAggression: "6–9 min" };
    const truth: BuildleFeatures = { race: "T", techPath: "ground", openingUnit: "Tank", firstAggression: "6–9 min" };
    expect(clueFor("techPath", guess, truth).state).toBe("near");
  });
  test("bio ↔ ground is near", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marine", firstAggression: "4–6 min" };
    const truth: BuildleFeatures = { race: "T", techPath: "ground", openingUnit: "Marine", firstAggression: "4–6 min" };
    expect(clueFor("techPath", guess, truth).state).toBe("near");
  });
  test("air ↔ hybrid is near", () => {
    const guess: BuildleFeatures = { race: "P", techPath: "air", openingUnit: "Void Ray", firstAggression: "6–9 min" };
    const truth: BuildleFeatures = { race: "P", techPath: "hybrid", openingUnit: "Void Ray", firstAggression: "6–9 min" };
    expect(clueFor("techPath", guess, truth).state).toBe("near");
  });
  test("non-adjacent tech pairs are miss", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "mech", openingUnit: "Tank", firstAggression: "6–9 min" };
    const truth: BuildleFeatures = { race: "P", techPath: "air", openingUnit: "Tank", firstAggression: "6–9 min" };
    expect(clueFor("techPath", guess, truth).state).toBe("miss");
  });
});

describe("Buildle clue states — near (timing)", () => {
  test("adjacent timing windows are near", () => {
    const mk = (firstAggression: BuildleFeatures["firstAggression"]): BuildleFeatures => ({
      race: "T",
      techPath: "bio",
      openingUnit: "Marine",
      firstAggression,
    });
    expect(clueFor("firstAggression", mk("<4 min"), mk("4–6 min")).state).toBe("near");
    expect(clueFor("firstAggression", mk("4–6 min"), mk("6–9 min")).state).toBe("near");
    expect(clueFor("firstAggression", mk("6–9 min"), mk("9+ min")).state).toBe("near");
  });
  test("non-adjacent windows are miss", () => {
    const mk = (firstAggression: BuildleFeatures["firstAggression"]): BuildleFeatures => ({
      race: "T",
      techPath: "bio",
      openingUnit: "Marine",
      firstAggression,
    });
    expect(clueFor("firstAggression", mk("<4 min"), mk("6–9 min")).state).toBe("miss");
    expect(clueFor("firstAggression", mk("<4 min"), mk("9+ min")).state).toBe("miss");
  });
});

describe("Buildle clue states — near (opening unit by role)", () => {
  test("same race + role bucket is near (Marine vs Reaper — both T light)", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marine", firstAggression: "4–6 min" };
    const truth: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Reaper", firstAggression: "4–6 min" };
    expect(clueFor("openingUnit", guess, truth).state).toBe("near");
  });
  test("same role but different race is miss (Marine T-light vs Zealot P-light)", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marine", firstAggression: "4–6 min" };
    const truth: BuildleFeatures = { race: "P", techPath: "ground", openingUnit: "Zealot", firstAggression: "4–6 min" };
    expect(clueFor("openingUnit", guess, truth).state).toBe("miss");
  });
  test("different role within same race is miss (Marine light vs Marauder armored)", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marine", firstAggression: "4–6 min" };
    const truth: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marauder", firstAggression: "4–6 min" };
    expect(clueFor("openingUnit", guess, truth).state).toBe("miss");
  });
});

describe("Buildle clue states — race never goes near", () => {
  test("differing races yield miss, never near", () => {
    const guess: BuildleFeatures = { race: "T", techPath: "bio", openingUnit: "Marine", firstAggression: "4–6 min" };
    const truth: BuildleFeatures = { race: "Z", techPath: "ground", openingUnit: "Zergling", firstAggression: "4–6 min" };
    expect(clueFor("race", guess, truth).state).toBe("miss");
  });
});

describe("openingMeta", () => {
  test("returns race + role for known units", () => {
    expect(openingMeta("Marine")).toEqual({ race: "T", role: "light" });
    expect(openingMeta("Marauder")).toEqual({ race: "T", role: "armored" });
    expect(openingMeta("Oracle")).toEqual({ race: "P", role: "caster" });
  });
  test("returns null for default fallback unit", () => {
    expect(openingMeta("Worker")).toBeNull();
  });
});

describe("Buildle emoji grid", () => {
  const truth = deriveFeatures("Reaper FE", "T");
  test("emoji grid is the right size and shape and contains green for the truth row", () => {
    const grid = buildleEmoji(["Reaper FE"], "Reaper FE", truth, ["Reaper FE"]);
    expect(grid.split("\n").length).toBe(2); // header + 1 row
    expect(grid).toContain("🟩");
  });
  test("near states emit a yellow square", () => {
    // Marine vs Reaper: same T-race + light role => "near" on openingUnit.
    const grid = buildleEmoji(["Marine push"], "Reaper FE", truth, ["Marine push", "Reaper FE"]);
    expect(grid).toContain("🟨");
  });
});
