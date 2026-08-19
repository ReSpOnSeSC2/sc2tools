/**
 * Gas placement — the headless harness behind the "assimilators and
 * refineries and extractors aren't going on top of the gas geysers"
 * report.
 *
 * The replayer draws the two things at one map coordinate by two
 * different conventions:
 *
 *   geyser glyph  ``ctx.drawImage(glyph, X - size/2, Y - size/2, …)``
 *                 — CENTRED on the projected node.
 *   gas structure ``drawSprite(…, X, Y, cellPx)`` — ANCHORED, so the
 *                 sprite's ground origin lands on (X, Y) and the
 *                 bitmap's own centre sits ``(frameSize/2 − ay) ×
 *                 cellPx / frameSize`` ABOVE it.
 *
 * These tests reproduce both draws arithmetically (no canvas) and pin
 * the measured offset, so a future anchor re-bake or a change to
 * ``RESOURCE_GLYPH_WORLD`` cannot silently re-open the gap.
 */

import { describe, expect, it } from "vitest";
import {
  gasTappedAt,
  isGasStructure,
  projectX,
  projectY,
  sanitizeMapPlayback,
  worldProjection,
  type MapPlayback,
  type PlaybackBuilding,
} from "@/lib/mapReplay";
import { resolveSprite, spriteAnim, spriteDrawRect } from "@/lib/spriteSheets";

/* The replayer's own constants for the two draws under test. Kept
 * literal rather than imported: MapReplayer is a client component full
 * of canvas work, and these three numbers are the whole contract. */
const STAGE_PAD_PX = 4;
const RESOURCE_GLYPH_WORLD = 1.8;
const MIN_FURNITURE_SCREEN_PX = 9;

const BOUNDS = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
const GAS_AT = { x: 100, y: 100 };

/** A gas node and a gas structure recorded at the SAME coordinate —
 *  which is what the engine actually emits (verified against ten real
 *  payloads: Δx = Δy = 0.00 on all 138 gas structures in them). */
function gasPayload(structure: string): MapPlayback {
  const p = sanitizeMapPlayback({
    v: 5,
    mapName: "Gas Harness",
    gameLength: 600,
    bounds: BOUNDS,
    spawns: [{ owner: "me", x: 30, y: 30 }],
    battles: [],
    buildings: [
      {
        owner: "me",
        name: structure,
        t: 60,
        x: GAS_AT.x,
        y: GAS_AT.y,
        moves: [],
        died: null,
      },
    ],
    units: [
      { owner: "me", name: "Drone", born: 0, died: null, wp: [0, 30, 30, 600, 30, 30] },
    ],
    resources: [
      { kind: "gas", x: GAS_AT.x, y: GAS_AT.y, died: null },
      // A second, untapped geyser 20 units away — it must keep drawing.
      { kind: "gas", x: GAS_AT.x + 20, y: GAS_AT.y, died: null },
    ],
    stats: { me: [[0, 0, 12, 13]], opp: [[0, 0, 12, 12]] },
  });
  if (!p) throw new Error("gas fixture failed to sanitize");
  return p;
}

/** Everything the two draw paths compute, for one gas structure, on a
 *  ``canvasPx`` square stage. Mirrors ``MapReplayer.draw`` exactly. */
function measure(structure: string, canvasPx = 900, zoom = 1) {
  const playback = gasPayload(structure);
  const proj = worldProjection(playback.bounds, canvasPx, canvasPx, STAGE_PAD_PX);
  const k = proj.k;
  const X = projectX(playback.bounds, proj, GAS_AT.x);
  const Y = projectY(playback.bounds, proj, GAS_AT.y);

  // --- the geyser glyph: centred ---
  const glyphSize = Math.max(MIN_FURNITURE_SCREEN_PX / zoom, RESOURCE_GLYPH_WORLD * k);
  const glyph = { cx: X, cy: Y, size: glyphSize };

  // --- the structure sprite: anchored ---
  const sprite = resolveSprite(structure, "building");
  if (!sprite) throw new Error(`no sheet for ${structure}`);
  const handle = spriteAnim(sprite, "Stand");
  const cellPx = handle.anim.wupc * k;
  const rect = spriteDrawRect(handle, X, Y, cellPx);

  return {
    k,
    glyph,
    rect,
    cellPx,
    /** Glyph centre → sprite bitmap centre, in canvas px. Negative Y is
     *  up-screen. */
    offsetPx: { x: rect.cx - glyph.cx, y: rect.cy - glyph.cy },
    /** …and the same offset in world units. */
    offsetWorld: { x: (rect.cx - glyph.cx) / k, y: (rect.cy - glyph.cy) / k },
    playback,
  };
}

