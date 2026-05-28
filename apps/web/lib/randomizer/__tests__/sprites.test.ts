import { describe, expect, it } from "vitest";
import { resolveStrategyIcons } from "@/lib/sc2-icons";
import { spriteFor } from "@/components/randomizer/reveals/spriteShared";
import { REVEAL_STYLES, type RandomizerBuild } from "@/lib/randomizer/types";

/**
 * The sprite reveals turn a build name into a real SC2 UNIT icon. These
 * guard that contract: builds resolve to a unit sprite (never a
 * building / upgrade), unmatched names fall back to the race's
 * signature unit, and the full style roster stays in sync.
 */
function build(name: string, race: RandomizerBuild["race"] = "Protoss"): RandomizerBuild {
  return { id: name, name, race, source: "catalog", weight: 1 };
}

describe("spriteFor (unit-only)", () => {
  it("picks the unit icon for a Stargate build (voidray, not the building)", () => {
    const sprite = spriteFor(build("PvT - Stargate Opener"));
    expect(sprite).toContain("/units/");
  });

  it("resolves the dark templar unit for a DT build", () => {
    const sprite = spriteFor(build("Protoss - DT Rush"));
    expect(sprite).toContain("/units/darktemplar");
  });

  it("falls back to the race signature unit when no unit keyword matches", () => {
    // "4 Gate Blink" resolves to a gateway (building) + blink (upgrade)
    // but no unit — so the sprite must be the Protoss signature unit.
    const sprite = spriteFor(build("PvT - 4 Gate Blink"));
    expect(sprite).toContain("/units/");
    expect(sprite).not.toContain("/buildings/");
    expect(sprite).not.toContain("/upgrades/");
  });

  it("uses the race unit for an unmatchable custom name", () => {
    expect(resolveStrategyIcons("My Secret Cheese", 6)).toEqual([]);
    expect(spriteFor(build("My Secret Cheese", "Terran"))).toContain(
      "/units/marine",
    );
  });
});

describe("reveal style roster", () => {
  it("includes the six icon-sprite styles", () => {
    for (const style of [
      "fighter",
      "race",
      "sumo",
      "asteroid",
      "swarm",
      "claw",
    ]) {
      expect(REVEAL_STYLES).toContain(style);
    }
  });

  it("has 11 distinct styles", () => {
    expect(new Set(REVEAL_STYLES).size).toBe(REVEAL_STYLES.length);
    expect(REVEAL_STYLES.length).toBe(11);
  });
});
