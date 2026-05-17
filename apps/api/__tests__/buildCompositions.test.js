// @ts-nocheck
"use strict";

const fs = require("fs");
const path = require("path");

const {
  computeCompositions,
  PHASE_WINDOWS,
  WORKER_SKIP,
} = require("../src/services/buildCompositions");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "phase");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

/**
 * Build a minimal macroBreakdown that drives the phaseClassifier to
 * cross into "mid" well before the end of the game, so the "mid" phase
 * window is non-empty and the unit_timeline midpoint lookup is the
 * one this test exercises. Stats-events climb fast enough on their
 * own — the bases / production_buildings are only there so the
 * classifier doesn't bail early.
 *
 * @param {{
 *   myUnitsAtMid: Record<string, number>,
 *   buildLog?: string[],
 * }} opts
 */
function makeMacroBreakdown(opts) {
  const duration = 600;
  const baseRow = { name: "Nexus", born_time: 0, died_time: duration };
  const baseRow2 = { name: "Nexus", born_time: 100, died_time: duration };
  // Stats climb quickly so the score crosses into mid (>=40) around
  // t=200-300s. The exact crossing isn't asserted — the test only
  // needs midAt <= 300 so the mid-phase midpoint stays inside the
  // unit_timeline range we hand-craft below.
  const stats = [];
  for (let t = 0; t <= duration; t += 10) {
    stats.push({
      time: t,
      food_workers: Math.min(12 + t / 5, 70),
      food_used: Math.min(12 + t / 4, 180),
      army_value: Math.min(t * 8, 5000),
    });
  }
  // Provide a unit_timeline sample at every 30s. The mid window will
  // straddle [midAt, durationSec]; we plant the requested composition
  // densely so whichever row is nearest the midpoint carries it.
  const timeline = [];
  for (let t = 0; t <= duration; t += 30) {
    timeline.push({ time: t, my: { ...opts.myUnitsAtMid }, opp: {} });
  }
  return {
    bases: [baseRow, baseRow2],
    production_buildings: [
      { name: "CyberneticsCore", born_time: 80, died_time: duration },
      { name: "TwilightCouncil", born_time: 180, died_time: duration },
      { name: "RoboticsFacility", born_time: 200, died_time: duration },
      { name: "Stargate", born_time: 250, died_time: duration },
    ],
    stats_events: stats,
    unit_timeline: timeline,
  };
}

/**
 * Stitch a game record matching the listForRulePreview output shape
 * the compositions service consumes.
 *
 * @param {{
 *   gameId: string,
 *   result: string,
 *   myUnitsAtMid: Record<string, number>,
 *   events?: Array<object>,
 * }} opts
 */
function makeGame(opts) {
  return {
    gameId: opts.gameId,
    myRace: "Protoss",
    oppRace: "Zerg",
    durationSec: 600,
    result: opts.result,
    opponent: { strategy: "Zerg - Hydra Comp" },
    macroBreakdown: makeMacroBreakdown({ myUnitsAtMid: opts.myUnitsAtMid }),
    events: Array.isArray(opts.events) ? opts.events : [],
    oppEvents: [],
  };
}

describe("buildCompositions — exports", () => {
  test("re-exports PHASE_WINDOWS and WORKER_SKIP for downstream callers", () => {
    expect(typeof PHASE_WINDOWS).toBe("object");
    expect(PHASE_WINDOWS.early).toBeDefined();
    expect(PHASE_WINDOWS.late).toBeDefined();
    // The skip set is the canonical filter for the signature picker.
    // If it shrinks, downstream signature snapshots will shift; keep
    // these spot-checks as a tripwire.
    expect(WORKER_SKIP.has("Drone")).toBe(true);
    expect(WORKER_SKIP.has("SCV")).toBe(true);
    expect(WORKER_SKIP.has("Probe")).toBe(true);
    expect(WORKER_SKIP.has("MULE")).toBe(true);
    expect(WORKER_SKIP.has("Larva")).toBe(true);
    expect(WORKER_SKIP.has("Overlord")).toBe(true);
    expect(WORKER_SKIP.has("Pylon")).toBe(true);
    expect(WORKER_SKIP.has("SupplyDepot")).toBe(true);
    expect(WORKER_SKIP.has("Extractor")).toBe(true);
    expect(WORKER_SKIP.has("Refinery")).toBe(true);
    // Combat units must not be in the skip set — would corrupt the
    // top-3 picker into selecting workers as a "signature".
    expect(WORKER_SKIP.has("Stalker")).toBe(false);
    expect(WORKER_SKIP.has("Immortal")).toBe(false);
  });
});

describe("buildCompositions — empty input", () => {
  test("returns zero-filled shape", () => {
    const out = computeCompositions([]);
    expect(out.sampleSize).toEqual({
      early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
    });
    expect(out.finalPhaseDistribution).toEqual({
      early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
    });
    expect(out.flags).toEqual([]);
    // Every phase carries the same row-shape contract regardless of
    // whether it has data — keeps the downstream UI free of
    // existence checks.
    for (const phase of ["early", "earlyMid", "mid", "midLate", "late"]) {
      expect(out.perPhase[phase]).toEqual({
        signatures: [], tech: [], upgrades: [],
      });
    }
  });
});

