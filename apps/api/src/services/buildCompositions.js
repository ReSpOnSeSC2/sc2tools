"use strict";

const { classifyGame } = require("./phaseClassifier");
const { TECH_SC2_NAMES } = require("./techTokens");

/**
 * buildCompositions — per-phase signature aggregator for a list of
 * games already filtered to a single build. Mirrors the
 * ``buildDossier.js`` shape: pure compute, no I/O, no Date / Mongo
 * coupling. Caller does the filtering, sorting (newest-first), and
 * detail-blob hydration.
 *
 * For every phase (early / earlyMid / mid / midLate / late) we pick a
 * unit composition "signature" — the top 3 non-worker tokens active at
 * the phase window's midpoint — then cluster identical signatures
 * across games to surface what the player typically fields at that
 * point of the build. Each phase also carries roll-ups of which tech
 * buildings / key units and upgrades had appeared by that midpoint.
 *
 * Time-base note: every timestamp on the inputs and outputs is on the
 * sc2reader event.second scale (~1.4x faster than wall-clock LotV),
 * matching ``phaseClassifier`` and ``buildDossier``. We do NOT
 * convert here — see the cross-cutting fix tracked in
 * ``phaseClassifier.js`` header.
 */

const PHASE_ORDER = ["early", "earlyMid", "mid", "midLate", "late"];

/**
 * Phase → crossings keys used to derive (start, end) for the window.
 * ``early`` has no "earlyAt" — the game always begins in early, so we
 * special-case start = 0.
 *
 * @type {Record<string, {startKey: string|null, nextPhase: string|null}>}
 */
const PHASE_WINDOWS = {
  early: { startKey: null, nextPhase: "earlyMid" },
  earlyMid: { startKey: "earlyMidAt", nextPhase: "mid" },
  mid: { startKey: "midAt", nextPhase: "midLate" },
  midLate: { startKey: "midLateAt", nextPhase: "late" },
  late: { startKey: "lateAt", nextPhase: null },
};

/**
 * Unit tokens to strip from a unit_timeline row before computing the
 * signature. Covers workers, larva, overlords, MULEs, and the
 * supply / gas structures the extractor sometimes leaks into the
 * timeline. The signature is meant to reflect what the player is
 * actually fighting with, so these never count.
 */
const WORKER_SKIP = new Set([
  // Workers + larva + MULE
  "Drone", "SCV", "Probe", "MULE", "Larva",
  // Overlord family (transport / cocoon variants both occur)
  "Overlord", "OverlordTransport", "OverlordCocoon",
  // Supply / gas structures that sometimes show up in unit_timeline
  "Pylon", "SupplyDepot", "SupplyDepotLowered",
  "Extractor", "ExtractorRich",
  "Refinery", "RefineryRich",
]);

const MAX_SIGNATURES = 8;
const MAX_SAMPLE_GAME_IDS = 25;

/**
 * @param {Array<any>} games
 * @returns {{
 *   sampleSize: Record<string, number>,
 *   perPhase: Record<string, {
 *     signatures: Array<any>,
 *     tech: Array<any>,
 *     upgrades: Array<any>,
 *   }>,
 *   finalPhaseDistribution: Record<string, number>,
 *   flags: string[],
 * }}
 */
function computeCompositions(games) {
  const list = Array.isArray(games) ? games : [];

  /** @type {Record<string, number>} */
  const sampleSize = {
    early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
  };
  /** @type {Record<string, number>} */
  const finalPhaseDistribution = {
    early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
  };

  /** @type {Array<{game: any, classified: any}>} */
  const classifiedGames = [];
  /** @type {number[]} */
  const finalScores = [];

  for (const g of list) {
    const macroBreakdown = (g && g.macroBreakdown) || {};
    const race = g && g.myRace;
    const durationSec = (g && g.durationSec) || 0;
    const classified = classifyGame({ macroBreakdown, race, durationSec });
    classifiedGames.push({ game: g, classified });
    finalPhaseDistribution[classified.finalPhase] += 1;
    finalScores.push(classified.finalScore);
    // sampleSize: a game contributes to every phase up to and
    // including its final one (a "mid" game still reached early /
    // earlyMid). Mirrors the count semantics the dossier sample-size
    // panels expect.
    const finalIdx = PHASE_ORDER.indexOf(classified.finalPhase);
    for (let i = 0; i <= finalIdx; i++) {
      sampleSize[PHASE_ORDER[i]] += 1;
    }
  }

  /** @type {Record<string, ReturnType<typeof computePerPhase>>} */
  const perPhase = {};
  for (const phase of PHASE_ORDER) {
    perPhase[phase] = computePerPhase(classifiedGames, phase);
  }

  const flags = computeFlags(finalPhaseDistribution, finalScores, list.length);

  return { sampleSize, perPhase, finalPhaseDistribution, flags };
}

/**
 * Derive (start, end) for one phase from a game's crossings. Returns
 * null when the game never reached this phase.
 *
 * @param {string} phase
 * @param {Record<string, any>} crossings
 * @param {number} durationSec
 */
