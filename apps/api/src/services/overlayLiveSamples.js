"use strict";

/**
 * Synthetic overlay payloads for the Settings → Overlay Test button.
 *
 * Lifted out of `overlayLive.js` so the production derivation logic
 * stays focused (and the file under the 800-line cap). The shape here
 * mirrors `apps/web/components/overlay/types.ts#LiveGamePayload` and
 * the renderers consume it through the same socket event the cloud
 * uses for real games — no production code reads from this file.
 */

/**
 * Build a synthetic full payload that lights up every widget. The
 * optional `widget` parameter narrows the payload to the keys that
 * single widget reads, which lets the per-widget Test button fire one
 * panel at a time.
 *
 * @param {string} [widget]
 * @returns {object}
 */
function buildSamplePayload(widget) {
  const FULL = {
    myRace: "Protoss",
    oppRace: "Zerg",
    oppName: "TestOpponent",
    map: "Goldenaura LE",
    matchup: "PvZ",
    result: "win",
    durationSec: 612,
    oppMmr: 4250,
    myMmr: 4310,
    mmrDelta: 22,
    headToHead: { wins: 4, losses: 2 },
    streak: { kind: "win", count: 3 },
    cheeseProbability: 0.65,
    predictedStrategies: [
      { name: "Pool first", weight: 0.45 },
      { name: "Hatch first", weight: 0.35 },
      { name: "Roach All-in", weight: 0.2 },
    ],
    topBuilds: [
      { name: "P - Stargate", total: 14, winRate: 0.71 },
      { name: "P - 4 Gate", total: 9, winRate: 0.55 },
    ],
    bestAnswer: { build: "P - Stargate", winRate: 0.78, total: 7 },
    favOpening: { name: "Pool first", share: 0.55, samples: 11 },
    scouting: [
      { label: "Pool first", tellAt: 90, confidence: 0.55 },
      { label: "Hatch first", tellAt: 75, confidence: 0.35 },
    ],
    recentGames: [
      {
        result: "Loss",
        lengthText: "3:47",
        map: "10000 Feet LE",
        myBuild: "PvZ - Macro Transition (Unclassified)",
        oppBuild: "Zerg - 8 Pool",
        oppRace: "Zerg",
      },
      {
        result: "Win",
        lengthText: "11:00",
        map: "Ruby Rock LE",
        myBuild: "PvZ - 3 Stargate Phoenix",
        oppBuild: "Zerg - 3 Base Macro (Hatch First)",
        oppRace: "Zerg",
      },
      {
        result: "Win",
        lengthText: "13:37",
        map: "Winter Madness LE",
        myBuild: "PvZ - 3 Stargate Phoenix",
        oppBuild: "Zerg - 3 Base Macro (Hatch First)",
        oppRace: "Zerg",
      },
      {
        result: "Loss",
        lengthText: "7:28",
        map: "Old Republic LE",
        myBuild: "PvZ - Macro Transition (Unclassified)",
        oppBuild: "Zerg - 3 Base Macro (Hatch First)",
        oppRace: "Zerg",
      },
      {
        result: "Win",
        lengthText: "11:04",
        map: "Tourmaline LE",
        myBuild: "PvZ - 3 Stargate Phoenix",
        oppBuild: "Zerg - 3 Base Macro (Hatch First)",
        oppRace: "Zerg",
      },
    ],
    session: {
      wins: 4,
      losses: 4,
      games: 8,
      mmrStart: 5320,
      mmrCurrent: 5343,
      region: "NA",
      sessionStartedAt: new Date(Date.now() - 27 * 60 * 1000).toISOString(),
      streak: { kind: "win", count: 2 },
    },
    rank: { league: "Diamond", tier: 1, mmr: 4310 },
    meta: {
      matchup: "PvZ",
      topBuilds: [
        { name: "Pool first", share: 0.55 },
        { name: "Hatch first", share: 0.35 },
      ],
    },
    rival: {
      name: "TestOpponent",
      headToHead: { wins: 4, losses: 2 },
      note: "Frequent matchup",
    },
    rematch: { isRematch: true, lastResult: "win" },
    // Realistic phase forecast — modal final phase Mid/Late with a
    // Skytoss composition, matching the calibration anchor from the
    // PvZ 15m Skytoss snapshot in
    // ``apps/api/__tests__/phaseClassifier.test.js``. Numbers are
    // shaped so the trajectory strip's crossings + final-phase
    // histogram both render through the compact path.
    opponentPhases: {
      typicalFinalPhase: "midLate",
      trajectory: {
        sampleSize: { early: 6, earlyMid: 6, mid: 6, midLate: 5, late: 2 },
        crossings: {
          earlyMidAt: 240,
          midAt: 420,
          midLateAt: 660,
          lateAt: 900,
        },
        finalPhaseDistribution: {
          early: 0,
          earlyMid: 0,
          mid: 1,
          midLate: 3,
          late: 2,
        },
        durationP95Sec: 1080,
      },
      typicalLateComp: {
        units: ["Carrier", "Tempest", "Mothership"],
        sampleCount: 4,
        winRate: 0.73,
      },
    },
  };
  if (!widget) return FULL;
  const keys = PER_WIDGET_KEYS[widget];
  if (!keys) return FULL;
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of [...SHARED_KEYS, ...keys]) {
    if (FULL[/** @type {keyof typeof FULL} */ (k)] !== undefined) {
      out[k] = FULL[/** @type {keyof typeof FULL} */ (k)];
    }
  }
  return out;
}

