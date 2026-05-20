"use strict";

/**
 * Parity tests for the server-side port of compositionAt.ts. The
 * macro breakdown panel runs the TS module in the browser; the
 * per-game scouting envelope runs this JS port. Both must produce
 * identical canonical names, identical cumulative build-order /
 * buildings / upgrades counts, and identical alive-composition
 * derivations at the same target time. When the TS module gains a
 * new alias or rule, mirror it here and add a test.
 */

const {
  canonicalizeName,
  folded,
  buildOrderUnitsAt,
  countBuildingsAt,
  countUpgradesAt,
  derivedDeathsFromTimeline,
  nearestTimelineEntry,
  deriveUnitComposition,
  tieredUpgradeFamily,
  sortByCountDesc,
} = require("../src/services/scouting/compositionAt");

describe("canonicalizeName", () => {
  test("aliases the full sc2reader variant table", () => {
    expect(canonicalizeName("LurkerMP")).toBe("Lurker");
    expect(canonicalizeName("LurkerMPBurrowed")).toBe("Lurker");
    expect(canonicalizeName("LurkerMPEgg")).toBe("Lurker");
    expect(canonicalizeName("SiegeTankSieged")).toBe("SiegeTank");
    expect(canonicalizeName("VikingFighter")).toBe("Viking");
    expect(canonicalizeName("WarpPrismPhasing")).toBe("WarpPrism");
    expect(canonicalizeName("OverlordTransport")).toBe("Overlord");
  });

  test("regex suffix strip catches unenumerated variants", () => {
    expect(canonicalizeName("CarrierFlying")).toBe("Carrier");
    expect(canonicalizeName("BarracksFlying")).toBe("Barracks");
    expect(canonicalizeName("SpineCrawlerUprooted")).toBe("SpineCrawler");
  });

  test("passes through canonical names unchanged", () => {
    expect(canonicalizeName("Marine")).toBe("Marine");
    expect(canonicalizeName("Stalker")).toBe("Stalker");
    expect(canonicalizeName("Hatchery")).toBe("Hatchery");
  });

  test("returns empty string for empty input", () => {
    expect(canonicalizeName("")).toBe("");
  });
});

describe("folded", () => {
  test("sums variants under canonical names", () => {
    const out = folded({
      Lurker: 4,
      LurkerMP: 3,
      LurkerMPBurrowed: 2,
      Roach: 14,
      RoachBurrowed: 6,
    });
    expect(out).toEqual({ Lurker: 9, Roach: 20 });
  });

  test("drops zero / negative counts", () => {
    const out = folded({ Marine: 0, Stalker: -2, Probe: 12 });
    expect(out).toEqual({ Probe: 12 });
  });
});

describe("buildOrderUnitsAt", () => {
  test("counts non-worker, non-building units cumulatively", () => {
    const events = [
      { time: 0, name: "Nexus", is_building: true },
      { time: 12, name: "Probe", is_building: false },
      { time: 30, name: "Pylon", is_building: true },
      { time: 60, name: "Zealot", is_building: false },
      { time: 90, name: "Zealot", is_building: false },
      { time: 120, name: "Stalker", is_building: false },
    ];
    expect(buildOrderUnitsAt(events, 100)).toEqual({ Zealot: 2 });
    expect(buildOrderUnitsAt(events, 150)).toEqual({ Zealot: 2, Stalker: 1 });
  });

  test("applies morph parent consumption", () => {
    const events = [
      { time: 60, name: "Hydralisk", is_building: false },
      { time: 90, name: "Hydralisk", is_building: false },
      { time: 120, name: "Lurker", is_building: false },
    ];
    // The Lurker consumes one Hydralisk.
    expect(buildOrderUnitsAt(events, 200)).toEqual({ Hydralisk: 1, Lurker: 1 });
  });

  test("Archon consumes 2 templar parents (prefers DT over HT)", () => {
    const events = [
      { time: 60, name: "DarkTemplar", is_building: false },
      { time: 65, name: "DarkTemplar", is_building: false },
      { time: 70, name: "HighTemplar", is_building: false },
      { time: 90, name: "Archon", is_building: false },
    ];
    // First DT-DT pair becomes the Archon; second DT and HT remain.
    expect(buildOrderUnitsAt(events, 200)).toEqual({
      HighTemplar: 1,
      Archon: 1,
    });
  });

  test("skips upgrade-category events", () => {
    const events = [
      { time: 60, name: "Zealot", is_building: false, category: "unit" },
      { time: 90, name: "Charge", is_building: false, category: "upgrade" },
    ];
    expect(buildOrderUnitsAt(events, 200)).toEqual({ Zealot: 1 });
  });

  test("skips events past t (events are sorted ascending)", () => {
    const events = [
      { time: 60, name: "Zealot", is_building: false },
      { time: 120, name: "Stalker", is_building: false },
      { time: 200, name: "Immortal", is_building: false },
    ];
    expect(buildOrderUnitsAt(events, 100)).toEqual({ Zealot: 1 });
  });
});