function getPhaseWindow(phase, crossings, durationSec) {
  const cfg = PHASE_WINDOWS[phase];
  const start = cfg.startKey === null ? 0 : crossings[cfg.startKey];
  if (start === null || start === undefined) return null;
  let end = durationSec;
  if (cfg.nextPhase) {
    const nextCfg = PHASE_WINDOWS[cfg.nextPhase];
    const nextKey = nextCfg.startKey;
    const nextVal = nextKey === null ? 0 : crossings[nextKey];
    if (nextVal !== null && nextVal !== undefined) end = nextVal;
  }
  return { start, end };
}

/**
 * Pick the top-3 non-worker units active at the unit_timeline row
 * whose ``time`` is closest to ``midpoint``. Returns an empty array
 * if no usable row exists (missing or empty unit_timeline, or row
 * has no non-worker entries).
 *
 * Sort is deterministic: count desc, token asc on ties — so the
 * resulting signature key is stable across runs.
 *
 * @param {any} macroBreakdown
 * @param {number} midpoint
 * @returns {Array<{token: string, count: number}>}
 */
function pickSignatureUnits(macroBreakdown, midpoint) {
  const timeline = Array.isArray(macroBreakdown && macroBreakdown.unit_timeline)
    ? macroBreakdown.unit_timeline
    : [];
  if (timeline.length === 0) return [];
  let best = timeline[0];
  let bestDist = Math.abs(Number(best.time) - midpoint);
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.abs(Number(timeline[i].time) - midpoint);
    if (d < bestDist) {
      best = timeline[i];
      bestDist = d;
    }
  }
  const my = (best && best.my) || {};
  /** @type {Array<{token: string, count: number}>} */
  const entries = [];
  for (const token of Object.keys(my)) {
    if (WORKER_SKIP.has(token)) continue;
    const n = Number(my[token]);
    if (!(n > 0)) continue;
    entries.push({ token, count: n });
  }
  entries.sort(byCountDescTokenAsc);
  return entries.slice(0, 3);
}

/**
 * @param {{token: string, count: number}} a
 * @param {{token: string, count: number}} b
 */
function byCountDescTokenAsc(a, b) {
  if (a.count !== b.count) return b.count - a.count;
  if (a.token < b.token) return -1;
  if (a.token > b.token) return 1;
  return 0;
}

/**
 * Bucket signatures + roll up tech / upgrade timings for one phase.
 *
 * @param {Array<{game: any, classified: any}>} classifiedGames
 * @param {string} phase
 */
function computePerPhase(classifiedGames, phase) {
  /** @type {Map<string, {key: string, units: any[], sampleCount: number, wins: number, losses: number, sampleGameIds: string[]}>} */
  const sigBuckets = new Map();
  /** @type {Map<string, number[]>} */
  const techTimes = new Map();
  /** @type {Map<string, number[]>} */
  const upgradeTimes = new Map();

  for (const { game, classified } of classifiedGames) {
    const durationSec = (game && game.durationSec) || 0;
    const window = getPhaseWindow(phase, classified.crossings, durationSec);
    if (!window) continue;
    const midpoint = (window.start + window.end) / 2;

    const units = pickSignatureUnits(game.macroBreakdown, midpoint);
    if (units.length > 0) {
      const key = signatureKey(units);
      let bucket = sigBuckets.get(key);
      if (!bucket) {
        bucket = {
          key, units, sampleCount: 0, wins: 0, losses: 0, sampleGameIds: [],
        };
        sigBuckets.set(key, bucket);
      }
      const b = bucket;
      b.sampleCount += 1;
      if (isWonResult(game.result)) b.wins += 1;
      else if (isLossResult(game.result)) b.losses += 1;
      if (b.sampleGameIds.length < MAX_SAMPLE_GAME_IDS && game.gameId) {
        b.sampleGameIds.push(String(game.gameId));
      }
    }

    collectTechFirstSeen(game, midpoint, techTimes);
    collectUpgradeFirstSeen(game, midpoint, upgradeTimes);
  }

  return {
    signatures: finalizeSignatures(sigBuckets),
    tech: finalizeRows(techTimes),
    upgrades: finalizeRows(upgradeTimes),
  };
}

/**
 * @param {Array<{token: string, count: number}>} units
 */
function signatureKey(units) {
  return units.map((u) => u.token).join("|");
}

/**
 * Scan a game's events (parsed buildLog) for the first occurrence of
 * any tech token, recording the start time when it occurred at-or-
 * before the phase midpoint.
 *
 * @param {any} game
 * @param {number} midpoint
 * @param {Map<string, number[]>} acc
 */
function collectTechFirstSeen(game, midpoint, acc) {
  const events = Array.isArray(game && game.events) ? game.events : [];
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  for (const ev of events) {
    const name = ev && ev.name;
    if (!name || !TECH_SC2_NAMES.has(name)) continue;
    if (!firstSeen.has(name)) firstSeen.set(name, Number(ev.time));
  }
  for (const [token, t] of firstSeen) {
    if (t <= midpoint) {
      const cur = acc.get(token);
      if (cur) cur.push(t);
      else acc.set(token, [t]);
    }
  }
}

