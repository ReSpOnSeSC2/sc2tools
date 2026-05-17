"use strict";

const fs = require("fs");
const path = require("path");

const { classifyGame, PHASES, PHASE_LABELS } = require(
  "../src/services/phaseClassifier");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "phase");

function loadFixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("phaseClassifier — calibration snapshots", () => {
  // PvZ Adept timing (warpgate_adept_tracking, 7:50). The replay is
  // the only one bundled in the SC2Replay-Analyzer test fixtures, so
  // its JSON dump ships in this repo and the snapshot below is the
  // canonical regression anchor for the scoring formula.
  test("PvZ Adept timing (warpgate_adept_tracking) → finalPhase=mid", () => {
    const fx = loadFixture("warpgate_adept_tracking.json");
    const out = classifyGame(fx);
    expect(out.finalPhase).toBe("mid");
    // Crossings are in real LotV seconds after the 2026-05-17 timebase
    // migration (PR #309). Pre-migration values were earlyMidAt=250 /
    // midAt=410 on the broken 16fps scale.
    expect(out.crossings).toEqual({
      earlyMidAt: 184,
      midAt: 293,
      midLateAt: null,
      lateAt: null,
    });
  });

  // The remaining three calibration replays (TIIIII PvT 20m win,
  // TPeruano PvT 11m loss, JmaC PvZ 15m Skytoss) live outside the
  // repo. When the replay files are available, dump them with::
  //
  //   python3 scripts/dump-macro-fixture.py --replay PATH --player NAME \
  //     --out apps/api/__tests__/fixtures/phase/<slug>.json
  //
  // and flip the `test.skip` calls below to `test`. The expected
  // `finalPhase` per the calibration spec is encoded in each name.
  test.skip("PvT 20m macro WIN (TIIIII) → finalPhase=late", () => {
    const fx = loadFixture("pvt_20m_macro_win.json");
    const out = classifyGame(fx);
    expect(out.finalPhase).toBe("late");
    expect(out.crossings).toMatchSnapshot("crossings");
  });

  test.skip("PvT 11m cut-short LOSS (TPeruano) → finalPhase=midLate", () => {
    const fx = loadFixture("pvt_11m_cut_short_loss.json");
    const out = classifyGame(fx);
    expect(out.finalPhase).toBe("midLate");
    expect(out.crossings).toMatchSnapshot("crossings");
  });

  test.skip("PvZ 15m Skytoss WIN (JmaC) → finalPhase=late", () => {
    const fx = loadFixture("pvz_15m_skytoss_win.json");
    const out = classifyGame(fx);
    expect(out.finalPhase).toBe("late");
    expect(out.crossings).toMatchSnapshot("crossings");
  });
});

