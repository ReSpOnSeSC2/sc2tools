// @ts-nocheck
"use strict";

const fs = require("fs");
const path = require("path");

const { computeTransitions } = require("../src/services/buildTransitions");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "phase");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

/**
 * Build a macroBreakdown whose score drives the classifier into the
 * "late" band by the end of the game (3 bases, 5 tech buildings,
 * stats climbing through workers/supply/army caps). lateAt is
 * crossed comfortably before durationSec so the late-phase window
 * has a usable midpoint for the unit_timeline signature picker.
 *
 * @param {{ units: Record<string, number>, duration?: number }} opts
 */
function makeMacroLate(opts) {
  const duration = opts.duration || 600;
  const bases = [
    { name: "Nexus", born_time: 0, died_time: duration },
    { name: "Nexus", born_time: 100, died_time: duration },
    { name: "Nexus", born_time: 200, died_time: duration },
  ];
  const productionBuildings = [
    { name: "CyberneticsCore", born_time: 80, died_time: duration },
    { name: "TwilightCouncil", born_time: 150, died_time: duration },
    { name: "RoboticsFacility", born_time: 200, died_time: duration },
    { name: "Stargate", born_time: 250, died_time: duration },
    { name: "RoboticsBay", born_time: 280, died_time: duration },
  ];
  const stats = [];
  for (let t = 0; t <= duration; t += 10) {
    stats.push({
      time: t,
      food_workers: Math.min(20 + t / 8, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 12, 5000),
    });
  }
  const timeline = [];
  for (let t = 0; t <= duration; t += 30) {
    timeline.push({ time: t, my: { ...opts.units }, opp: {} });
  }
  return {
    bases,
    production_buildings: productionBuildings,
    stats_events: stats,
    unit_timeline: timeline,
  };
}

/**
 * Macro shape that classifies into "mid" — 2 bases, 2 tech
 * buildings, stats capped well below late-window thresholds.
 *
 * @param {{ duration?: number }} [opts]
 */
function makeMacroMid(opts) {
  const duration = (opts && opts.duration) || 600;
  const bases = [
    { name: "Nexus", born_time: 0, died_time: duration },
    { name: "Nexus", born_time: 100, died_time: duration },
  ];
  const productionBuildings = [
    { name: "CyberneticsCore", born_time: 80, died_time: duration },
    { name: "TwilightCouncil", born_time: 150, died_time: duration },
  ];
  const stats = [];
  for (let t = 0; t <= duration; t += 10) {
    stats.push({
      time: t,
      food_workers: Math.min(20 + t / 10, 50),
      food_used: Math.min(12 + t / 8, 80),
      army_value: Math.min(t * 8, 3000),
    });
  }
  return {
    bases,
    production_buildings: productionBuildings,
    stats_events: stats,
    unit_timeline: [],
  };
}

function makeLateGame({ gameId, result, strategy, units }) {
  return {
    gameId,
    myBuild: "Stargate Phoenix",
    myRace: "Protoss",
    oppRace: "Zerg",
    durationSec: 600,
    result,
    opponent: strategy ? { strategy } : {},
    macroBreakdown: makeMacroLate({ units }),
    events: [],
  };
}

function makeMidGame({ gameId, result, strategy }) {
  return {
    gameId,
    myBuild: "Stargate Phoenix",
    myRace: "Protoss",
    oppRace: "Zerg",
    durationSec: 600,
    result,
    opponent: strategy ? { strategy } : {},
    macroBreakdown: makeMacroMid(),
    events: [],
  };
}

describe("computeTransitions — empty input", () => {
  test("returns empty nodes/edges + zero rare counts", () => {
    const out = computeTransitions([]);
    expect(out).toEqual({
      nodes: [],
      edges: [],
      rare: { collapsedNodes: 0, collapsedEdges: 0 },
    });
  });
});

