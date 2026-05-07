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
        oppBuild: "Zerg - 12 Pool",
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
  ],
  "session": ["session"],
};

module.exports = { buildSamplePayload, PER_WIDGET_KEYS, SHARED_KEYS };
