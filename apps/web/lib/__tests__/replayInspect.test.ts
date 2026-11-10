import { describe, expect, it } from "vitest";
import { sanitizeMapPlayback, type MapPlayback } from "@/lib/mapReplay";
import {
  createHitBuffer, entityPositionAt, followView, hitTest, inspectEntity, MIN_HIT_RADIUS_PX, nextNearest, pushHit, resolveEntity,
} from "@/lib/replayInspect";

function playback(overrides: Record<string, unknown> = {}): MapPlayback {
  const value = sanitizeMapPlayback({
    v: 6, mapName: "Inspect Test", gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    spawns: [], battles: [], resources: [], stats: { me: [[0, 0, 12, 12], [600, 0, 12, 12]], opp: [[0, 0, 12, 12], [600, 0, 12, 12]] },
    buildings: [{ owner: "opp", name: "Bunker", t: 40, x: 120, y: 80, moves: [], died: 300, id: 9 }],
    units: [
      { owner: "me", name: "Marine", born: 10, died: 250, wp: [10, 50, 50, 250, 50, 50], id: 7 },
      { owner: "me", name: "Medivac", born: 20, died: null, wp: [20, 100, 100, 600, 100, 100] },
    ],
    ...overrides,
  });
  if (!value) throw new Error("fixture rejected");
  return value;
}

describe("hit testing", () => {
  it("picks the nearest entity whose radius holds the tap, with a touch-sized floor", () => {
    const hits = createHitBuffer();
    pushHit(hits, 100, 100, 20, "building", 0);
    pushHit(hits, 108, 100, 4, "unit", 3);
    pushHit(hits, 300, 300, 10, "unit", 1);
    expect(hits.r[1]).toBe(MIN_HIT_RADIUS_PX);
    expect(hitTest(hits, 109, 101)).toEqual({ kind: "unit", index: 3 });
    expect(hitTest(hits, 92, 100)).toEqual({ kind: "building", index: 0 });
    expect(hitTest(hits, 200, 200)).toBeNull();
  });

  it("cycles through overlapping entities on repeated taps at the same spot", () => {
    const hits = createHitBuffer();
    pushHit(hits, 100, 100, 20, "building", 0);
    pushHit(hits, 104, 100, 12, "unit", 3);
    pushHit(hits, 101, 101, 12, "unit", 5);
    // Distances from (101, 100): unit 5 and the building 1 px (units win
    // ties), unit 3 3 px.
    const first = hitTest(hits, 101, 100);
    expect(first).toEqual({ kind: "unit", index: 5 });
    const second = hitTest(hits, 101, 100, { ref: first, x: 101, y: 100 });
    const third = hitTest(hits, 102, 100, { ref: second, x: 101, y: 100 });
    const fourth = hitTest(hits, 101, 100, { ref: third, x: 101, y: 100 });
    expect([second, third, fourth]).toEqual([{ kind: "building", index: 0 }, { kind: "unit", index: 5 }, { kind: "building", index: 0 }]);
    // A tap somewhere else starts over from the nearest.
    expect(hitTest(hits, 104, 100, { ref: third, x: 90, y: 90 })).toEqual({ kind: "unit", index: 3 });
  });

  it("walks outward from the view centre for keyboard inspection", () => {
    const hits = createHitBuffer();
    pushHit(hits, 10, 10, 12, "unit", 0);
    pushHit(hits, 55, 50, 12, "unit", 1);
    pushHit(hits, 80, 50, 12, "building", 2);
    expect(nextNearest(hits, 50, 50, null)).toEqual({ kind: "unit", index: 1 });
    expect(nextNearest(hits, 50, 50, { kind: "unit", index: 1 })).toEqual({ kind: "building", index: 2 });
    expect(nextNearest(hits, 50, 50, { kind: "unit", index: 0 })).toEqual({ kind: "unit", index: 1 });
    expect(nextNearest(createHitBuffer(), 50, 50, null)).toBeNull();
  });
});

describe("inspecting and following", () => {
  it("reports name, owner, lifetime and attacks only when the payload observed them", () => {
    const p = playback();
    const marine = inspectEntity(p, { kind: "unit", index: 0 }, 100)!;
    expect(marine).toMatchObject({ name: "Marine", owner: "me", born: 10, died: 250, lifetime: 240, attacks: null, alive: true, visible: true });
    const medivac = inspectEntity(p, { kind: "unit", index: 1 }, 100)!;
    expect(medivac.died).toBeNull();
    expect(medivac.lifetime).toBe(580);
    const bunker = inspectEntity(p, { kind: "building", index: 0 }, 350)!;
    expect(bunker).toMatchObject({ name: "Bunker", owner: "opp", born: 40, lifetime: 260, alive: false });
    const observed = playback({
      v: 7,
      fidelity: { positions: "engine", paths: "observed", creep: "observed", attacks: "observed", effects: "observed", complete: true, positionError: 0.1, sampleSeconds: 0.1 },
      units: [{ owner: "me", name: "Marine", born: 10, died: 250, wp: [10, 50, 50, 250, 50, 50], attacks: [20, 21, 22] }],
    });
    expect(inspectEntity(observed, { kind: "unit", index: 0 }, 100)!.attacks).toBe(3);
    expect(inspectEntity(p, { kind: "unit", index: 9 }, 100)).toBeNull();
  });

  it("centres a followed unit, clamps at the map edge and lets go when it dies", () => {
    const p = playback();
    const ref = { kind: "unit" as const, index: 1 };
    const view = followView(p, ref, 100, { z: 1, ox: 0, oy: 0 }, 208, 208, 4)!;
    expect(view.z).toBe(2.5);
    // World (100, 100) is the map centre: centred exactly.
    expect(view.ox).toBeCloseTo(104 - 104 * 2.5);
    expect(view.oy).toBeCloseTo(104 - 104 * 2.5);
    const edge = followView(p, { kind: "unit", index: 0 }, 100, { z: 4, ox: 0, oy: 0 }, 208, 208, 4)!;
    expect(edge.ox).toBeLessThanOrEqual(0);
    expect(edge.ox).toBeGreaterThanOrEqual(208 - 208 * 4);
    expect(followView(p, { kind: "unit", index: 0 }, 260, view, 208, 208, 4)).toBeNull();
    expect(entityPositionAt(p, ref, 100)).toEqual({ x: 100, y: 100 });
  });

  it("carries a selection into the next segment by stable id, and drops it without one", () => {
    const first = playback();
    const next = playback({ units: [
      { owner: "me", name: "Medivac", born: 20, died: null, wp: [20, 100, 100, 600, 100, 100] },
      { owner: "me", name: "Marine", born: 10, died: 250, wp: [10, 50, 50, 250, 50, 50], id: 7 },
    ] });
    expect(resolveEntity(first, next, { kind: "unit", index: 0 })).toEqual({ kind: "unit", index: 1 });
    expect(resolveEntity(first, next, { kind: "unit", index: 1 })).toBeNull();
    expect(resolveEntity(first, first, { kind: "unit", index: 1 })).toEqual({ kind: "unit", index: 1 });
  });
});