// Three games funnel through (Hydra → late → Stalker|Immortal|Carrier),
// one funnels through a rare (Roach → late → Zealot|Adept|Sentry), and
// one ends in mid — the mid game contributes zero col 3 traffic and the
// rare path is collapsed into "Other" siblings at columns 1 / 2 / 3.
const FIVE_GAME_HYDRA_UNITS = {
  Stalker: 5, Immortal: 3, Carrier: 2, Probe: 60,
};
const FIVE_GAME_FIXTURE = [
  makeLateGame({
    gameId: "g1",
    result: "Victory",
    strategy: "Zerg - Hydra Comp",
    units: FIVE_GAME_HYDRA_UNITS,
  }),
  makeLateGame({
    gameId: "g2",
    result: "Victory",
    strategy: "Zerg - Hydra Comp",
    units: FIVE_GAME_HYDRA_UNITS,
  }),
  makeLateGame({
    gameId: "g3",
    result: "Defeat",
    strategy: "Zerg - Hydra Comp",
    units: FIVE_GAME_HYDRA_UNITS,
  }),
  makeLateGame({
    gameId: "g4",
    result: "Victory",
    strategy: "Zerg - Roach All-In",
    units: { Zealot: 6, Adept: 4, Sentry: 2, Probe: 50 },
  }),
  makeMidGame({
    gameId: "g5",
    result: "Defeat",
    strategy: "Zerg - Hydra Comp",
  }),
];

describe("computeTransitions — 5-game synthetic routing", () => {
  const games = FIVE_GAME_FIXTURE;

  test("col 0 carries the build label and total game count", () => {
    const out = computeTransitions(games);
    const build = out.nodes.find((n) => n.column === 0);
    expect(build).toBeDefined();
    expect(build.id).toBe("build");
    expect(build.label).toBe("Stargate Phoenix");
    expect(build.kind).toBe("build");
    expect(build.games).toBe(5);
  });

  test("col 1 splits common strategy from a folded Other sibling", () => {
    const out = computeTransitions(games);
    const col1 = out.nodes.filter((n) => n.column === 1);
    const hydra = col1.find((n) => n.label === "Zerg - Hydra Comp");
    const other = col1.find((n) => n.label === "Other");
    expect(hydra).toBeDefined();
    expect(hydra.games).toBe(4);
    expect(hydra.wins).toBe(2);
    expect(hydra.losses).toBe(2);
    expect(hydra.kind).toBe("oppStrategy");
    // "Zerg - Roach All-In" carried only 1 game → folded into Other.
    expect(col1.find((n) => n.label === "Zerg - Roach All-In"))
      .toBeUndefined();
    expect(other).toBeDefined();
    expect(other.games).toBe(1);
    expect(other.kind).toBe("oppStrategy");
  });

  test("col 2 splits the dominant final phase from rare phases", () => {
    const out = computeTransitions(games);
    const col2 = out.nodes.filter((n) => n.column === 2);
    const late = col2.find((n) => n.label === "late");
    const other = col2.find((n) => n.label === "Other");
    expect(late).toBeDefined();
    expect(late.games).toBe(4);
    expect(late.kind).toBe("finalPhase");
    // The lone "mid" finalPhase folds into Other at col 2.
    expect(col2.find((n) => n.label === "mid")).toBeUndefined();
    expect(other).toBeDefined();
    expect(other.games).toBe(1);
  });

  test("col 3 only contains late-comp nodes (mid game has no col 3 edge)", () => {
    const out = computeTransitions(games);
    const col3 = out.nodes.filter((n) => n.column === 3);
    // The three Hydra games share the same late composition. The
    // Roach game's late comp is rare → folded into Other. The mid
    // game contributes nothing to col 3.
    const dominant = col3.find((n) => n.kind === "lateComp" && n.label !== "Other");
    expect(dominant).toBeDefined();
    expect(dominant.label).toBe("Stalker|Immortal|Carrier");
    expect(dominant.games).toBe(3);
    expect(dominant.iconTokens).toEqual(["Stalker", "Immortal", "Carrier"]);
    const other = col3.find((n) => n.label === "Other");
    expect(other).toBeDefined();
    expect(other.games).toBe(1);
    expect(other.iconTokens).toBeUndefined();
  });

  test("edges trace the dominant build → strategy → late → comp path", () => {
    const out = computeTransitions(games);
    const findEdge = (from, to) =>
      out.edges.find((e) => e.from === from && e.to === to);

    const e1 = findEdge("build", "strat:Zerg - Hydra Comp");
    expect(e1).toBeDefined();
    expect(e1.games).toBe(4);
    expect(e1.wins).toBe(2);
    expect(e1.losses).toBe(2);
    expect(e1.winRate).toBe(0.5);

    const e2 = findEdge("strat:Zerg - Hydra Comp", "phase:late");
    expect(e2).toBeDefined();
    expect(e2.games).toBe(3);
    expect(e2.wins).toBe(2);
    expect(e2.losses).toBe(1);

    const e3 = findEdge("phase:late", "comp:Stalker|Immortal|Carrier");
    expect(e3).toBeDefined();
    expect(e3.games).toBe(3);
  });

  test("does not emit any col-3 edge from a non-late col-2 node", () => {
    const out = computeTransitions(games);
    const col3Ids = new Set(
      out.nodes.filter((n) => n.column === 3).map((n) => n.id),
    );
    // The mid game must NOT have produced an edge into col 3 — i.e.,
    // no edge starts at "phase:mid" or the col-2 Other sibling and
    // ends at a col-3 node.
    const offending = out.edges.filter((e) => {
      if (e.from !== "phase:mid" && e.from !== "other:2") return false;
      return col3Ids.has(e.to);
    });
    expect(offending).toEqual([]);
    // Belt-and-braces: every col-3 edge must come from phase:late.
    for (const e of out.edges) {
      if (col3Ids.has(e.to)) expect(e.from).toBe("phase:late");
    }
  });

  test("reports rare-collapse counts (3 nodes, ≥1 edges)", () => {
    const out = computeTransitions(games);
    // The three rare nodes: Strat B (col 1), mid (col 2), Y comp
    // (col 3). All have games < 2 before folding.
    expect(out.rare.collapsedNodes).toBe(3);
    // After folding rare nodes into Other siblings, every cross-
    // column edge that touches a freshly-created Other still has
    // games < 2 (only one rare path fed it), so each of those edges
    // gets dropped — four such edges in this fixture.
    expect(out.rare.collapsedEdges).toBeGreaterThanOrEqual(1);
  });
});

