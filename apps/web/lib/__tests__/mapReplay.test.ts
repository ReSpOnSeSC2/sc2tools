import { describe, expect, it } from "vitest";
import {
  buildingAliveAt,
  buildingPositionAt,
  isTownHall,
  isWorkerUnit,
  miningArcPosition,
  nearestTownHall,
  patchesNearHall,
  patchMiningPosition,
  resourceAliveAt,
  projectX,
  projectY,
  sanitizeMapPlayback,
  spreadClusters,
  statsAt,
  unitAliveAt,
  unitMaxSpeed,
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

  it("keeps the v4 spent-death flag only when literally true", () => {
    const raw = {
      ...RAW,
      v: 4,
      units: [
        { owner: "me", name: "Drone", born: 0, died: 60, sd: true, wp: [0, 30, 40] },
        { owner: "me", name: "Drone", born: 0, died: 90, sd: "yes", wp: [0, 30, 40] },
        { owner: "me", name: "Drone", born: 0, died: 95, wp: [0, 30, 40] },
      ],
    };
    const p = sanitizeMapPlayback(raw);
    expect(p?.units[0].sd).toBe(true);
    expect(p?.units[1].sd).toBeUndefined();
    expect(p?.units[2].sd).toBeUndefined();
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

  it("holds unobserved gaps instead of inventing routes", () => {
    expect(unitPositionAt(wp, 125)).toEqual({ x: 30, y: 40 });
    expect(unitPositionAt(wp, 135)).toEqual({ x: 40, y: 50 });
  });

  it("never invents a last-minute dash through a five-minute observation gap", () => {
    const sparse = [0, 10, 10, 300, 40, 10];
    expect(unitPositionAt(sparse, 150, 5)).toEqual({ x: 10, y: 10 });
    expect(unitPositionAt(sparse, 293, 5)).toEqual({ x: 10, y: 10 });
    const mid = unitPositionAt(sparse, 297, 5)!;
    expect(mid.x).toBe(10);
    expect(mid.y).toBe(10);
    expect(unitPositionAt(sparse, 300, 5)).toEqual({ x: 40, y: 10 });
    expect(unitPositionAt(sparse, 150)).toEqual({ x: 10, y: 10 });
  });

  it("interpolates nearby observed positions at the recorded timing", () => {
    const tight = [0, 10, 10, 1, 14, 10];
    expect(unitPositionAt(tight, 0.5, 5)).toEqual({ x: 12, y: 10 });
  });

  it("unitMaxSpeed distinguishes workers from army", () => {
    expect(unitMaxSpeed("Probe")).toBeCloseTo(3.94);
    expect(unitMaxSpeed("SCV")).toBeCloseTo(3.94);
    expect(unitMaxSpeed("Stalker")).toBeGreaterThan(unitMaxSpeed("Drone"));
  });

  it("preserves observed Interceptor movement without the generic army speed hold", () => {
    const flight = [840, 100, 100, 841, 114, 100];
    expect(unitPositionAt(flight, 840.5, unitMaxSpeed("Interceptor", true))).toEqual({ x: 107, y: 100 });
    expect(unitPositionAt(flight, 840.5, unitMaxSpeed("Interceptor"))).toEqual({ x: 100, y: 100 });
  });

  it("keeps teleport and missing-observation guards for engine tracks", () => {
    const speed = unitMaxSpeed("Stalker", true);
    expect(unitPositionAt([0, 10, 10, 0.18, 20, 10], 0.09, speed)).toEqual({ x: 10, y: 10 });
    expect(unitPositionAt([0, 10, 10, 3, 20, 10], 1.5, speed)).toEqual({ x: 10, y: 10 });
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

  it("keeps lower-seeded survivors in place when a unit dies", () => {
    // Five stacked units seeded with stable payload indexes. When the
    // one seeded 30 dies, units seeded below it must keep their exact
    // offsets — no full-blob reshuffle mid-battle.
    const pts = Array.from({ length: 5 }, () => ({ x: 80, y: 80 }));
    const seeds = [10, 20, 30, 40, 50];
    const before = spreadClusters(pts, 10, 4, seeds);
    const after = spreadClusters(
      pts.slice(0, 2).concat(pts.slice(3)),
      10,
      4,
      [10, 20, 40, 50],
    );
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
  });

  it("assigns slots by seed order, not input order", () => {
    const pts = [
      { x: 60, y: 60 },
      { x: 60, y: 60 },
      { x: 60, y: 60 },
    ];
    const forward = spreadClusters(pts, 10, 4, [1, 2, 3]);
    const reversedSeeds = spreadClusters(pts, 10, 4, [3, 2, 1]);
    // Same identities, same slots — just delivered in a different order.
    expect(reversedSeeds[2]).toEqual(forward[0]);
    expect(reversedSeeds[1]).toEqual(forward[1]);
    expect(reversedSeeds[0]).toEqual(forward[2]);
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

describe("mining-line presentation", () => {
  const bounds = { minX: 0, minY: 0, maxX: 160, maxY: 160 };

  it("nearestTownHall picks the closest hall within range only", () => {
    const halls = [
      { x: 30, y: 30 },
      { x: 120, y: 120 },
    ];
    expect(nearestTownHall({ x: 33, y: 31 }, halls, 9)).toEqual({ x: 30, y: 30 });
    expect(nearestTownHall({ x: 80, y: 80 }, halls, 9)).toBeNull();
    expect(nearestTownHall({ x: 33, y: 31 }, [], 9)).toBeNull();
  });

  it("miningArcPosition is deterministic and hugs the hall", () => {
    const hall = { x: 30, y: 30 };
    const a = miningArcPosition(hall, bounds, 7);
    expect(miningArcPosition(hall, bounds, 7)).toEqual(a);
    const d = Math.hypot(a.x - hall.x, a.y - hall.y);
    expect(d).toBeGreaterThanOrEqual(4);
    expect(d).toBeLessThanOrEqual(6);
  });

  it("arc faces away from map center and spreads distinct seeds", () => {
    const hall = { x: 30, y: 30 }; // bottom-left of a 160x160 map
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const p = miningArcPosition(hall, bounds, seed);
      // Away-from-center for a bottom-left hall means down-left:
      // the offset must have a negative dot with the toward-center
      // direction... i.e. positive projection on (hall - center).
      const off = { x: p.x - hall.x, y: p.y - hall.y };
      const away = { x: 30 - 80, y: 30 - 80 };
      const dot = off.x * away.x + off.y * away.y;
      expect(dot).toBeGreaterThan(0);
      seen.add(`${p.x.toFixed(2)}:${p.y.toFixed(2)}`);
    }
    // Twelve workers land on twelve distinct spots along the line.
    expect(seen.size).toBe(12);
  });
});

describe("resources — sanitize and patch mining", () => {
  const bounds = { minX: 0, minY: 0, maxX: 160, maxY: 160 };
  const hall = { x: 30, y: 30 };

  it("sanitizes resources: kinds whitelisted, died null-safe", () => {
    const p = sanitizeMapPlayback({
      ...RAW,
      resources: [
        { kind: "minerals", x: 26, y: 34, died: null },
        { kind: "gold", x: 100, y: 100, died: 300 },
        { kind: "gas", x: 25, y: 27 },
        { kind: "rocks", x: 80, y: 80, died: 250 },
        { kind: "tower", x: 88, y: 88 },
        { kind: "nuke", x: 1, y: 1 }, // unknown kind dropped
        { kind: "minerals", x: NaN, y: 2 }, // junk coords dropped
      ],
    });
    expect(p!.resources).toHaveLength(5);
    expect(p!.resources[0].died).toBeNull();
    expect(p!.resources[1].died).toBe(300);
    expect(p!.resources[2].died).toBeNull();
  });

  it("v1 payloads default to empty resources", () => {
    expect(sanitizeMapPlayback(RAW)!.resources).toEqual([]);
  });

  it("resourceAliveAt clears mined-out nodes at their death time", () => {
    const node = { kind: "minerals" as const, x: 1, y: 1, died: 300 };
    expect(resourceAliveAt(node, 299)).toBe(true);
    expect(resourceAliveAt(node, 300)).toBe(false);
    expect(resourceAliveAt({ ...node, died: null }, 9999)).toBe(true);
  });

  it("patchesNearHall returns live nearby mineral patches sorted by distance", () => {
    const resources = [
      { kind: "minerals" as const, x: 26, y: 34, died: null },
      { kind: "gold" as const, x: 24, y: 28, died: null },
      { kind: "minerals" as const, x: 27, y: 31, died: 100 }, // mined out
      { kind: "minerals" as const, x: 140, y: 140, died: null }, // other base
      { kind: "gas" as const, x: 25, y: 27, died: null }, // not a patch
    ];
    const patches = patchesNearHall(resources, hall, 200);
    expect(patches).toHaveLength(2);
    // Sorted by distance: gold at ~6.3 cells, minerals at ~5.7.
    const d = (r: { x: number; y: number }) => Math.hypot(r.x - hall.x, r.y - hall.y);
    expect(d(patches[0])).toBeLessThanOrEqual(d(patches[1]));
    // Before the third patch mined out it participates too.
    expect(patchesNearHall(resources, hall, 50)).toHaveLength(3);
  });

  it("patchMiningPosition stands the worker between patch and hall", () => {
    const patch = { x: 24, y: 30 };
    const spot = patchMiningPosition(patch, hall, 3);
    expect(patchMiningPosition(patch, hall, 3)).toEqual(spot);
    // On the hall side of the patch, within ~1.6 cells.
    expect(spot.x).toBeGreaterThan(patch.x);
    const dist = Math.hypot(spot.x - patch.x, spot.y - patch.y);
    expect(dist).toBeGreaterThanOrEqual(1.1);
    expect(dist).toBeLessThanOrEqual(1.6);
  });
});

describe("buildings — lift/land moves and death (v3)", () => {
  it("sanitizes building moves and null-safe died", () => {
    const p = sanitizeMapPlayback({
      ...RAW,
      buildings: [
        {
          owner: "me",
          name: "CommandCenter",
          t: 10,
          x: 30,
          y: 40,
          moves: [400, 90, 90, 700, 150, 60],
          died: null,
        },
        { owner: "opp", name: "Barracks", t: 60, x: 160, y: 130, died: 500 },
        // Truncated triple: the trailing pair is dropped, prefix kept.
        {
          owner: "me",
          name: "Factory",
          t: 90,
          x: 40,
          y: 40,
          moves: [300, 50, 50, 600, 70],
        },
      ],
    });
    expect(p!.buildings[0].moves).toEqual([400, 90, 90, 700, 150, 60]);
    expect(p!.buildings[0].died).toBeNull();
    expect(p!.buildings[1].moves).toEqual([]);
    expect(p!.buildings[1].died).toBe(500);
    expect(p!.buildings[2].moves).toEqual([300, 50, 50]);
  });

  it("v1/v2 buildings default to no moves and immortal", () => {
    const p = sanitizeMapPlayback(RAW);
    expect(p!.buildings[0].moves).toEqual([]);
    expect(p!.buildings[0].died).toBeNull();
  });

  it("buildingAliveAt respects placement and death times", () => {
    const b = {
      owner: "me" as const,
      name: "Barracks",
      t: 60,
      x: 1,
      y: 1,
      moves: [],
      died: 500,
    };
    expect(buildingAliveAt(b, 59)).toBe(false);
    expect(buildingAliveAt(b, 60)).toBe(true);
    expect(buildingAliveAt(b, 499)).toBe(true);
    expect(buildingAliveAt(b, 500)).toBe(false);
    expect(buildingAliveAt({ ...b, died: null }, 9999)).toBe(true);
  });

  it("buildingPositionAt holds unknown flight intervals until an observed position", () => {
    const cc = {
      owner: "me" as const,
      name: "CommandCenter",
      t: 10,
      x: 30,
      y: 40,
      moves: [400, 90, 90],
      died: null,
    };
    expect(buildingPositionAt(cc, 0)).toEqual({ x: 30, y: 40 });
    expect(buildingPositionAt(cc, 200)).toEqual({ x: 30, y: 40 });
    // The route and departure time are unknown, so no flight is invented.
    const mid = buildingPositionAt(cc, 380);
    expect(mid).toEqual({ x: 30, y: 40 });
    // At and after the landing time it sits at the new base.
    expect(buildingPositionAt(cc, 400)).toEqual({ x: 90, y: 90 });
    expect(buildingPositionAt(cc, 9999)).toEqual({ x: 90, y: 90 });
  });

  it("buildingPositionAt without moves is the construction site forever", () => {
    const pylon = {
      owner: "me" as const,
      name: "Pylon",
      t: 20,
      x: 55,
      y: 66,
      moves: [],
      died: null,
    };
    expect(buildingPositionAt(pylon, 0)).toEqual({ x: 55, y: 66 });
    expect(buildingPositionAt(pylon, 5000)).toEqual({ x: 55, y: 66 });
  });

  it("follows observed uprooted structures without the tracker flying-building speed cap", () => {
    const crawler = {
      owner: "opp" as const, name: "SpineCrawlerUprooted", t: 10,
      x: 30, y: 40, moves: [12, 38, 40], died: null,
    };
    expect(buildingPositionAt(crawler, 11, true)).toEqual({ x: 34, y: 40 });
    expect(buildingPositionAt(crawler, 11)).toEqual({ x: 30, y: 40 });
  });
});

describe("gameLength clamp — the 1.4x Blizzard-time scrubber bug", () => {
  // Legacy (v<=2) agents declared gameLength in Blizzard game-time
  // (frames/16) while every event timestamp used real seconds
  // (frames/22.4) — a 16:04 game scrubbed to 22:29.
  it("clamps a declared length that overshoots all activity by >20%", () => {
    const p = sanitizeMapPlayback({
      ...RAW,
      gameLength: 1349, // 22:29 declared…
      stats: {
        me: [
          [0, 0, 12, 12],
          [964, 3000, 60, 150], // …but the last stats row lands at 16:04.
        ],
        opp: [[0, 0, 12, 12]],
      },
      units: [
        { owner: "me", name: "Probe", born: 0, died: null, wp: [0, 30, 40] },
      ],
    });
    expect(p!.gameLength).toBe(Math.round(964 * 1.02));
  });

  it("keeps a plausible declared length (quiet tail is not a bug)", () => {
    // Activity to t=650 with a declared 700: within 20%, trusted as-is.
    expect(sanitizeMapPlayback({
      ...RAW,
      gameLength: 700,
      stats: {
        me: [
          [0, 0, 12, 12],
          [650, 500, 20, 40],
        ],
        opp: [[0, 0, 12, 12]],
      },
    })!.gameLength).toBe(700);
  });

  it("never clamps short games and always covers recorded activity", () => {
    // Sub-minute activity: too little signal to second-guess the agent.
    const short = sanitizeMapPlayback({
      ...RAW,
      gameLength: 50,
      battles: [],
      stats: { me: [], opp: [] },
      units: [{ owner: "me", name: "Probe", born: 0, died: 30, wp: [0, 30, 40] }],
    });
    expect(short!.gameLength).toBe(50);
    // Declared length below the last event: stretched up, never truncated.
    const stretched = sanitizeMapPlayback({ ...RAW, gameLength: 100 });
    expect(stretched!.gameLength).toBeGreaterThanOrEqual(300);
  });
});
