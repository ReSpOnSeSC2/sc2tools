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

describe("buildCompositions — peak-alive sampling across phase window", () => {
  /**
   * Build a fixture where the player's army at the mid-phase midpoint
   * is small (post-engagement low) but the peak alive during the
   * phase window is much larger. The peak-alive sampler must surface
   * the peak count, not the midpoint dip — that's the same fix the
   * scouting envelope ships, applied here to the Strategies tab.
   *
   * @param {Record<string, number>} peakUnits the army roster the
   *   timeline carries at its busiest tick inside the mid window
   * @param {Record<string, number>} dipUnits the army at the exact
   *   midpoint tick (typically lower than peak)
   */
  function makeMidPeakFixture(peakUnits, dipUnits) {
    const duration = 600;
    const stats = [];
    for (let t = 0; t <= duration; t += 10) {
      stats.push({
        time: t, food_workers: Math.min(12 + t / 5, 70),
        food_used: Math.min(12 + t / 4, 180), army_value: Math.min(t * 8, 5000),
      });
    }
    // Timeline samples: dense roster at the busy ticks (peak), a
    // sparse row at midpoint (post-engagement dip). The exact
    // midpoint of the mid window depends on the classifier, but the
    // stats curve pushes midAt to roughly 200s and lateAt past
    // duration → mid window is roughly [200, 600] → midpoint ~400s.
    const timeline = [
      { time: 0, my: { Probe: 12 }, opp: {} },
      { time: 250, my: { Probe: 50, ...peakUnits }, opp: {} },
      { time: 350, my: { Probe: 50, ...peakUnits }, opp: {} },
      // Midpoint sample carries only the dip roster — sparse, low count.
      { time: 400, my: { Probe: 50, ...dipUnits }, opp: {} },
      { time: 450, my: { Probe: 50, ...peakUnits }, opp: {} },
      { time: 500, my: { Probe: 50, ...peakUnits }, opp: {} },
    ];
    return {
      bases: [{ name: "Nexus", born_time: 0, died_time: duration },
              { name: "Nexus", born_time: 100, died_time: duration }],
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

  test("uses PEAK alive across the window, not the midpoint sample", () => {
    // Player fielded 8 Carriers at peak, then lost 7 in an engagement
    // landing at the midpoint sample (1 Carrier alive). The signature
    // must reflect "8 Carriers were on the field during mid" — the
    // headline read the streamer expects — not the trailing 1.
    const macroBreakdown = makeMidPeakFixture(
      { Carrier: 8, Tempest: 6, VoidRay: 4 },
      { Carrier: 1 },
    );
    const result = computeCompositions([{
      gameId: "g_peak", myRace: "Protoss", oppRace: "Zerg",
      durationSec: 600, result: "Victory",
      opponent: { strategy: "Zerg - Hydra Comp" },
      macroBreakdown, events: [], oppEvents: [],
    }]);
    expect(result.perPhase.mid.signatures.length).toBeGreaterThan(0);
    const sig = result.perPhase.mid.signatures[0];
    const carrier = sig.units.find((u) => u.token === "Carrier");
    expect(carrier).toBeDefined();
    expect(carrier.count).toBeGreaterThanOrEqual(8); // peak, not dip-1
  });

  test("sums sc2reader variants on the same tick (Roach + RoachBurrowed)", () => {
    // The signature picker now canonicalises variants — a 14 Roach
    // + 6 RoachBurrowed army reads as Roach 20, never as two
    // separate signature entries that would split the count and
    // double-stack the icon.
    const macroBreakdown = makeMidPeakFixture(
      { Roach: 14, RoachBurrowed: 6 },
      { Roach: 14, RoachBurrowed: 6 },
    );
    const result = computeCompositions([{
      gameId: "g_burrow", myRace: "Protoss", oppRace: "Zerg",
      durationSec: 600, result: "Victory",
      opponent: { strategy: "Zerg - Roach Comp" },
      macroBreakdown, events: [], oppEvents: [],
    }]);
    const sig = result.perPhase.mid.signatures[0];
    const roach = sig.units.find((u) => u.token === "Roach");
    const rawBurrowed = sig.units.find((u) => u.token === "RoachBurrowed");
    expect(roach).toBeDefined();
    expect(roach.count).toBe(20);
    expect(rawBurrowed).toBeUndefined();
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

describe("buildCompositions — perspective='opponent'", () => {
  /**
   * Build a game whose own-side macroBreakdown is light and whose
   * opp_* fields carry the heavy late-game signal. The classifier on
   * the user's side would put this game in "early"; flipped to
   * "opponent" it has to land in "mid"/"late" because the opp_*
   * fields are doing the work.
   *
   * @param {{ gameId: string, oppUnitsAtMid: Record<string, number> }} opts
   */
  function makeOppPerspectiveGame(opts) {
    const duration = 600;
    const oppBases = [
      { name: "CommandCenter", born_time: 0, died_time: duration },
      { name: "CommandCenter", born_time: 100, died_time: duration },
      { name: "CommandCenter", born_time: 220, died_time: duration },
    ];
    const oppProduction = [
      { name: "Factory", born_time: 90, died_time: duration },
      { name: "Starport", born_time: 200, died_time: duration },
      { name: "Armory", born_time: 260, died_time: duration },
      { name: "FusionCore", born_time: 320, died_time: duration },
    ];
    const oppStats = [];
    for (let t = 0; t <= duration; t += 10) {
      oppStats.push({
        time: t,
        food_workers: Math.min(20 + t / 8, 70),
        food_used: Math.min(12 + t / 4, 180),
        army_value: Math.min(t * 12, 5000),
      });
    }
    const timeline = [];
    for (let t = 0; t <= duration; t += 30) {
      timeline.push({
        time: t,
        my: { Probe: 50 },
        opp: { ...opts.oppUnitsAtMid },
      });
    }
    return {
      gameId: opts.gameId,
      myRace: "Protoss",
      oppRace: "Terran",
      durationSec: duration,
      result: "Defeat",
      opponent: { strategy: "Terran - Mech" },
      macroBreakdown: {
        // The user's side is intentionally empty — without the
        // perspective flip the classifier finds nothing to score
        // and the game lands in "early".
        bases: [],
        production_buildings: [],
        stats_events: [],
        opp_bases: oppBases,
        opp_production_buildings: oppProduction,
        opp_stats_events: oppStats,
        unit_timeline: timeline,
      },
      events: [],
      oppEvents: [],
    };
  }

  test("scores phases off opp_* fields and signs the opponent's units", () => {
    const games = [
      makeOppPerspectiveGame({
        gameId: "g1",
        oppUnitsAtMid: { SiegeTank: 6, Marauder: 4, Marine: 8, SCV: 60 },
      }),
      makeOppPerspectiveGame({
        gameId: "g2",
        oppUnitsAtMid: { SiegeTank: 7, Marauder: 3, Marine: 9, SCV: 55 },
      }),
    ];
    const own = computeCompositions(games, { perspective: "you" });
    const flipped = computeCompositions(games, { perspective: "opponent" });

    // Own-side perspective: the user has no bases / no production /
    // no stats, so finalPhase clamps to "early" and the mid window
    // has zero samples.
    expect(own.finalPhaseDistribution.early).toBe(2);
    expect(own.sampleSize.mid).toBe(0);
    // Flipped to opponent: the opp_* fields drive the score so the
    // classifier passes through mid and into mid/late or late.
    expect(flipped.sampleSize.mid).toBe(2);
    // The mid-phase signature is read off ``unit_timeline[*].opp``
    // and contains the opponent's units, not the user's worker
    // count.
    const sig = flipped.perPhase.mid.signatures[0];
    expect(sig).toBeDefined();
    expect(sig.units.map((u) => u.token)).toContain("SiegeTank");
    // SCV is in the worker-skip set so it never appears in the
    // signature, no matter which side carries it.
    expect(sig.units.map((u) => u.token)).not.toContain("SCV");
  });

  test("mirrors the W/L record to the opponent's side", () => {
    // ``game.result`` is recorded from the USER's side; both fixture
    // games are user Defeats. From the opponent's perspective those
    // are wins, so the flipped signature must read 2–0 (winRate 1) —
    // NOT the user's verbatim 0–2. This is the regression guard for
    // the comparison view bug where "what they typically do" reported
    // the user's win rate, making both columns show an identical
    // (impossible) record.
    const games = [
      makeOppPerspectiveGame({
        gameId: "g1",
        oppUnitsAtMid: { SiegeTank: 6, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g2",
        oppUnitsAtMid: { SiegeTank: 7, Marauder: 3, Marine: 9 },
      }),
    ];
    const flipped = computeCompositions(games, { perspective: "opponent" });
    const sig = flipped.perPhase.mid.signatures[0];
    expect(sig).toBeDefined();
    expect(sig.wins).toBe(2);
    expect(sig.losses).toBe(0);
    expect(sig.winRate).toBe(1);
  });

  test("user-perspective record is the user's verbatim W/L", () => {
    // Companion to the flip guard above: scored from the user's side
    // the same fixtures (user Defeats) must read as the user's losses.
    // The user side carries real fighting units so an own-perspective
    // signature actually forms at the mid phase.
    const game = makeGame({
      gameId: "g1",
      result: "Defeat",
      myUnitsAtMid: { Stalker: 5, Immortal: 2, Phoenix: 3, Probe: 60 },
    });
    const own = computeCompositions([game], { perspective: "you" });
    const sig = own.perPhase.mid.signatures[0];
    expect(sig).toBeDefined();
    expect(sig.wins).toBe(0);
    expect(sig.losses).toBe(1);
    expect(sig.winRate).toBe(0);
  });

  test("returns empty + 'opp_signals_sparse' when >50% of games have no opp_stats_events", () => {
    // 3 games, 2 of which carry no opp_stats_events (the sc2reader
    // Zerg tracker quirk). The empty-fallback fires at 67% missing,
    // which is comfortably over the 50% threshold.
    const games = [
      makeOppPerspectiveGame({
        gameId: "g1",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g2",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g3",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
    ];
    games[1].macroBreakdown.opp_stats_events = [];
    games[2].macroBreakdown.opp_stats_events = [];

    const out = computeCompositions(games, { perspective: "opponent" });
    expect(out.flags).toContain("opp_signals_sparse");
    expect(out.sampleSize.mid).toBe(0);
    expect(out.sampleSize.late).toBe(0);
    expect(out.perPhase.mid.signatures).toEqual([]);
  });

  test("still draws when exactly half the games carry opp_stats_events", () => {
    // 2 of 4 missing = 50% which is NOT strictly > 50%, so the
    // gate does not fire and the picker still produces a signature.
    const games = [
      makeOppPerspectiveGame({
        gameId: "g1",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g2",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g3",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
      makeOppPerspectiveGame({
        gameId: "g4",
        oppUnitsAtMid: { SiegeTank: 5, Marauder: 4, Marine: 8 },
      }),
    ];
    games[2].macroBreakdown.opp_stats_events = [];
    games[3].macroBreakdown.opp_stats_events = [];

    const out = computeCompositions(games, { perspective: "opponent" });
    expect(out.flags).not.toContain("opp_signals_sparse");
    expect(out.sampleSize.mid).toBeGreaterThan(0);
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

  // Opp-perspective companion. The PvT-WIN fixture's Terran side
  // arrives at mech in the late window — once the perspective flip
  // and ``unit_timeline[*].opp`` reader land, this assertion
  // re-grounds the snapshot on the opponent's late composition,
  // which is exactly what the StrategiesTabBuildVs "what they
  // typically do" column renders. Same skip-until-fixture pattern
  // as the existing one above.
  test.skip("opp-perspective late composition contains SiegeTank", () => {
    const fx = loadFixture("pvt_20m_macro_win.json");
    const game = {
      gameId: "pvt_20m_macro_win",
      myRace: fx.race,
      oppRace: "Terran",
      durationSec: fx.durationSec,
      result: "Victory",
      opponent: { strategy: "Terran - Standard Bio Tank" },
      macroBreakdown: fx.macroBreakdown,
      events: [],
    };
    const out = computeCompositions([game], { perspective: "opponent" });
    const lateSig = out.perPhase.late.signatures[0];
    expect(lateSig).toBeDefined();
    // The Terran side's late composition in this fixture is mech-
    // heavy. Asserting a substring (``SiegeTank``) rather than a
    // strict equality keeps the anchor stable across small
    // signature-set tweaks while still naming the trademark unit.
    expect(lateSig.units.map((u) => u.token)).toContain("SiegeTank");
  });
});
