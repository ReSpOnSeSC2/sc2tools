import { describe, expect, it, vi } from "vitest";
import { attackAt, attackFacing, attackFrame, drawWeaponEffects, unitFacingAt } from "../replayCombat";
import { sanitizeMapPlayback } from "../mapReplay";

const raw = {
  v: 6, gameLength: 20, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  units: [{ id: 1, owner: "me", name: "Marine", born: 0, died: null, wp: [0, 10, 10], attacks: [1, 2], aim: [1, 20, 30] }],
  fidelity: { positions: "engine", paths: "observed", creep: "observed", attacks: "observed", complete: true },
};

describe("recorded weapon animation", () => {
  it("uses exact shot windows in either seek direction without reusing a prior target", () => {
    const u = raw.units[0];
    expect(attackAt(u, 0.99)).toBeNull();
    expect(attackAt(u, 1.2)).toMatchObject({ t: 1, x: 20, y: 30 });
    expect(attackAt(u, 1.6)).toBeNull();
    expect(attackAt(u, 2.1)).toMatchObject({ t: 2, x: null, y: null });
    expect(attackAt(u, 1.2)).toMatchObject({ t: 1, x: 20, y: 30 });
    expect(attackAt({}, 1.2)).toBeNull();
  });

  it("plays each attack clip once and restarts at the next observed shot", () => {
    expect(attackFrame(0, 8, 8)).toBe(0);
    expect(attackFrame(0.5, 8, 8)).toBe(4);
    expect(attackFrame(10, 8, 8)).toBe(7);
    expect(attackFrame(attackAt(raw.units[0], 2)!.age, 8, 8)).toBe(0);
  });

  it("faces nearby melee targets without treating target distance as noisy speed", () => {
    const hit = { t: 1, age: 0, x: 10.1, y: 10 };
    expect(attackFacing(hit, 10, 10, 0)).toBe(2);
    expect(attackFacing({ ...hit, x: 10, y: 10.1 }, 10, 10, 0)).toBe(4);
    expect(attackFacing({ ...hit, x: 10, y: 10 }, 10, 10, 3)).toBe(3);
  });

  it("reconstructs stationary facing independently of seek history", () => {
    const u = { wp: [0, 10, 10, 1, 10, 10, 20, 10, 10], attacks: [10], aim: [10, 20, 10] };
    const pos = { x: 10, y: 10, vx: 0, vy: 0 };
    expect(unitFacingAt(u, 12, pos, null)).toBe(2);
    expect(unitFacingAt(u, 5, pos, null)).toBe(0);
    expect(unitFacingAt(u, 12, pos, null)).toBe(2);
    const moved = { ...u, wp: [0, 10, 10, 11, 10, 10, 12, 10, 15, 20, 10, 15] };
    expect(unitFacingAt(moved, 13, { ...pos, y: 15 }, null)).toBe(4);
  });

  it("sanitizes lifecycle bounds and retains only targets with matching shots", () => {
    const p = sanitizeMapPlayback({ ...raw, units: [{ ...raw.units[0], born: 1, died: 3,
      attacks: [3, 2, 2, 1, 0, 4, null], aim: [1, 20, 30, 1.5, 80, 80, 3, 30, 40] }] })!;
    expect(p.units[0].attacks).toEqual([1, 2]);
    expect(p.units[0].aim).toEqual([1, 20, 30]);
    expect(p.fidelity?.attacks).toBe("observed");
    expect(p.fidelity?.complete).toBe(false);
    const fallback = sanitizeMapPlayback({ ...raw, fidelity: { ...raw.fidelity, positions: "tracker", attacks: "unavailable" } })!;
    expect(fallback.units[0].attacks).toBeUndefined();
  });

  it("draws target cues only for recorded shots and hides cargo or dead attackers", () => {
    const p = sanitizeMapPlayback(raw)!;
    const line = vi.fn(), flash = vi.fn();
    const ctx = new Proxy({ lineTo: line, fill: flash }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : vi.fn(); },
    }) as unknown as CanvasRenderingContext2D;
    const draw = (t: number) => drawWeaponEffects(ctx, p, t, { k: 2, ox: 0, oy: 0 }, { z: 1 });
    expect(draw(0.5)).toBe(0);
    expect(draw(1.1)).toBe(1);
    expect(line).toHaveBeenCalledWith(40, 140);
    line.mockClear();
    expect(draw(2.1)).toBe(1);
    expect(line).not.toHaveBeenCalled();
    p.units[0].hidden = [2, 3];
    expect(draw(2.1)).toBe(0);
    p.units[0].hidden = [];
    p.units[0].died = 2;
    expect(draw(2.1)).toBe(0);
  });
});
