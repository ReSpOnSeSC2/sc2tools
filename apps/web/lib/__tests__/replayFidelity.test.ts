import { describe, expect, it } from "vitest";
import { sanitizeMapPlayback, unitAliveAt, unitVisibleAt, unitNameAt, unitPositionAt, buildingPositionAt } from "../mapReplay";
import { motionSample, sampleTrack } from "../replayMotion";
import { creepFrameAt } from "../replayObservedCreep";
import { compositionAt, deriveReplayHud } from "../replayHud";
import { computeLosses } from "../mapReplayLosses";

const raw = {
  v: 6, mapName: "Fidelity fixture", gameLength: 20,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [{ id: "18446744073709551615", owner: "me", name: "Roach", born: 0, died: 20,
    forms: [{ t: 10, name: "Ravager" }], hidden: [4, 6], wp: [0, 10, 10, 1, 14, 10, 20, 14, 10] }],
  buildings: [], stats: { me: [], opp: [] },
  fidelity: { positions: "engine", paths: "observed", creep: "observed", complete: true },
};

describe("recorded replay fidelity", () => {
  it("keeps stable uint64 IDs, forms, cargo intervals and cast references", () => {
    const p = sanitizeMapPlayback({ ...raw, casts: [{ o: 0, a: "CorrosiveBile", t: 12,
      casterUnitId: raw.units[0].id, targetUnitId: 123, source: "command" }] })!;
    expect(p.units[0].id).toBe(raw.units[0].id);
    expect(unitNameAt(p.units[0], 9)).toBe("Roach");
    expect(unitNameAt(p.units[0], 10)).toBe("Ravager");
    expect(unitAliveAt(p.units[0], 5)).toBe(true);
    expect(unitVisibleAt(p.units[0], 5)).toBe(false);
    expect(unitVisibleAt(p.units[0], 6)).toBe(true);
    expect(p.casts![0].casterUnitId).toBe(raw.units[0].id);
  });

  it("does not move along a teleport or overshoot a recorded corner", () => {
    const teleport = [0, 10, 10, 0.25, 70, 60];
    expect(unitPositionAt(teleport, 0.2, 5)).toEqual({ x: 10, y: 10 });
    expect(unitPositionAt(teleport, 0.25, 5)).toEqual({ x: 70, y: 60 });
    const corner = [0, 10, 10, 1, 14, 10, 2, 14, 14];
    expect(sampleTrack(corner, 0.5, 5, motionSample())).toEqual({ x: 12, y: 10, vx: 4, vy: 0 });
    expect(sampleTrack(corner, 1.5, 5, motionSample())).toEqual({ x: 14, y: 12, vx: 0, vy: 4 });
  });

  it("sanitizes out-of-order and duplicate times without corrupting binary search", () => {
    const p = sanitizeMapPlayback({ ...raw, units: [{ ...raw.units[0], wp: [2, 2, 2, 0, 0, 0, 1, 1, 1, 1, 3, 3] }] })!;
    expect(p.units[0].wp).toEqual([0, 0, 0, 1, 3, 3, 2, 2, 2]);
    expect(sanitizeMapPlayback({ ...raw, bounds: { ...raw.bounds, maxX: Infinity } })).toBeNull();
  });

  it("retains all dense observations beyond legacy 400-point truncation", () => {
    const wp = Array.from({ length: 2000 }, (_, i) => [i / 10, i % 30, 10]).flat();
    const p = sanitizeMapPlayback({ ...raw, units: [{ ...raw.units[0], wp }] })!;
    expect(p.units[0].wp).toEqual(wp);
    expect(p.fidelity!.complete).toBe(true);
  });

  it("counts a morph once and prices its death using the form at death", () => {
    const p = sanitizeMapPlayback(raw)!;
    const model = deriveReplayHud(p);
    expect(compositionAt(model, "me", 9).army).toEqual([{ name: "Roach", count: 1 }]);
    expect(compositionAt(model, "me", 11).army).toEqual([{ name: "Ravager", count: 1 }]);
    expect(computeLosses(p.units, "me", 20).byUnit[0].name).toBe("Ravager");
  });

  it("keeps empty observed creep masks and seeks without showing future spread", () => {
    const p = sanitizeMapPlayback({ ...raw, creep: { width: 10, height: 10, encoding: "rle",
      frames: [{ t: 0, runs: [] }, { t: 5, runs: [11, 2, 21, 2] }, { t: 10, runs: [] }] } })!;
    expect(creepFrameAt(p.creep!, -1)).toBe(-1);
    expect(creepFrameAt(p.creep!, 7)).toBe(1);
    expect(creepFrameAt(p.creep!, 1)).toBe(0);
    expect(creepFrameAt(p.creep!, 10)).toBe(2);
  });

  it("rejects malformed creep runs and effect lifetimes", () => {
    const p = sanitizeMapPlayback({ ...raw, creep: { width: 10, height: 10, encoding: "rle", frames: [{ t: 0, runs: [99, 5] }] },
      effects: [{ id: 1, name: "PsiStorm", owner: "me", t: 5, end: 2, x: 4, y: 4, radius: 2 }] })!;
    expect(p.creep).toBeUndefined();
    expect(p.effects).toEqual([]);
    expect(p.fidelity!.complete).toBe(false);
  });

  it("preserves a flying building's entire observed route", () => {
    const moves = Array.from({ length: 200 }, (_, i) => [i + 1, 10 + (i + 1) / 10, 10]).flat();
    const p = sanitizeMapPlayback({ ...raw, buildings: [{ owner: "me", name: "CommandCenter", t: 0, x: 10, y: 10, died: null, moves }] })!;
    expect(p.buildings[0].moves).toEqual(moves);
    expect(buildingPositionAt(p.buildings[0], 199.5).x).toBeCloseTo(29.95);
  });

  it("never claims complete effect coverage after a defensive limit drops events", () => {
    const effect = { id: 11, name: "RavagerCorrosiveBileCP", owner: "neutral", t: 1, end: 2, x: 10, y: 10, radius: 0.5 };
    const p = sanitizeMapPlayback({ ...raw, fidelity: { ...raw.fidelity, effects: "observed" }, effects: Array.from({ length: 20001 }, () => effect) })!;
    expect(p.effects).toHaveLength(20000);
    expect(p.effects![0].owner).toBe("neutral");
    expect(p.fidelity!.complete).toBe(false);
  });
});
