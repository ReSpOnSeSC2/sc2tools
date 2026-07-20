import { describe, expect, it } from "vitest";
import {
  isTownHall,
  isWorkerUnit,
  projectX,
  projectY,
  sanitizeMapPlayback,
  spreadClusters,
  statsAt,
  unitAliveAt,
  unitPositionAt,
  worldProjection,
} from "../mapReplay";

const RAW = {
  v: 1,
  mapName: "Alcyone LE",
  gameLength: 700,
  bounds: { minX: 10, minY: 20, maxX: 190, maxY: 160 },
  spawns: [{ owner: "me", x: 30, y: 40 }],
  battles: [{ t: 200, x: 100, y: 90 }],
  buildings: [
    { owner: "me", name: "Nexus", t: 0, x: 30, y: 40 },
    { owner: "opp", name: "Hatchery", t: 0, x: 170, y: 140 },
  ],
  units: [
    {
      owner: "me",
      name: "Stalker",
      born: 120,
      died: 300,
      wp: [120, 30, 40, 130, 40, 50, 140, 60, 70],
    },
    { owner: "opp", name: "Drone", born: 0, died: null, wp: [0, 170, 140] },
  ],
  stats: {
    me: [
      [0, 0, 12, 12],
      [100, 500, 20, 40],
    ],
    opp: [[0, 0, 12, 12]],
  },
};

describe("sanitizeMapPlayback", () => {
  it("round-trips a well-formed payload", () => {
    const p = sanitizeMapPlayback(RAW);
    expect(p).not.toBeNull();
    expect(p?.units).toHaveLength(2);
    expect(p?.buildings).toHaveLength(2);
    expect(p?.battles).toHaveLength(1);
    expect(p?.stats.me).toHaveLength(2);
  });

  it("rejects junk bounds and empty payloads", () => {
    expect(sanitizeMapPlayback(null)).toBeNull();
    expect(
      sanitizeMapPlayback({ ...RAW, bounds: { minX: 5, minY: 0, maxX: 5, maxY: 9 } }),
    ).toBeNull();
    expect(sanitizeMapPlayback({ ...RAW, units: [], buildings: [] })).toBeNull();
  });

  it("drops malformed units but keeps the rest", () => {
    const p = sanitizeMapPlayback({
      ...RAW,
      units: [...RAW.units, { owner: "evil", wp: [1, 2, 3] }, { owner: "me", wp: [] }],
    });
    expect(p?.units).toHaveLength(2);
  });

  it("keeps survivors alive: wire died:null must stay null, not become 0", () => {
    // Number(null) is 0 — a naive coercion marks every unit that
    // survived the game as dead at t=0 and hides the winner's whole
    // army from the playback.
    const p = sanitizeMapPlayback(RAW);
    const survivor = p!.units.find((u) => u.name === "Drone")!;
    expect(survivor.died).toBeNull();
    expect(unitAliveAt(survivor, p!.gameLength - 1)).toBe(true);
    // Explicit numeric deaths still coerce, including t=0 edge cases.
    const dead = sanitizeMapPlayback({
      ...RAW,
      units: [{ owner: "me", name: "Probe", born: 0, died: 0, wp: [0, 1, 1] }],
    });
    expect(dead!.units[0].died).toBe(0);
  });
});

describe("unit interpolation", () => {
  const wp = [120, 30, 40, 130, 40, 50, 140, 60, 70];

  it("clamps before and after the track", () => {
    expect(unitPositionAt(wp, 100)).toEqual({ x: 30, y: 40 });
    expect(unitPositionAt(wp, 999)).toEqual({ x: 60, y: 70 });
  });

  it("interpolates linearly between waypoints", () => {
    expect(unitPositionAt(wp, 125)).toEqual({ x: 35, y: 45 });
    expect(unitPositionAt(wp, 135)).toEqual({ x: 50, y: 60 });
  });

  it("aliveAt respects born/died and immortal units", () => {
    const u = { owner: "me" as const, name: "Stalker", born: 120, died: 300, wp };
    expect(unitAliveAt(u, 119)).toBe(false);
    expect(unitAliveAt(u, 200)).toBe(true);
    expect(unitAliveAt(u, 300)).toBe(false);
    expect(unitAliveAt({ ...u, died: null }, 9999)).toBe(true);
  });
});

describe("worldProjection", () => {
  it("preserves aspect and flips Y", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    const proj = worldProjection(bounds, 216, 216, 8);
    // Width-limited: k = 200/100 = 2.
    expect(proj.k).toBe(2);
    // World bottom-left (0,0) lands at canvas bottom-left of the fitted rect.
    expect(projectX(bounds, proj, 0)).toBe(proj.ox);
    expect(projectY(bounds, proj, 0)).toBe(proj.oy + 100); // maxY span * k
    // World top (y=50) is canvas-up (smaller y).
    expect(projectY(bounds, proj, 50)).toBe(proj.oy);
  });
});

describe("spreadClusters — the unit-spacing fix", () => {
  it("leaves loners untouched and spreads stacked points", () => {
    const stacked = [
      { x: 100, y: 100 },
      { x: 100.5, y: 100.2 },
      { x: 99.8, y: 100.1 },
      { x: 300, y: 50 }, // loner far away
    ];
    const out = spreadClusters(stacked, 10, 4);
    // Loner untouched.
    expect(out[3]).toEqual({ x: 300, y: 50 });
    // Cluster members no longer coincide: pairwise distance ≥ ~3px.
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(out[0], out[1])).toBeGreaterThan(3);
    expect(d(out[0], out[2])).toBeGreaterThan(3);
    expect(d(out[1], out[2])).toBeGreaterThan(3);
    // …but stay near the centroid (a blob, not an explosion).
    for (const p of out.slice(0, 3)) {
      expect(d(p, { x: 100.1, y: 100.1 })).toBeLessThan(12);
    }
  });

  it("is deterministic", () => {
    const pts = Array.from({ length: 20 }, () => ({ x: 50, y: 50 }));
    expect(spreadClusters(pts, 10, 4)).toEqual(spreadClusters(pts, 10, 4));
  });
});

describe("statsAt", () => {
  const rows = [
    [0, 0, 12, 12],
    [100, 500, 20, 40],
  ];
  it("clamps and interpolates", () => {
    expect(statsAt(rows, -5)).toEqual({ army: 0, workers: 12, supply: 12 });
    expect(statsAt(rows, 200)).toEqual({ army: 500, workers: 20, supply: 40 });
    expect(statsAt(rows, 50)).toEqual({ army: 250, workers: 16, supply: 26 });
    expect(statsAt([], 10)).toEqual({ army: 0, workers: 0, supply: 0 });
  });
});

describe("unit classes", () => {
  it("classifies workers and town halls", () => {
    expect(isWorkerUnit("Probe")).toBe(true);
    expect(isWorkerUnit("Stalker")).toBe(false);
    expect(isTownHall("Hatchery")).toBe(true);
    expect(isTownHall("Gateway")).toBe(false);
  });
});