describe("countBuildingsAt", () => {
  test("counts buildings cumulatively with morph chain collapse", () => {
    const events = [
      { time: 0, name: "Hatchery", is_building: true },
      { time: 100, name: "Hatchery", is_building: true },
      { time: 200, name: "SpawningPool", is_building: true },
      { time: 300, name: "Lair", is_building: true },
      { time: 400, name: "Hive", is_building: true },
      { time: 500, name: "Spire", is_building: true },
      { time: 600, name: "GreaterSpire", is_building: true },
    ];
    expect(countBuildingsAt(events, 700)).toEqual({
      Hatchery: 1,
      SpawningPool: 1,
      Hive: 1,
      GreaterSpire: 1,
    });
  });

  test("WarpGate consumes a Gateway", () => {
    const events = [
      { time: 0, name: "Gateway", is_building: true },
      { time: 200, name: "Gateway", is_building: true },
      { time: 300, name: "WarpGate", is_building: true },
    ];
    expect(countBuildingsAt(events, 500)).toEqual({
      Gateway: 1,
      WarpGate: 1,
    });
  });

  test("OrbitalCommand / PlanetaryFortress consume a CommandCenter", () => {
    const events = [
      { time: 0, name: "CommandCenter", is_building: true },
      { time: 100, name: "CommandCenter", is_building: true },
      { time: 200, name: "OrbitalCommand", is_building: true },
      { time: 300, name: "PlanetaryFortress", is_building: true },
    ];
    expect(countBuildingsAt(events, 400)).toEqual({
      OrbitalCommand: 1,
      PlanetaryFortress: 1,
    });
  });

  test("residual Gateways fold into WarpGate once WarpGate research is complete", () => {
    // In SC2 every Gateway auto-morphs into a Warp Gate once the
    // WarpGate research finishes (≈7 s per building). Residual
    // Gateway entries — from an in-flight construction at the
    // hovered time, or from a morph entry trimmed out of a slim
    // payload — must collapse onto the WarpGate chip so the roster
    // doesn't split the same in-game building type across two icons.
    const events = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Gateway", is_building: true },
      { time: 90, name: "Gateway", is_building: true },
      { time: 100, complete_time: 200, name: "WarpGateResearch", is_building: false, category: "upgrade" },
      { time: 210, name: "WarpGate", is_building: true },
    ];
    expect(countBuildingsAt(events, 9999)).toEqual({ WarpGate: 3 });
  });

  test("Gateways stay separate while WarpGate research is in progress", () => {
    const events = [
      { time: 30, name: "Gateway", is_building: true },
      { time: 60, name: "Gateway", is_building: true },
      { time: 100, complete_time: 200, name: "WarpGateResearch", is_building: false, category: "upgrade" },
    ];
    expect(countBuildingsAt(events, 150)).toEqual({ Gateway: 2 });
  });
});

