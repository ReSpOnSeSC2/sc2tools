import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeMapPlayback, type MapPlayback } from "@/lib/mapReplay";
import { createHitBuffer } from "@/lib/replayInspect";

/**
 * Fog filtering at the renderer: which entities ``renderFrame`` actually
 * paints in each vision mode, and at what opacity. The sprite module is
 * replaced by a recorder so every draw is observable without a canvas.
 */
const draws = vi.hoisted(() => [] as { name: string; color: string; frame: number; alpha: number }[]);
const resolved = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/spriteSheets", () => {
  const anim = { frames: 8, fps: 8, cols: 8, rows: 8, suffix: null, wupc: 2, ax: 128, ay: 128 };
  const sprites = new Map<string, unknown>();
  const sprite = (name: string) => {
    if (!sprites.has(name)) sprites.set(name, { name, meta: { kind: "unit", race: "Terran", frameSize: 256, facings: 8, anims: { Stand: anim, Walk: anim } }, handles: {} });
    return sprites.get(name);
  };
  return {
    beginSpriteFrame: () => {}, endSpriteFrame: () => {}, hasWalk: () => true, spriteAssetsVersion: () => 0,
    resolveSprite: (name: string) => {
      resolved.push(name);
      return sprite(name);
    },
    spriteAnim: (s: { name: string }, name: string) => ({ name, anim, sprite: s }),
    drawSprite: (ctx: CanvasRenderingContext2D, handle: { sprite: { name: string } }, color: string, _facing: number, frame: number) => {
      draws.push({ name: handle.sprite.name, color, frame, alpha: ctx.globalAlpha });
      return true;
    },
  };
});

const { renderFrame } = await import("../mapCanvasRenderer");

function ctx(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

function playback(): MapPlayback {
  const value = sanitizeMapPlayback({
    v: 5, mapName: "Fog Test", gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    spawns: [], battles: [], resources: [],
    stats: { me: [[0, 0, 12, 12], [600, 0, 12, 12]], opp: [[0, 0, 12, 12], [600, 0, 12, 12]] },
    buildings: [
      { owner: "me", name: "CommandCenter", t: 0, x: 20, y: 20, moves: [], died: null },
      // Scouted at 100 s by the Reaper, then left alone: a ghost later.
      { owner: "opp", name: "Hatchery", t: 0, x: 150, y: 150, moves: [], died: null },
      // Never seen by me.
      { owner: "opp", name: "SpawningPool", t: 0, x: 180, y: 20, moves: [], died: null },
    ],
    units: [
      { owner: "me", name: "Reaper", born: 50, died: null, wp: [50, 20, 30, 100, 150, 145, 120, 60, 60, 600, 60, 60] },
      // Next to my Reaper at 300 s: seen.
      { owner: "opp", name: "Zergling", born: 50, died: null, wp: [50, 64, 60, 600, 64, 60] },
      // Far from anything of mine: hidden.
      { owner: "opp", name: "Roach", born: 50, died: null, wp: [50, 120, 180, 600, 120, 180] },
    ],
  });
  if (!value) throw new Error("fixture rejected");
  return value;
}

const canvas = { width: 400, height: 400 } as HTMLCanvasElement;
const view = { z: 1, ox: 0, oy: 0 };

function frame(vision: "both" | "me" | "opp" | "off", t = 300) {
  draws.length = 0;
  const hits = createHitBuffer();
  renderFrame(ctx(), canvas, playback(), t, null, view, undefined, undefined, { vision, dpr: 1, hits });
  return { names: draws.map((d) => d.name).sort(), draws: [...draws], hits };
}

describe("vision modes at the renderer", () => {
  beforeEach(() => { draws.length = 0; resolved.length = 0; });

  it("paints the icon stage without resolving or drawing a sprite", () => {
    const hits = createHitBuffer();
    renderFrame(ctx(), canvas, playback(), 300, null, view, undefined, { entities: "icons" }, { vision: "off", dpr: 1, hits });
    expect(hits.count).toBe(6);
    expect(resolved).toEqual([]);
    expect(draws).toEqual([]);
  });

  it("draws everything in both and off modes", () => {
    const all = ["CommandCenter", "Hatchery", "Reaper", "Roach", "SpawningPool", "Zergling"];
    expect(frame("both").names).toEqual(all);
    expect(frame("off").names).toEqual(all);
  });

  it("hides enemy units outside my sight and keeps scouted structures as dimmed ghosts", () => {
    const mine = frame("me");
    expect(mine.names).toEqual(["CommandCenter", "Hatchery", "Reaper", "Zergling"]);
    const hatchery = mine.draws.find((d) => d.name === "Hatchery")!;
    expect(hatchery.alpha).toBeCloseTo(0.4);
    expect(hatchery.frame).toBe(0);
    expect(mine.draws.find((d) => d.name === "Zergling")!.alpha).toBe(1);
    // Ghosts are remembered, not live: they cannot be clicked.
    expect(mine.hits.count).toBe(3);
  });

  it("keeps the known structure form and never draws a hidden structure at a tracked new location", () => {
    const known = playback();
    known.buildings[1].forms = [{ t: 150, name: "Lair" }];
    renderFrame(ctx(), canvas, known, 300, null, view, undefined, undefined, { vision: "me", dpr: 1 });
    expect(draws.find(draw => draw.name === "Hatchery")?.alpha).toBeCloseTo(0.4);
    expect(draws.some(draw => draw.name === "Lair")).toBe(false);

    draws.length = 0;
    const moved = playback();
    moved.buildings[1].moves = [150, 180, 170];
    renderFrame(ctx(), canvas, moved, 300, null, view, undefined, undefined, { vision: "me", dpr: 1 });
    expect(draws.some(draw => draw.name === "Hatchery")).toBe(false);
  });

  it("shows no ghost before the structure was first seen", () => {
    expect(frame("me", 90).names).toEqual(["CommandCenter", "Reaper"]);
  });

  it("flips to the opponent's view", () => {
    // Zerg sight: the Zergling sees the Reaper beside it; the CC is far away.
    expect(frame("opp").names).toEqual(["Hatchery", "Reaper", "Roach", "SpawningPool", "Zergling"]);
  });
});