/**
 * Same shape for upgrade events. Upgrades are identified by
 * ``category === "upgrade"`` — that's the canonical tag set by
 * ``parseBuildLogLines`` either from the catalog or the
 * ``isKnownUpgrade`` fallback. Both paths agree with
 * ``isFinishTimeEvent`` from ``buildDurations.js``.
 *
 * @param {any} game
 * @param {number} midpoint
 * @param {Map<string, number[]>} acc
 */
function collectUpgradeFirstSeen(game, midpoint, acc) {
  const events = Array.isArray(game && game.events) ? game.events : [];
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  for (const ev of events) {
    if (!ev || ev.category !== "upgrade") continue;
    const name = ev.name;
    if (!name) continue;
    if (!firstSeen.has(name)) firstSeen.set(name, Number(ev.time));
  }
  for (const [token, t] of firstSeen) {
    if (t <= midpoint) {
      const cur = acc.get(token);
      if (cur) cur.push(t);
      else acc.set(token, [t]);
    }
  }
}

/**
 * @param {Map<string, {key: string, units: any[], sampleCount: number, wins: number, losses: number, sampleGameIds: string[]}>} buckets
 */
function finalizeSignatures(buckets) {
  const rows = [];
  for (const b of buckets.values()) {
    const denom = b.wins + b.losses;
    rows.push({
      key: b.key,
      units: b.units,
      sampleCount: b.sampleCount,
      wins: b.wins,
      losses: b.losses,
      winRate: denom > 0 ? b.wins / denom : 0,
      sampleGameIds: b.sampleGameIds,
    });
  }
  rows.sort(bySampleCountDescKeyAsc);
  if (rows.length <= MAX_SIGNATURES) return rows;
  const top = rows.slice(0, MAX_SIGNATURES);
  const rest = rows.slice(MAX_SIGNATURES);
  let sampleCount = 0;
  let wins = 0;
  let losses = 0;
  for (const r of rest) {
    sampleCount += r.sampleCount;
    wins += r.wins;
    losses += r.losses;
  }
  const denom = wins + losses;
  top.push({
    key: "Other",
    units: [],
    sampleCount,
    wins,
    losses,
    winRate: denom > 0 ? wins / denom : 0,
    sampleGameIds: [],
  });
  return top;
}

/**
 * @param {{sampleCount: number, key: string}} a
 * @param {{sampleCount: number, key: string}} b
 */
function bySampleCountDescKeyAsc(a, b) {
  if (a.sampleCount !== b.sampleCount) return b.sampleCount - a.sampleCount;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

/**
 * @param {{sampleCount: number, token: string}} a
 * @param {{sampleCount: number, token: string}} b
 */
function bySampleCountDescTokenAsc(a, b) {
  if (a.sampleCount !== b.sampleCount) return b.sampleCount - a.sampleCount;
  if (a.token < b.token) return -1;
  if (a.token > b.token) return 1;
  return 0;
}

/**
 * @param {Map<string, number[]>} timesByToken
 */
function finalizeRows(timesByToken) {
  const rows = [];
  for (const [token, times] of timesByToken) {
    const sorted = times.slice().sort((a, b) => a - b);
    rows.push({
      token,
      sampleCount: sorted.length,
      medianFirstSeen: percentile(sorted, 50),
      p25: percentile(sorted, 25),
      p75: percentile(sorted, 75),
    });
  }
  rows.sort(bySampleCountDescTokenAsc);
  return rows;
}

/**
 * Linear-interpolation percentile over a pre-sorted array of numbers.
 * Returns 0 for empty input. Identical semantics across all three
 * percentile callers (p25 / median / p75) so the rows agree on
 * whatever quirky tie-breaking the linear method picks.
 *
 * @param {number[]} sorted
 * @param {number} p
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * @param {Record<string, number>} dist
 * @param {number[]} finalScores
 * @param {number} total
 */
function computeFlags(dist, finalScores, total) {
  /** @type {string[]} */
  const flags = [];
  if (total === 0) return flags;
  const beforeMid = (dist.early + dist.earlyMid) / total;
  const stuckMid = (dist.mid + dist.midLate) / total;
  const lateFrac = dist.late / total;
  const peak = Math.max(
    dist.early, dist.earlyMid, dist.mid, dist.midLate, dist.late,
  ) / total;
  if (beforeMid > 0.6) flags.push("early_pressure");
  if (stuckMid > 0.6) {
    const med = percentile(finalScores.slice().sort((a, b) => a - b), 50);
    if (med >= 40 && med < 75) flags.push("stuck_in_mid");
  }
  if (lateFrac > 0.6) flags.push("macro");
  if (peak <= 0.5) flags.push("high_variance");
  return flags;
}

/**
 * Result-string predicates. Mirror the helpers in dnaTimings.js /
 * buildDossier.js so this service stays self-contained for tests
 * that build the games array by hand.
 *
 * @param {string} r
 */
function isWonResult(r) {
  return r === "Win" || r === "Victory";
}

/**
 * @param {string} r
 */
function isLossResult(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "loss" || s === "defeat";
}

module.exports = { computeCompositions, PHASE_WINDOWS, WORKER_SKIP };
