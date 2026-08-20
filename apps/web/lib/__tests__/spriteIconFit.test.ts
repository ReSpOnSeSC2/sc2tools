/**
 * The roster-icon fit correction.
 *
 * The Blender bake framed each model on its own, and did not normalise
 * the result: unit renders reach the frame edge (Marine 0.984, Thor 1)
 * while structures kept a wide transparent margin (Nexus 0.672, Dark
 * Shrine 0.578). Dropped into a fixed chip that margin is dead space,
 * and the Nexus reads as a mis-sized icon rather than a small building.
 *
 * These tests pin the correction's shape: full-bleed renders are left
 * alone, padded ones are scaled toward the frame, the correction is
 * capped, and it can never shrink an icon or return a scale for a name
 * the bake never measured.
 */

import { describe, expect, it } from "vitest";
import { spriteIconScale } from "@/lib/spriteSheets";
import { SPRITE_ICON_FILL } from "@/lib/spriteIconFit.generated";

/** Mirrors ICON_FIT_TARGET / ICON_FIT_MAX in lib/spriteSheets.ts. */
const TARGET = 0.92;
const MAX = 1.35;

describe("spriteIconScale", () => {
  it("leaves the full-bleed unit renders alone", () => {
    expect(spriteIconScale("Marine")).toBe(1);
    expect(spriteIconScale("Thor")).toBe(1);
    expect(spriteIconScale("Zealot")).toBe(1);
    expect(spriteIconScale("Probe")).toBe(1);
  });

  it("scales a padded structure up toward the frame", () => {
    // The reported bug: the Nexus drew about two thirds of its frame
    // beside a Marine's ~98 %.
    expect(SPRITE_ICON_FILL.Nexus).toBeLessThan(0.7);
    expect(spriteIconScale("Nexus")).toBeGreaterThan(1.3);
    // A structure that needs less help gets exactly as much as it needs.
    expect(spriteIconScale("Gateway")).toBeCloseTo(
      TARGET / SPRITE_ICON_FILL.Gateway,
      6,
    );
  });

  it("caps the correction so a Larva is not drawn like a Thor", () => {
    expect(SPRITE_ICON_FILL.Larva).toBeLessThan(0.5);
    expect(spriteIconScale("Larva")).toBe(MAX);
    expect(spriteIconScale("Changeling")).toBe(MAX);
  });

  it("never shrinks an icon and never exceeds the cap", () => {
    for (const name of Object.keys(SPRITE_ICON_FILL)) {
      const scale = spriteIconScale(name);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(1);
      expect(scale).toBeLessThanOrEqual(MAX);
    }
  });

  it("passes through names the bake never measured", () => {
    // Broodling and the Adept phase-shift have no 3D render at all, so
    // they keep their flat command-card icon and must not be scaled.
    expect(spriteIconScale("Broodling")).toBe(1);
    expect(spriteIconScale("NotASprite")).toBe(1);
    expect(spriteIconScale("")).toBe(1);
    expect(spriteIconScale(null)).toBe(1);
    expect(spriteIconScale(undefined)).toBe(1);
  });
});

describe("SPRITE_ICON_FILL", () => {
  it("covers the shipped sheet set with sane fractions", () => {
    const entries = Object.entries(SPRITE_ICON_FILL);
    expect(entries.length).toBeGreaterThan(100);
    for (const [name, fill] of entries) {
      expect(name).toMatch(/^[A-Za-z]+$/);
      expect(fill).toBeGreaterThan(0);
      expect(fill).toBeLessThanOrEqual(1);
    }
  });

  it("records that units were framed tighter than structures", () => {
    // Not a style preference — it is the asymmetry the correction
    // exists to undo. If a re-bake ever normalises the framing, this
    // fails and the correction can be deleted.
    expect(SPRITE_ICON_FILL.Marine).toBeGreaterThan(0.95);
    expect(SPRITE_ICON_FILL.Nexus).toBeLessThan(0.75);
    expect(SPRITE_ICON_FILL.Armory).toBeLessThan(0.75);
  });
});