describe("phaseClassifier — unit behaviour", () => {
  test("empty inputs yield an Early game with no crossings", () => {
    const out = classifyGame({
      macroBreakdown: {},
      race: "Protoss",
      durationSec: 60,
    });
    expect(out.finalPhase).toBe("early");
    expect(out.crossings).toEqual({
      earlyMidAt: null,
      midAt: null,
      midLateAt: null,
      lateAt: null,
    });
    expect(out.deathEvents).toEqual([]);
    expect(out.trajectory.length).toBeGreaterThan(0);
  });

  test("omits worker/supply/army terms when stats_events is empty", () => {
    const out = classifyGame({
      macroBreakdown: {
        bases: [{ name: "Nexus", born_time: 0, died_time: 600 }],
        production_buildings: [],
        stats_events: [],
      },
      race: "Protoss",
      durationSec: 600,
    });
    const sample = out.trajectory.find((p) => p.t === 300);
    expect(sample.workers).toBeNull();
    expect(sample.supply).toBeNull();
    expect(sample.armyValue).toBeNull();
    // Single base @ eff=1 → 0 points (the tier table's "1 base = Early"
    // anchor), and with stats omitted the worker/supply/army terms
    // contribute nothing. Score is exactly 0.
    expect(sample.score).toBeCloseTo(0, 5);
  });

  test("records base/tech deaths but skips survivors", () => {
    const out = classifyGame({
      macroBreakdown: {
        bases: [
          { name: "Nexus", born_time: 0, died_time: 600 }, // survived
          { name: "Nexus", born_time: 100, died_time: 250 }, // died mid-game
        ],
        production_buildings: [
          // Tech that survived to game end (died_time == game end).
          { name: "CyberneticsCore", born_time: 90, died_time: 600 },
          // Tech that died mid-game.
          { name: "TwilightCouncil", born_time: 200, died_time: 400 },
        ],
        stats_events: [],
      },
      race: "Protoss",
      durationSec: 600,
    });
    expect(out.deathEvents).toEqual([
      { t: 250, kind: "base", name: "Nexus" },
      { t: 400, kind: "tech", name: "TwilightCouncil" },
    ]);
  });

  test("filters out bases born after durationSec", () => {
    // The extractor emits stragglers a few seconds past game_length;
    // those rows must not contribute to the score.
    const out = classifyGame({
      macroBreakdown: {
        bases: [
          { name: "Nexus", born_time: 0, died_time: 300 },
          { name: "Nexus", born_time: 700, died_time: 700 }, // ghost row
        ],
        production_buildings: [],
        stats_events: [],
      },
      race: "Protoss",
      durationSec: 300,
    });
    const lastSample = out.trajectory[out.trajectory.length - 1];
    // Only the first base counts — eff=1 sits at the tier table's
    // "Early" anchor (0 pts) and the stats-driven terms are zero.
    expect(lastSample.bases).toBe(1);
    expect(lastSample.score).toBeCloseTo(0, 5);
    expect(out.deathEvents).toEqual([]);
  });

  test("Zerg base-tier table is gentler than Protoss/Terran", () => {
    const macro = {
      bases: [
        // Three bases @ full ramp.
        { name: "Hatchery", born_time: 0, died_time: 600 },
        { name: "Hatchery", born_time: 0, died_time: 600 },
        { name: "Hatchery", born_time: 0, died_time: 600 },
      ],
      production_buildings: [],
      stats_events: [],
    };
    const protoss = classifyGame({
      macroBreakdown: { ...macro, bases: macro.bases.map(
        (b) => ({ ...b, name: "Nexus" })) },
      race: "Protoss",
      durationSec: 600,
    });
    const zerg = classifyGame({
      macroBreakdown: macro, race: "Zerg", durationSec: 600,
    });
    const pSample = protoss.trajectory.find((p) => p.t === 300);
    const zSample = zerg.trajectory.find((p) => p.t === 300);
    // 3 bases @ full ramp → Protoss tier 3 = 30, Zerg tier 3 = 25.
    expect(pSample.score).toBeCloseTo(30, 5);
    expect(zSample.score).toBeCloseTo(25, 5);
  });

  test("crossings advance monotonically", () => {
    const fx = loadFixture("warpgate_adept_tracking.json");
    const out = classifyGame(fx);
    const ordered = [
      out.crossings.earlyMidAt,
      out.crossings.midAt,
      out.crossings.midLateAt,
      out.crossings.lateAt,
    ];
    let prev = -Infinity;
    for (const t of ordered) {
      if (t === null) continue;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  test("omits opp base/tech fields when extractor didn't capture them", () => {
    const fx = loadFixture("warpgate_adept_tracking.json");
    const out = classifyGame(fx);
    expect(out.oppTrajectory.length).toBeGreaterThan(0);
    // Bundled fixture has opp_stats_events but no opp_bases / opp_production_buildings.
    const sample = out.oppTrajectory[0];
    expect(sample).not.toHaveProperty("bases");
    expect(sample).not.toHaveProperty("tech");
    expect(sample).toHaveProperty("workers");
    expect(sample).toHaveProperty("supply");
    expect(sample).toHaveProperty("armyValue");
  });

  test("PHASES and PHASE_LABELS line up", () => {
    expect(Object.keys(PHASES)).toEqual(Object.keys(PHASE_LABELS));
    expect(PHASES.early).toBe(0);
    expect(PHASES.late).toBe(80);
  });
});