/**
 * Universal context fields. Always included on a per-widget probe so
 * the WidgetShell race-tinting and matchup label still resolve.
 */
const SHARED_KEYS = ["myRace", "oppRace", "matchup"];

/**
 * Per-widget filter — the renderer-relevant keys for each widget id.
 * Exported so external tooling (and tests) can introspect coverage.
 *
 * @type {Record<string, string[]>}
 */
const PER_WIDGET_KEYS = {
  "opponent": ["oppName", "oppMmr", "myMmr", "headToHead"],
  "match-result": ["result", "durationSec", "map"],
  "post-game": ["map", "durationSec", "result"],
  "mmr-delta": ["mmrDelta", "myMmr"],
  "streak": ["streak"],
  "cheese": ["cheeseProbability", "predictedStrategies"],
  "rematch": ["rematch"],
  "rival": ["rival"],
  "rank": ["rank"],
  "meta": ["meta"],
  "topbuilds": ["topBuilds"],
  "fav-opening": ["favOpening"],
  "best-answer": ["bestAnswer", "favOpening"],
  "scouting": [
    "scouting",
    "predictedStrategies",
    "oppName",
    "oppRace",
    "headToHead",
    "rival",
    "bestAnswer",
    "favOpening",
    "cheeseProbability",
    "recentGames",
    "opponentPhases",
  ],
  "session": ["session"],
  // Randomizer reads its build pool from overlay:config (not the live
  // payload). SHARED_KEYS already plumb matchup + races, which is all
  // the widget needs to spin during a Test fire.
  "randomizer": [],
  // Ghost Build reads its target from the dedicated Browser Source's
  // ?ghost= URL param. Registering the id is still essential: an unknown
  // id intentionally falls back to FULL, which made its per-widget Test
  // button fire every other overlay instead of the coach placement card.
  "ghost-build": [],
  // Multichat generates its own demo chat stream client-side when the
  // test-stamped payload lands — the payload only needs to exist and
  // carry ``isTest`` + ``testWidget``. Registering the id keeps the
  // per-widget Test from falling back to FULL and lighting up every
  // neighbouring panel.
  "multichat": [],
  // Stream Studio widgets — driven off the multichat studio state
  // (Stream Dock) in production. Each generates its own clearly-
  // labelled demo content client-side when the test-stamped payload
  // lands (see apps/web/lib/multichat/testStudio.ts), so the payload
  // only needs to exist and carry ``isTest`` + ``testWidget``.
  // Registered so an unknown id never falls back to FULL and lights
  // up every neighbouring panel.
  "chat-highlight": [],
  "chat-poll": [],
  "chat-alerts": [],
  "stream-goals": [],
  // Session recap renders the same session aggregate as the session
  // HUD, so its Test payload carries the sample ``session`` block —
  // the widget treats a test fire like a real recap trigger and only
  // falls back to its client-side demo block when the block is absent.
  "session-recap": ["session"],
  "stream-scene": [],
  "chat-oracle": [],
  "supporter-wall": [],
  "clip-flag": [],
  "lower-third": ["result", "map", "matchup", "mmrDelta", "headToHead", "session", "oppName"],
};

module.exports = { buildSamplePayload, PER_WIDGET_KEYS, SHARED_KEYS };