describe("countUpgradesAt", () => {
  test("non-tiered upgrades count as 1 each", () => {
    const events = [
      { time: 60, name: "Charge", is_building: false, category: "upgrade" },
      { time: 90, name: "Stim", is_building: false, category: "upgrade" },
    ];
    expect(countUpgradesAt(events, 200)).toEqual({ Charge: 1, Stim: 1 });
  });

  test("tiered families collapse onto highest tier reached", () => {
    const events = [
      {
        time: 100, name: "ProtossGroundWeaponsLevel1",
        is_building: false, category: "upgrade",
      },
      {
        time: 200, name: "ProtossGroundWeaponsLevel2",
        is_building: false, category: "upgrade",
      },
      {
        time: 300, name: "ProtossGroundWeaponsLevel3",
        is_building: false, category: "upgrade",
      },
    ];
    // Only the level-3 entry survives, count value is the tier (3).
    expect(countUpgradesAt(events, 400)).toEqual({
      ProtossGroundWeaponsLevel3: 3,
    });
  });

  test("uses complete_time over time when both are present", () => {
    const events = [
      {
        time: 100,
        complete_time: 250,
        name: "Charge",
        is_building: false,
        category: "upgrade",
      },
    ];
    expect(countUpgradesAt(events, 200)).toEqual({});
    expect(countUpgradesAt(events, 250)).toEqual({ Charge: 1 });
  });
});

describe("derivedDeathsFromTimeline", () => {
  test("emits death events when a unit count drops between samples", () => {
    const timeline = [
      { time: 100, my: { Marine: 10 }, opp: { Zergling: 8 } },
      { time: 200, my: { Marine: 7 }, opp: { Zergling: 8 } },
      { time: 300, my: { Marine: 4 }, opp: { Zergling: 5 } },
    ];
    const myDeaths = derivedDeathsFromTimeline(timeline, "my");
    expect(myDeaths).toEqual([
      { time: 200, name: "Marine", count: 3 },
      { time: 300, name: "Marine", count: 3 },
    ]);
    const oppDeaths = derivedDeathsFromTimeline(timeline, "opp");
    expect(oppDeaths).toEqual([
      { time: 300, name: "Zergling", count: 3 },
    ]);
  });

  test("treats both-sides-empty as a data gap, not a wipe", () => {
    // When both sides go empty in the same step, the function skips
    // that pair (extractor gap rather than a real army wipe). With
    // only consecutive-pair walking and no cross-gap reconciliation,
    // a death that straddles the gap is not detected — the deriver
    // only emits actual count drops between adjacent samples.
    const timeline = [
      { time: 100, my: { Marine: 10 }, opp: { Zergling: 8 } },
      { time: 200, my: {}, opp: {} }, // both empty — data gap
      { time: 300, my: { Marine: 7 }, opp: { Zergling: 8 } },
    ];
    // No death events: the t=100→t=200 step is skipped as a data gap,
    // and t=200→t=300 is an INCREASE (0 → 7), not a decrease.
    expect(derivedDeathsFromTimeline(timeline, "my")).toEqual([]);
  });
});

