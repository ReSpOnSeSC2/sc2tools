import { describe, expect, it } from "vitest";

import {
  BUILD_TIME_CLOCK_SCALE,
  STRUCTURE_BUILD_SECONDS,
  UNIT_BUILD_SECONDS,
  buildOrderIndexAt,
  compositionAt,
  deriveReplayHud,
  formatClock,
  hudAt,
  phaseBands,
  prettyName,
  productionAt,
  structuresAt,
  supplyCapAt,
} from "@/lib/replayHud";

import { payload, v4Payload } from "./fixtures";

describe("build-order derivation", () => {
  const pb = payload();
  const model = deriveReplayHud(pb);

  it("merges units and structures into one feed, ordered by event time", () => {
    const times = model.buildOrder.map((e) => e.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(model.buildOrder.some((e) => e.kind === "unit")).toBe(true);
    expect(model.buildOrder.some((e) => e.kind === "structure")).toBe(true);
  });

  it("uses the payload's own event times", () => {
    const pool = model.buildOrder.find((e) => e.name === "SpawningPool");
    expect(pool).toMatchObject({ kind: "structure", owner: "me", t: 33 });
    const roach = model.buildOrder.find((e) => e.name === "Roach");
    expect(roach).toMatchObject({ kind: "unit", owner: "me", t: 200 });
  });

  it("collapses a hatched pair into one row with a count", () => {
    const lings = model.buildOrder.filter(
      (e) => e.name === "Zergling" && e.owner === "me",
    );
    expect(lings).toHaveLength(2);
    expect(lings[0]).toMatchObject({ t: 100, count: 2 });
    expect(lings[1]).toMatchObject({ t: 150, count: 1 });
  });

  it("never merges two sides together", () => {
    const marines = model.buildOrder.filter((e) => e.name === "Marine");
    expect(marines).toHaveLength(2);
    expect(marines.every((m) => m.owner === "opp")).toBe(true);
  });

  it("reads the supply column off the interpolated stats series", () => {
    // supplyUsed is 13 at t=0 and 22 at t=100 → 16.0 at t=33.
    expect(model.buildOrder.find((e) => e.name === "SpawningPool")?.supply).toBe(16);
    expect(model.buildOrder.find((e) => e.name === "Roach")?.supply).toBe(34);
  });

  it("flags worker production so the rail can hide it", () => {
    expect(model.buildOrder.find((e) => e.name === "Drone")?.isWorker).toBe(true);
    expect(model.buildOrder.find((e) => e.name === "SCV")?.isWorker).toBe(true);
    expect(model.buildOrder.find((e) => e.name === "Roach")?.isWorker).toBe(false);
  });

  it("emits unique React keys", () => {
    const keys = model.buildOrder.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("finds the current row with a binary search that matches a linear scan", () => {
    const rows = model.buildOrder;
    const linear = (t: number) => {
      let hit = -1;
      rows.forEach((r, i) => {
        if (r.t <= t) hit = i;
      });
      return hit;
    };
    for (const t of [-1, 0, 32.999, 33, 100, 155, 250, 1e6]) {
      expect(buildOrderIndexAt(rows, t)).toBe(linear(t));
    }
  });
});

describe("composition at a time", () => {
  const pb = payload();
  const model = deriveReplayHud(pb);

  it("counts only units alive at t", () => {
    const c = compositionAt(model, "me", 120);
    expect(c.army.find((r) => r.name === "Zergling")?.count).toBe(2);
    expect(c.army.find((r) => r.name === "Roach")).toBeUndefined();
  });

  it("drops units once they die", () => {
    expect(
      compositionAt(model, "me", 160).army.find((r) => r.name === "Zergling")?.count,
    ).toBe(1);
  });

  it("separates workers from the army", () => {
    const c = compositionAt(model, "me", 250);
    expect(c.workers).toBe(2);
    expect(c.army.some((r) => r.name === "Drone")).toBe(false);
    expect(c.army.reduce((n, r) => n + r.count, 0)).toBe(c.armyCount);
  });

  it("sorts the army by count, descending", () => {
    const counts = compositionAt(model, "me", 250).army.map((r) => r.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("counts standing structures", () => {
    expect(structuresAt(pb, "me", 10).find((r) => r.name === "Hatchery")?.count).toBe(1);
    expect(structuresAt(pb, "me", 130).find((r) => r.name === "Hatchery")?.count).toBe(2);
    expect(structuresAt(pb, "me", 10).find((r) => r.name === "SpawningPool")).toBeUndefined();
  });
});

describe("derived production queue", () => {
  const pb = payload();
  const model = deriveReplayHud(pb);

  it("carries a sane SC2 build-time table", () => {
    expect(UNIT_BUILD_SECONDS.Marine).toBe(18);
    expect(UNIT_BUILD_SECONDS.Zergling).toBe(17);
    expect(UNIT_BUILD_SECONDS.Drone).toBe(12);
    expect(STRUCTURE_BUILD_SECONDS.SpawningPool).toBe(46);
    expect(STRUCTURE_BUILD_SECONDS.CommandCenter).toBe(71);
    expect(BUILD_TIME_CLOCK_SCALE).toBe(1);
  });

  it("holds an item over [finish - buildTime, finish)", () => {
    // Roach finishes at 200, builds in 19 s.
    expect(productionAt(model, "me", 180).units).toHaveLength(0);
    expect(productionAt(model, "me", 190).units[0]?.name).toBe("Roach");
    expect(
      productionAt(model, "me", 200).units.some((g) => g.name === "Roach"),
    ).toBe(false);
  });

  it("counts down with the payload's own finish time, not the table", () => {
    expect(productionAt(model, "me", 190).units[0]?.remaining).toBe(10);
    expect(productionAt(model, "me", 195).units[0]?.remaining).toBe(5);
  });

  it("groups identical units and reports the soonest to land", () => {
    const g = productionAt(model, "me", 90).units.find((x) => x.name === "Zergling");
    expect(g?.count).toBe(2);
    expect(g?.remaining).toBeCloseTo(10, 9);
  });

  it("keeps structures in their own list", () => {
    const q = productionAt(model, "me", 20);
    expect(q.structures.map((g) => g.name)).toContain("SpawningPool");
    expect(q.units.map((g) => g.name)).not.toContain("SpawningPool");
  });

  it("starts observed structures at placement and removes cancelled construction", () => {
    const observed = deriveReplayHud(payload({ v: 6, buildings: [
      { owner: "me", name: "Nexus", t: 0, x: 10, y: 10, moves: [], died: null },
      { owner: "me", name: "Pylon", t: 40, x: 15, y: 15, moves: [], died: 45 },
      { owner: "me", name: "Gateway", t: 60, x: 18, y: 18, moves: [], died: null },
    ] }));
    expect(productionAt(observed, "me", 0).structures).toEqual([]);
    expect(productionAt(observed, "me", 41).structures.map((g) => g.name)).toEqual(["Pylon"]);
    expect(productionAt(observed, "me", 46).structures).toEqual([]);
    expect(productionAt(observed, "me", 61).structures.map((g) => g.name)).toEqual(["Gateway"]);
    expect(supplyCapAt(observed, "me", 100)).toBe(15 + 8); // initial Nexus and fixture Overlord; cancelled Pylon gives none
  });

  it("never yields a negative start time", () => {
    for (const side of ["me", "opp"] as const) {
      for (const item of model.production[side]) {
        expect(item.start).toBeGreaterThanOrEqual(0);
        expect(item.finish).toBeGreaterThanOrEqual(item.start);
      }
    }
  });

  it("ignores names that are not produced (Larva, Broodling, …)", () => {
    const m = deriveReplayHud(
      payload({
        units: [
          { owner: "me", name: "Larva", born: 50, died: 60, wp: [50, 30, 30, 60, 30, 30] },
          { owner: "me", name: "Broodling", born: 50, died: 60, wp: [50, 30, 30, 60, 30, 30] },
          { owner: "me", name: "Drone", born: 55, died: null, wp: [55, 30, 30, 600, 30, 30] },
        ],
      }),
    );
    expect(productionAt(m, "me", 48).units.map((g) => g.name)).toEqual(["Drone"]);
  });
});

describe("HUD interpolation", () => {
  const pb = payload();
  const model = deriveReplayHud(pb);

  it("interpolates between the ~10 s stat rows instead of stepping", () => {
    const at150 = hudAt(model, pb, 150);
    expect(at150.me.armyValue).toBeCloseTo(250, 9);
    expect(at150.me.supplyUsed).toBeCloseTo(28, 9);
    expect(at150.opp.armyValue).toBeCloseTo(175, 9);
    // one second later the number has actually moved
    expect(hudAt(model, pb, 151).me.armyValue).toBeCloseTo(253, 9);
  });

  it("clamps before the first row and after the last", () => {
    expect(hudAt(model, pb, -50).me.armyValue).toBe(0);
    expect(hudAt(model, pb, 10_000).me.armyValue).toBe(400);
  });

  it("derives the supply cap from live providers", () => {
    expect(supplyCapAt(model, "me", 1)).toBe(14); // Hatchery 6 + Overlord 8
    expect(supplyCapAt(model, "me", 130)).toBe(20); // + second Hatchery
    expect(supplyCapAt(model, "opp", 30)).toBe(23); // CC 15 + Depot 8
  });

  it("prices kills and losses from the death list", () => {
    expect(hudAt(model, pb, 157).me.kills).toBe(0);
    expect(hudAt(model, pb, 159).me.kills).toBe(1);
    expect(hudAt(model, pb, 157).opp.kills).toBe(2);
    expect(hudAt(model, pb, 300).me.lostMinerals).toBeGreaterThan(0);
  });

  it("falls back to live workers when the stats column is all zero", () => {
    const zeroed = payload({
      stats: {
        me: [
          [0, 0, 0, 13],
          [200, 400, 0, 34],
        ],
        opp: [[0, 0, 0, 12]],
      },
    });
    expect(hudAt(deriveReplayHud(zeroed), zeroed, 100).me.workers).toBe(2);
  });

  it("reports minerals and gas as null unless a banked series is supplied", () => {
    const bare = hudAt(model, pb, 100);
    expect(bare.me.minerals).toBeNull();
    expect(bare.me.gas).toBeNull();

    const withBank = hudAt(model, pb, 50, {
      me: [
        [0, 0, 0],
        [100, 500, 200],
      ],
      opp: [
        [0, 0, 0],
        [100, 300, 100],
      ],
    });
    expect(withBank.me.minerals).toBe(250);
    expect(withBank.me.gas).toBe(100);
  });
});

describe("timeline markers and phases", () => {
  it("prices a battle marker from the deaths around it", () => {
    const model = deriveReplayHud(payload());
    const battle = model.markers.find((m) => m.kind === "battle");
    expect(battle?.t).toBe(155);
    expect(battle?.title).toMatch(/^2:35 · /);
  });

  it("labels a one-sided fight as harass", () => {
    const model = deriveReplayHud(
      payload({
        battles: [{ t: 300, x: 30, y: 30 }],
        units: [
          { owner: "me", name: "Drone", born: 0, died: 300, wp: [0, 30, 30, 600, 30, 30] },
          { owner: "me", name: "Drone", born: 0, died: 301, wp: [0, 30, 30, 600, 30, 30] },
          { owner: "me", name: "Drone", born: 0, died: 302, wp: [0, 30, 30, 600, 30, 30] },
        ],
      }),
    );
    const marker = model.markers.find((m) => m.kind === "battle");
    expect(marker?.label).toBe("Harass taken");
    expect(marker?.owner).toBe("me");
  });

  it("keeps only fight-deciding casts", () => {
    const model = deriveReplayHud(payload());
    const casts = model.markers.filter((m) => m.kind === "cast");
    expect(casts.map((c) => c.label)).toEqual(["EMP"]);
  });

  it("derives everything from a v4 payload that has no casts at all", () => {
    const pb = v4Payload();
    expect(pb.casts).toBeUndefined();
    const model = deriveReplayHud(pb);
    expect(model.markers.every((m) => m.kind === "battle")).toBe(true);
    expect(model.buildOrder.length).toBeGreaterThan(0);
    expect(hudAt(model, pb, 100).me.armyValue).toBeGreaterThanOrEqual(0);
  });

  it("caps the marker count so the timeline stays keyboard-navigable", () => {
    const model = deriveReplayHud(
      payload({
        battles: Array.from({ length: 200 }, (_, i) => ({ t: i * 3, x: 100, y: 100 })),
      }),
    );
    expect(model.markers.length).toBeLessThanOrEqual(160);
  });

  it("clips phase bands to the real game length with no gaps", () => {
    expect(phaseBands(240)).toEqual([{ label: "OPENING", from: 0, to: 240 }]);
    const long = phaseBands(1800);
    expect(long.map((p) => p.label)).toEqual(["OPENING", "MID GAME", "LATE GAME"]);
    expect(long[2].to).toBe(1800);
    for (let i = 1; i < long.length; i += 1) {
      expect(long[i].from).toBe(long[i - 1].to);
    }
  });
});

describe("formatting", () => {
  it("formats the game clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(155)).toBe("2:35");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("humanises payload names without mangling acronyms", () => {
    expect(prettyName("SpawningPool")).toBe("Spawning Pool");
    expect(prettyName("HighTemplar")).toBe("High Templar");
    expect(prettyName("SCV")).toBe("SCV");
    expect(prettyName("MULE")).toBe("MULE");
    expect(prettyName("")).toBe("");
  });
});
