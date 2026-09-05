import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapPlayback, PlaybackUnit, ReplayCast, ReplayObservedEffect } from "@/lib/mapReplay";
import { activeCastIndices, activeSpellEffects, drawSpellEffects, setSpellEffectsEnabled } from "@/lib/spellEffects";

function unit(id: number | string, x: number, name = "Marine", owner: "me" | "opp" = "me"): PlaybackUnit {
  return { id, name, owner, born: 0, died: null, wp: [0, x, 10, 1, x + 2, 10, 2, x + 4, 10] };
}

function playback(casts: ReplayCast[] = [], units: PlaybackUnit[] = []): MapPlayback {
  return { v: 6, mapName: "Test", gameLength: 100, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    spawns: [], battles: [], buildings: [], units, resources: [], casts, stats: { me: [], opp: [] } };
}

function effectsAt(p: MapPlayback, t: number) {
  const result = activeSpellEffects(p, t);
  return result.list.slice(0, result.count).map(e => ({ ...e }));
}

function storm(overrides: Partial<ReplayObservedEffect> = {}): ReplayObservedEffect {
  return { id: 1, name: "PsiStormPersistent", owner: "me", t: 10.25, end: 10.75, x: 50, y: 60, radius: 1.5, ...overrides };
}

afterEach(() => { setSpellEffectsEnabled(true); vi.restoreAllMocks(); });