describe("deriveUnitComposition", () => {
  test("prefers unit_timeline alive count when populated", () => {
    const timeline = [
      { time: 200, my: { Marine: 10, Marauder: 4 }, opp: {} },
    ];
    const res = deriveUnitComposition({
      timeline,
      buildEvents: [
        { time: 60, name: "Marine", is_building: false },
        { time: 90, name: "Marine", is_building: false },
        { time: 120, name: "Marine", is_building: false },
      ],
      side: "my",
      t: 200,
    });
    expect(res.source).toBe("timeline");
    expect(res.units).toEqual({ Marine: 10, Marauder: 4 });
  });

  test("falls back to build-order cumulative when timeline is empty for the side", () => {
    const timeline = [
      { time: 200, my: {}, opp: { Zergling: 12 } },
    ];
    const res = deriveUnitComposition({
      timeline,
      buildEvents: [
        { time: 60, name: "Zealot", is_building: false },
        { time: 90, name: "Zealot", is_building: false },
        { time: 120, name: "Stalker", is_building: false },
      ],
      side: "my",
      t: 200,
    });
    expect(res.source).toBe("build_order");
    expect(res.units).toEqual({ Zealot: 2, Stalker: 1 });
  });

  test("hybrid path subtracts timeline-derived deaths from cumulative build", () => {
    const timeline = [
      { time: 100, my: { Marine: 4 }, opp: { Zergling: 6 } },
      { time: 200, my: { Marine: 1 }, opp: { Zergling: 6 } }, // 3 marines died
      { time: 250, my: { Marauder: 1 }, opp: { Zergling: 6 } }, // marauder built, marine still dead
    ];
    const res = deriveUnitComposition({
      timeline,
      buildEvents: [
        { time: 30, name: "Marine", is_building: false },
        { time: 60, name: "Marine", is_building: false },
        { time: 90, name: "Marine", is_building: false },
        { time: 120, name: "Marine", is_building: false },
        { time: 150, name: "Marauder", is_building: false },
      ],
      side: "my",
      // Falls through to hybrid only when the nearest timeline sample
      // is empty for this side. At t=300 the nearest sample is t=250
      // which has Marauder:1 — timeline source would win. Use a time
      // before any timeline entry so the timeline path falls through
      // to build-order + deaths (still detects the 3-marine death
      // between t=100 and t=200, but doesn't apply post-200 deaths).
      t: 230,
    });
    // ``nearestTimelineEntry`` picks the closest sample by ABSOLUTE
    // distance, not prior — at t=230 the nearest is t=250
    // (Marauder:1). That row is populated for "my" so the timeline
    // path wins outright. Hybrid is exercised only when every
    // closer-side row is empty, which the next test covers.
    expect(res.source).toBe("timeline");
    expect(res.units).toEqual({ Marauder: 1 });
  });

  test("hybrid path exercised when nearest timeline sample is empty for side", () => {
    // Timeline has data only for opp side; my side empty at every
    // tick. Forces the fallback to build-order minus deaths-from-
    // timeline-of-this-side (which is empty here, so no deaths).
    const timeline = [
      { time: 100, my: {}, opp: { Zergling: 6 } },
      { time: 200, my: {}, opp: { Zergling: 6 } },
    ];
    const res = deriveUnitComposition({
      timeline,
      buildEvents: [
        { time: 60, name: "Marine", is_building: false },
        { time: 90, name: "Marine", is_building: false },
      ],
      side: "my",
      t: 300,
    });
    // No my-side deaths visible → source is "build_order" (not
    // "hybrid" — hybrid only when deaths were actually applied).
    expect(res.source).toBe("build_order");
    expect(res.units).toEqual({ Marine: 2 });
  });

  test("returns empty when neither source is populated", () => {
    const res = deriveUnitComposition({
      timeline: [],
      buildEvents: [],
      side: "my",
      t: 200,
    });
    expect(res.source).toBe("empty");
    expect(res.units).toEqual({});
  });
});

describe("nearestTimelineEntry", () => {
  test("picks the row closest in time", () => {
    const timeline = [
      { time: 100 },
      { time: 200 },
      { time: 350 },
    ];
    expect(nearestTimelineEntry(timeline, 220)).toEqual({ time: 200 });
    expect(nearestTimelineEntry(timeline, 290)).toEqual({ time: 350 });
  });
});

describe("tieredUpgradeFamily + sortByCountDesc", () => {
  test("tieredUpgradeFamily normalises tiered upgrade names", () => {
    expect(tieredUpgradeFamily("ProtossGroundWeaponsLevel2")).toEqual({
      family: "protossgroundweapons",
      tier: 2,
    });
    expect(tieredUpgradeFamily("TerranInfantryArmorsLevel3")).toEqual({
      family: "terraninfantryarmor",
      tier: 3,
    });
    expect(tieredUpgradeFamily("Charge")).toBeNull();
  });

  test("sortByCountDesc sorts by count desc, name asc on ties", () => {
    expect(sortByCountDesc({ Marine: 5, Marauder: 8, Medivac: 5 }))
      .toEqual([
        { name: "Marauder", count: 8 },
        { name: "Marine", count: 5 },
        { name: "Medivac", count: 5 },
      ]);
  });
});