describe("computeTransitions — missing opponent.strategy", () => {
  test("routes through an 'Unknown' col-1 node", () => {
    // Two games with no strategy set so the Unknown node is common
    // (won't be folded into Other).
    const games = [
      makeLateGame({
        gameId: "g1",
        result: "Victory",
        strategy: null,
        units: { Stalker: 4, Immortal: 2, Carrier: 1 },
      }),
      makeLateGame({
        gameId: "g2",
        result: "Defeat",
        strategy: null,
        units: { Stalker: 4, Immortal: 2, Carrier: 1 },
      }),
    ];
    const out = computeTransitions(games);
    const unknown = out.nodes.find((n) => n.column === 1);
    expect(unknown).toBeDefined();
    expect(unknown.label).toBe("Unknown");
    expect(unknown.id).toBe("strat:Unknown");
    expect(unknown.games).toBe(2);
    const edge = out.edges.find(
      (e) => e.from === "build" && e.to === "strat:Unknown",
    );
    expect(edge).toBeDefined();
    expect(edge.games).toBe(2);
  });
});

describe("computeTransitions — PvT-WIN fixture snapshot (Prompt 1 anchor)", () => {
  // The PvT-WIN fixture (``pvt_20m_macro_win.json``) lives outside
  // the repo for now — see ``scripts/dump-macro-fixture.py``
  // referenced in apps/api/__tests__/phaseClassifier.test.js. When
  // it lands, flip ``test.skip`` to ``test``: the late-comp key is
  // the calibration anchor for the compositions service and the
  // Sankey path through it should be deterministic.
  //
  // The fixture is replayed multiple times so the col-3 lateComp
  // node clears the rare-collapse threshold — without that, a
  // single-game snapshot would always fold every col-1..3 node
  // into Other.
  test.skip("traces build → Unknown → late → Carrier|Immortal|Stalker", () => {
    const fx = loadFixture("pvt_20m_macro_win.json");
    const base = {
      myBuild: "TIIIII",
      myRace: fx.race,
      oppRace: "Terran",
      durationSec: fx.durationSec,
      result: "Victory",
      // strategy intentionally omitted so the col-1 node is "Unknown".
      macroBreakdown: fx.macroBreakdown,
      events: [],
    };
    const games = [
      { ...base, gameId: "pvt_20m_macro_win_a" },
      { ...base, gameId: "pvt_20m_macro_win_b" },
      { ...base, gameId: "pvt_20m_macro_win_c" },
    ];
    const out = computeTransitions(games);
    const findEdge = (from, to) =>
      out.edges.find((e) => e.from === from && e.to === to);

    expect(findEdge("build", "strat:Unknown")).toBeDefined();
    expect(findEdge("strat:Unknown", "phase:late")).toBeDefined();
    expect(findEdge("phase:late", "comp:Carrier|Immortal|Stalker"))
      .toBeDefined();
    const lateComp = out.nodes.find(
      (n) => n.column === 3 && n.label === "Carrier|Immortal|Stalker",
    );
    expect(lateComp).toBeDefined();
    expect(lateComp.iconTokens).toEqual(["Carrier", "Immortal", "Stalker"]);
  });
});