describe("gas structures vs their geysers", () => {
  it("records the structure and the geyser at the SAME coordinate", () => {
    // Rules out "they legitimately differ by a fixed offset": there is
    // nothing to correct for in the payload.
    for (const name of ["Refinery", "Extractor", "Assimilator"]) {
      const p = gasPayload(name);
      const b = p.buildings[0];
      const node = p.resources[0];
      expect(b.x - node.x).toBe(0);
      expect(b.y - node.y).toBe(0);
    }
  });

  it("measures the anchored-vs-centred offset the report is about", () => {
    // The numbers below are the DIAGNOSIS, not a target. k = 4.46 px per
    // world unit (200x200 map on a 900 px stage).
    const measured = {
      Refinery: measure("Refinery"),
      Extractor: measure("Extractor"),
      Assimilator: measure("Assimilator"),
    };
    expect(measured.Refinery.k).toBeCloseTo(4.46, 2);

    // Horizontally the two agree: every gas model is framed on its own
    // centre line (the Extractor leans a fraction, from its geometry).
    expect(Math.abs(measured.Refinery.offsetPx.x)).toBeLessThan(0.05);
    expect(Math.abs(measured.Assimilator.offsetPx.x)).toBeLessThan(0.1);
    expect(Math.abs(measured.Extractor.offsetPx.x)).toBeLessThan(0.6);

    // Vertically the sprite's bitmap centre lands ABOVE the glyph
    // centre — that is the whole defect, and it is a property of the
    // ground-origin anchor, not of the payload.
    expect(measured.Refinery.offsetPx.y).toBeCloseTo(-2.33, 1);
    expect(measured.Extractor.offsetPx.y).toBeCloseTo(-3.27, 1);
    expect(measured.Assimilator.offsetPx.y).toBeCloseTo(-2.49, 1);

    expect(measured.Refinery.offsetWorld.y).toBeCloseTo(-0.52, 2);
    expect(measured.Extractor.offsetWorld.y).toBeCloseTo(-0.73, 2);
    expect(measured.Assimilator.offsetWorld.y).toBeCloseTo(-0.56, 2);
  });

  it("is a scale-invariant fraction of the sprite cell, not a px constant", () => {
    // Same defect at every stage size — which is why it cannot be fixed
    // by nudging the draw by a pixel count.
    for (const px of [420, 900, 1400]) {
      const m = measure("Refinery", px);
      expect(m.offsetPx.y / m.cellPx).toBeCloseTo(-0.0836, 4);
    }
  });

  it("leaves the glyph proportionally BIGGEST where the stage is smallest", () => {
    // The compact drilldown is where the fringe actually shows: the
    // 9 px furniture floor bites while the structure keeps shrinking.
    const compact = measure("Assimilator", 420);
    const full = measure("Assimilator", 900);
    expect(compact.glyph.size / compact.cellPx).toBeGreaterThan(0.9);
    expect(full.glyph.size / full.cellPx).toBeLessThan(0.5);
  });
});

describe("gasTappedAt", () => {
  const at = (over: Partial<PlaybackBuilding> = {}): PlaybackBuilding => ({
    owner: "me",
    name: "Refinery",
    t: 60,
    x: GAS_AT.x,
    y: GAS_AT.y,
    moves: [],
    died: null,
    ...over,
  });

  it("recognises every gas structure, rich variants included", () => {
    for (const n of [
      "Refinery",
      "RefineryRich",
      "Extractor",
      "ExtractorRich",
      "Assimilator",
      "AssimilatorRich",
    ]) {
      expect(isGasStructure(n)).toBe(true);
    }
    expect(isGasStructure("Pylon")).toBe(false);
    expect(isGasStructure("CommandCenter")).toBe(false);
  });

  it("is false before the structure is placed and after it dies", () => {
    const b = [at({ t: 60, died: 300 })];
    expect(gasTappedAt(b, GAS_AT, 59)).toBe(false);
    expect(gasTappedAt(b, GAS_AT, 60)).toBe(true);
    expect(gasTappedAt(b, GAS_AT, 299)).toBe(true);
    expect(gasTappedAt(b, GAS_AT, 300)).toBe(false);
  });

  it("does not count a NON-gas structure parked next to the geyser", () => {
    // The old inline test in MapReplayer matched any building within
    // 1.5 units, so a Pylon beside a geyser handed the hall three
    // phantom gas mining slots.
    expect(gasTappedAt([at({ name: "Pylon" })], GAS_AT, 120)).toBe(false);
  });

  it("respects the owner filter but ignores it when omitted", () => {
    const opp = [at({ owner: "opp" })];
    expect(gasTappedAt(opp, GAS_AT, 120, "me")).toBe(false);
    expect(gasTappedAt(opp, GAS_AT, 120, "opp")).toBe(true);
    expect(gasTappedAt(opp, GAS_AT, 120)).toBe(true);
  });

  it("only claims the geyser it is standing on", () => {
    const b = [at()];
    expect(gasTappedAt(b, { x: GAS_AT.x + 1.4, y: GAS_AT.y }, 120)).toBe(true);
    expect(gasTappedAt(b, { x: GAS_AT.x + 20, y: GAS_AT.y }, 120)).toBe(false);
  });

  it("the fix: a tapped geyser is skipped, an untapped one still draws", () => {
    // Exactly the guard the resource pass runs.
    const p = gasPayload("Assimilator");
    const drawn = (t: number) =>
      p.resources.filter(
        (r) => !(r.kind === "gas" && gasTappedAt(p.buildings, r, t)),
      );
    // Before the Assimilator goes up, both geysers are map furniture.
    expect(drawn(0)).toHaveLength(2);
    // Afterwards only the untapped one is — the structure IS the other.
    const after = drawn(120);
    expect(after).toHaveLength(1);
    expect(after[0].x).toBe(GAS_AT.x + 20);
  });
});