describe("buildCompositions — clustering across games", () => {
  // Hand-craft three games: two with the same mid composition
  // (Stalker, Phoenix, Immortal) and one different (Zealot, Adept,
  // Sentry). Verifies the cluster bucketing, sample counts, win-rate
  // and the newest-first sampleGameIds order.
  test("groups identical mid signatures and orders sampleGameIds newest-first", () => {
    // Input order is newest-first, matching the listForRulePreview
    // contract (sorted by date desc).
    const games = [
      makeGame({
        gameId: "g1",
        result: "Victory",
        myUnitsAtMid: { Stalker: 4, Phoenix: 3, Immortal: 2, Probe: 60 },
      }),
      makeGame({
        gameId: "g2",
        result: "Victory",
        myUnitsAtMid: { Stalker: 5, Phoenix: 2, Immortal: 1, Probe: 55 },
      }),
      makeGame({
        gameId: "g3",
        result: "Defeat",
        myUnitsAtMid: { Zealot: 6, Adept: 4, Sentry: 2, Probe: 50 },
      }),
    ];
    const out = computeCompositions(games);
    const midSigs = out.perPhase.mid.signatures;
    expect(midSigs.length).toBe(2);

    const sigBlue = midSigs.find((s) => s.key === "Stalker|Phoenix|Immortal");
    const sigRed = midSigs.find((s) => s.key === "Zealot|Adept|Sentry");
    expect(sigBlue).toBeDefined();
    expect(sigRed).toBeDefined();

    // The two Victory games clustered into one signature.
    expect(sigBlue.sampleCount).toBe(2);
    expect(sigBlue.wins).toBe(2);
    expect(sigBlue.losses).toBe(0);
    expect(sigBlue.winRate).toBe(1);
    // sampleGameIds preserve the input (newest-first) order.
    expect(sigBlue.sampleGameIds).toEqual(["g1", "g2"]);
    // The top-3 units carry their counts taken from the first game's
    // sample row — the picker's job is to deterministically order
    // them; the count is the row's count, not the cluster's average.
    expect(sigBlue.units.map((u) => u.token)).toEqual([
      "Stalker", "Phoenix", "Immortal",
    ]);

    expect(sigRed.sampleCount).toBe(1);
    expect(sigRed.wins).toBe(0);
    expect(sigRed.losses).toBe(1);
    expect(sigRed.winRate).toBe(0);
    expect(sigRed.sampleGameIds).toEqual(["g3"]);

    // sampleSize for the mid phase counts every game whose finalPhase
    // is >= mid. All three games are constructed to climb that far.
    expect(out.sampleSize.mid).toBe(3);
  });

  test("strips workers/larva/overlords/MULE/pylon/depot/gas from the signature", () => {
    const games = [
      makeGame({
        gameId: "g1",
        result: "Victory",
        myUnitsAtMid: {
          Drone: 70, SCV: 0, Probe: 0, MULE: 4, Larva: 3,
          Overlord: 8, Pylon: 12, SupplyDepot: 10,
          Extractor: 4, Refinery: 4,
          // Only one real fighting unit — signature should reflect
          // exactly that.
          Stalker: 5,
        },
      }),
    ];
    const out = computeCompositions(games);
    const sig = out.perPhase.mid.signatures[0];
    expect(sig.key).toBe("Stalker");
    expect(sig.units.map((u) => u.token)).toEqual(["Stalker"]);
  });
});

describe("buildCompositions — flags", () => {
  test("'early_pressure' fires when >60% of games end before mid", () => {
    // Use macroBreakdowns whose score never climbs — empty bases /
    // production_buildings / stats means the score stays at 0, so
    // finalPhase resolves to "early".
    const earlyGame = (gid) => ({
      gameId: gid,
      myRace: "Protoss",
      durationSec: 120,
      result: "Defeat",
      opponent: { strategy: "X" },
      macroBreakdown: {
        bases: [], production_buildings: [], stats_events: [],
        unit_timeline: [],
      },
      events: [],
    });
    const out = computeCompositions([
      earlyGame("g1"), earlyGame("g2"), earlyGame("g3"),
    ]);
    expect(out.flags).toContain("early_pressure");
    // With every game ending in "early", that single bucket holds
    // 100% of games — peak > 0.5, so "high_variance" does NOT fire.
    expect(out.flags).not.toContain("high_variance");
  });
});

describe("buildCompositions — PvT-WIN snapshot (Prompt 1 fixture)", () => {
  // The fixture this anchors on (``pvt_20m_macro_win.json``) is the
  // TIIIII 20-minute PvT win called out in the phaseClassifier
  // calibration spec — it lives outside the repo. When the replay
  // fixture lands (see scripts/dump-macro-fixture.py in
  // ``apps/api/__tests__/phaseClassifier.test.js``), flip this
  // ``test.skip`` to ``test`` and the assertions should hold
  // without modification: the mid signature is grounded in the
  // calibration data and was selected to be a stable regression
  // anchor for the compositions service.
  test.skip("mid signature is Stalker|Phoenix|Immortal, late is Carrier|Immortal|Stalker", () => {
    const fx = loadFixture("pvt_20m_macro_win.json");
    const game = {
      gameId: "pvt_20m_macro_win",
      myRace: fx.race,
      oppRace: "Terran",
      durationSec: fx.durationSec,
      result: "Victory",
      opponent: { strategy: "Terran - Standard Bio Tank" },
      macroBreakdown: fx.macroBreakdown,
      // The fixture currently dumps macroBreakdown only — events
      // would come from the buildLog the agent uploads alongside.
      // Tech / upgrade rollups aren't part of the signature
      // assertions below, so the empty array is sufficient.
      events: [],
    };
    const out = computeCompositions([game]);
    const midSig = out.perPhase.mid.signatures[0];
    expect(midSig.key).toBe("Stalker|Phoenix|Immortal");
    expect(midSig.units.map((u) => u.token)).toEqual([
      "Stalker", "Phoenix", "Immortal",
    ]);
    const lateSig = out.perPhase.late.signatures[0];
    expect(lateSig.key).toBe("Carrier|Immortal|Stalker");
    expect(lateSig.units.map((u) => u.token)).toEqual([
      "Carrier", "Immortal", "Stalker",
    ]);
  });
});