describe("replay spell identity and observed effects", () => {
  it("never assigns a targetless legacy spell to an arbitrary matching unit", () => {
    const p = playback([{ a: "Stim", o: 0, t: 0.5 }], [unit(1, 10), unit(2, 50)]);
    expect(effectsAt(p, 0.75)).toEqual([]);
  });

  it("keeps a known destination without inventing the nearest caster", () => {
    const p = playback([{ a: "Yamato", o: 0, t: 0.5, x: 40, y: 10 }], [unit(1, 38, "Battlecruiser")]);
    const e = effectsAt(p, 0.75)[0];
    expect(e.wx).toBe(40);
    expect(Number.isNaN(e.cx)).toBe(true);
  });

  it("resolves exact caster and enemy target separately, including uint64 string tags", () => {
    const p = playback([{ a: "Yamato", o: 0, t: 0.5, x: 40, y: 10,
      casterUnitId: "18446744073709551001", targetUnitId: 22 }],
    [unit("18446744073709551001", 10, "Battlecruiser"), unit(22, 40, "Carrier", "opp"), unit(23, 39, "Battlecruiser")]);
    const e = effectsAt(p, 0.75)[0];
    expect(e.cx).toBeCloseTo(11.5);
    expect(e.wx).toBeCloseTo(41.5);
  });

  it("shows group self effects only on the recorded selected identities", () => {
    const p = playback([{ a: "Stim", o: 0, t: 0.5, casterUnitIds: [1, 3] }], [unit(1, 10), unit(2, 30), unit(3, 50)]);
    expect(effectsAt(p, 0.75).map(e => e.wx)).toEqual([11.5, 51.5]);
    const indices: number[] = [];
    expect(activeCastIndices(p, 0.75, indices)).toBe(1);
    expect(indices).toEqual([0]);
  });

  it("attaches Chrono to its exact target building and stops at target death", () => {
    const p = playback([{ a: "ChronoBoost", o: 0, t: 0.5, targetUnitId: 2, casterUnitId: 1 }]);
    p.buildings = [
      { id: 1, owner: "me", name: "Nexus", t: 0, x: 10, y: 10, moves: [], died: null },
      { id: 2, owner: "me", name: "Forge", t: 0, x: 40, y: 40, moves: [], died: 1 },
    ];
    expect(effectsAt(p, 0.9)[0].wx).toBe(40);
    expect(effectsAt(p, 1.1)).toEqual([]);
  });

  it("does not move a targeted aura to its caster when the target identity is unavailable", () => {
    const p = playback([{ a: "ChronoBoost", o: 0, t: 0.5, x: 40, y: 40, casterUnitId: 1 }]);
    p.buildings = [{ id: 1, owner: "me", name: "Nexus", t: 0, x: 10, y: 10, moves: [], died: null }];
    expect(effectsAt(p, 0.9)[0].wx).toBe(40);
    const missingTarget = { ...p, casts: [{ a: "ChronoBoost", o: 0 as const, t: 0.5, casterUnitId: 1 }] };
    expect(effectsAt(missingTarget, 0.9)).toEqual([]);
  });

  it("renders engine effects without casts, at their observed radius and exact live interval", () => {
    const p = playback();
    delete p.casts;
    p.effects = [storm()];
    expect(effectsAt(p, 10.24)).toEqual([]);
    const e = effectsAt(p, 10.25)[0];
    expect(e).toMatchObject({ wx: 50, wy: 60, source: "observation" });
    expect(e.spec).toMatchObject({ r: 1.5, lead: 0, life: 0.5 });
    expect(effectsAt(p, 10.75)).toEqual([]);
    expect(effectsAt(p, 10.5)[0].wx).toBe(50);
  });

  it("renders unowned observed effects with a neutral tint", () => {
    const p = playback();
    p.effects = [storm({ id: 99, name: "UnknownEffect", owner: "neutral" })];
    expect(effectsAt(p, 10.5)[0]).toMatchObject({ owner: 2, color: "#bbc6d6" });
  });

  it("suppresses duplicate commands and failed raw-effect orders with complete engine coverage", () => {
    const p = playback([{ a: "PsiStorm", o: 0, t: 10, x: 50, y: 60 }]);
    p.effects = [storm()];
    expect(effectsAt(p, 10.5)).toHaveLength(1);
    expect(effectsAt(p, 10.5)[0].source).toBe("observation");
    const failed = playback([{ a: "PsiStorm", o: 0, t: 10, x: 50, y: 60 }]);
    failed.effects = [];
    failed.fidelity = { positions: "engine", paths: "observed", creep: "observed", effects: "observed", complete: true };
    expect(effectsAt(failed, 10.5)).toEqual([]);
  });

  it("preserves recorded spell orders when engine observers cannot expose raw effects", () => {
    const p = playback([{ a: "PsiStorm", o: 0, t: 10, x: 50, y: 60 }]);
    p.effects = [];
    p.fidelity = { positions: "engine", paths: "observed", creep: "observed", effects: "unavailable", complete: true };
    expect(effectsAt(p, 10.5)).toHaveLength(1);
  });

  it("does not show a self effect on a caster hidden inside a transport", () => {
    const hidden = { ...unit(1, 10), hidden: [0.7, 1.2] };
    const p = playback([{ a: "Stim", o: 0, t: 0.5, casterUnitId: 1 }], [hidden]);
    expect(effectsAt(p, 0.6)).toHaveLength(1);
    expect(effectsAt(p, 0.8)).toEqual([]);
  });

  it("draws an observed-only effect on the canvas and obeys the user toggle", () => {
    const p = playback();
    p.effects = [storm()];
    const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop: vi.fn() }) }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : vi.fn(); },
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    const draw = () => drawSpellEffects(ctx, p, 10.5, { k: 2, ox: 0, oy: 0 }, { z: 1, ox: 0, oy: 0 }, 400, 400, "overlay");
    expect(draw()).toBe(1);
    setSpellEffectsEnabled(false);
    expect(draw()).toBe(0);
  });

  it("draws a Bile target above buildings at its exact observed radius without a pixel floor", () => {
    const p = playback();
    p.effects = [storm({ id: 11, name: "RavagerCorrosiveBileCP", radius: 0.5 })];
    const arc = vi.fn();
    const ctx = new Proxy({ arc, createRadialGradient: () => ({ addColorStop: vi.fn() }) }, {
      get(target, key) { return key in target ? target[key as keyof typeof target] : vi.fn(); },
    }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    const draw = (layer: "ground" | "overlay") => drawSpellEffects(ctx, p, 10.5,
      { k: 2, ox: 0, oy: 0 }, { z: 1, ox: 0, oy: 0 }, 400, 400, layer);
    expect(draw("ground")).toBe(0);
    expect(draw("overlay")).toBe(1);
    expect(arc.mock.calls.some(args => args[0] === 100 && args[2] === 1)).toBe(true);
    expect(arc.mock.calls.filter(args => args[0] === 100).every(args => args[2] <= 1)).toBe(true);
  });
});
