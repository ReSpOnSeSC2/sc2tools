"use strict";

const {
  classifyGame,
  MAX_CLASSIFIER_DURATION_SEC,
} = require("./phaseClassifier");
const { TECH_SC2_NAMES } = require("./techTokens");
const {
  peakAliveInWindow,
  canonicalizeName,
  MAX_UNIT_TOKEN_LENGTH,
  MAX_UNIT_KEYS_PER_TICK_SIDE,
} = require("./scouting/compositionAt");
const { isKnownBuilding, isKnownUpgrade } = require("./knownBuildings");

/**
 * buildCompositions — per-phase signature aggregator for a list of
 * games already filtered to a single build. Mirrors the
 * ``buildDossier.js`` shape: pure compute, no I/O, no Date / Mongo
 * coupling. Caller does the filtering, sorting (newest-first), and
 * detail-blob hydration.
 *
 * For every phase (early / earlyMid / mid / midLate / late), unitSummary
 * covers the whole observed cohort and signatures group the top three
 * unit types by their sampled peak alive counts. Each phase also carries
 * tech-start and upgrade-completion timings observed by its midpoint.
 *
 * Inputs and outputs use real LotV seconds, matching phaseClassifier.
 * unitSummary reports each unit's sampled peak alive within each game,
 * averaged across all observed games (including observed zero counts).
 * Independent unit peaks need not coexist and are not production totals.
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
const MAX_PHASE_UNITS = 64;
const MAX_PHASE_TIMING_TOKENS = 128;
const MAX_SUMMARY_TIMELINE_ROWS = 5000;
const HAS_OWN = Object.prototype.hasOwnProperty;
// Filter raw names BEFORE canonicalization: AdeptPhaseShift and
// DisruptorPhased would otherwise become ordinary army units.
const TRANSIENT_UNITS = new Set([
  "Egg", "Broodling", "BroodlingEscort", "Interceptor", "Locust",
  "LocustMP", "LocustMPFlying", "LocustMPPrecursor", "InfestedTerran",
  "PointDefenseDrone", "AdeptPhaseShift", "DisruptorPhased", "KD8Charge",
  "ForceField", "OracleStasisTrap",
]);

/**
 * @param {Array<any>} games
 * @param {{ perspective?: "you"|"opponent" }} [opts]
 *   ``perspective="opponent"`` rescores phases from the opponent's
 *   side and pulls signatures from ``unit_timeline[*].opp`` instead
 *   of ``.my``. When >50% of the matched games are missing
 *   ``opp_stats_events`` the function returns a zeroed envelope plus
 *   the ``opp_signals_sparse`` flag — the frontend's EmptyState
 *   already triggers on all-zero sampleSize so the trajectory strip
 *   doesn't render a noisy / incomplete chart.
 * @returns {{
 *   sampleSize: Record<string, number>,
 *   perPhase: Record<string, {
 *     signatures: Array<any>,
 *     tech: Array<any>,
 *     upgrades: Array<any>,
 *   }>,
 *   finalPhaseDistribution: Record<string, number>,
 *   medianCrossings: {
 *     earlyMidAt: number|null,
 *     midAt: number|null,
 *     midLateAt: number|null,
 *     lateAt: number|null,
 *   },
 *   durationP95Sec: number,
 *   flags: string[],
 * }}
 */
function computeCompositions(games, opts = {}) {
  const list = Array.isArray(games) ? games : [];
  const perspective = opts && opts.perspective === "opponent" ? "opponent" : "you";
  const preparedGames = list.map((game) => ({
    game,
    prepared: preparedCompositionFor(game, perspective),
  }));

  if (perspective === "opponent" && oppSignalTooSparse(preparedGames)) {
    return emptyCompositionsResult(["opp_signals_sparse"]);
  }

  /** @type {Record<string, number>} */
  const sampleSize = {
    early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
  };
  /** @type {Record<string, number>} */
  const finalPhaseDistribution = {
    early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0,
  };

  /** @type {Array<{game: any, classified: any, prepared: any}>} */
  const classifiedGames = [];
  /** @type {number[]} */
  const finalScores = [];
  /** @type {Record<string, number[]>} */
  const crossingSamples = {
    earlyMidAt: [], midAt: [], midLateAt: [], lateAt: [],
  };
  /** @type {number[]} */
  const durations = [];

  for (const { game: g, prepared } of preparedGames) {
    // From the opponent's perspective the trajectory uses their race,
    // not the user's — falls back to the user's race when the
    // extractor didn't record an opponent race (legacy imports).
    const durationSec = prepared.durationSec;
    const classified = prepared.classified;
    classifiedGames.push({ game: g, classified, prepared });
    finalPhaseDistribution[classified.finalPhase] += 1;
    finalScores.push(classified.finalScore);
    if (durationSec > 0) durations.push(durationSec);
    // Collect non-null crossings for the median aggregate. Null means
    // the game never reached that phase — exclude it from the median
    // so a build that's mostly short games doesn't drag the lateAt
    // crossing to ``ceiling``.
    for (const key of Object.keys(crossingSamples)) {
      const v = classified.crossings && classified.crossings[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        crossingSamples[key].push(v);
      }
    }
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
    perPhase[phase] = computePerPhase(classifiedGames, phase, perspective);
  }

  const flags = computeFlags(finalPhaseDistribution, finalScores, list.length);

  const medianCrossings = {
    earlyMidAt: medianOrNull(crossingSamples.earlyMidAt),
    midAt: medianOrNull(crossingSamples.midAt),
    midLateAt: medianOrNull(crossingSamples.midLateAt),
    lateAt: medianOrNull(crossingSamples.lateAt),
  };
  const sortedDurations = durations.slice().sort((a, b) => a - b);
  const durationP95Sec = sortedDurations.length
    ? percentile(sortedDurations, 95)
    : 0;

  return {
    sampleSize,
    perPhase,
    finalPhaseDistribution,
    medianCrossings,
    durationP95Sec,
    flags,
  };
}

/**
 * @param {number[]} samples
 * @returns {number|null}
 */
function medianOrNull(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  return percentile(sorted, 50);
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
 * Pick the top-3 non-worker units active during the phase window.
 * Uses the SAME peak-alive sampler the per-game scouting envelope
 * uses (``peakAliveInWindow``), so a strategy bucket's signature
 * reflects "what units did the player typically have on the field
 * during this phase" rather than "what was alive at the exact
 * midpoint timeline row" — the midpoint approach used to land on
 * sparse / post-engagement samples and report nonsense like
 * "1 Carrier" when the player fielded 8.
 *
 * Canonicalises sc2reader variants (Lurker / LurkerMP /
 * LurkerMPBurrowed → Lurker) before the peak is taken, so a stack
 * of burrowed + unburrowed roaches reads as one Roach entry. Sort
 * is deterministic: count desc, token asc on ties — keeps the
 * signature key stable across runs.
 *
 * @param {any} macroBreakdown
 * @param {number} windowStart phase window start (seconds)
 * @param {number} windowEnd phase window end (seconds)
 * @param {"you"|"opponent"} [perspective]
 * @returns {Array<{token: string, count: number}>}
 */
function pickSignatureUnits(macroBreakdown, windowStart, windowEnd, perspective) {
  const timeline = Array.isArray(macroBreakdown && macroBreakdown.unit_timeline)
    ? macroBreakdown.unit_timeline
    : [];
  if (timeline.length === 0) return [];
  const side = perspective === "opponent" ? "opp" : "my";
  const peak = peakAliveInWindow(
    timeline, windowStart, windowEnd, side, WORKER_SKIP,
  );
  /** @type {Array<{token: string, count: number}>} */
  const entries = [];
  for (const [token, count] of Object.entries(peak.counts)) {
    if (!(count > 0)) continue;
    entries.push({ token, count });
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
 * @param {Array<{game: any, classified: any, prepared: any}>} classifiedGames
 * @param {string} phase
 * @param {"you"|"opponent"} [perspective]
 */
function computePerPhase(classifiedGames, phase, perspective) {
  /**
   * @type {Map<string, {
   *   key: string,
   *   countsByToken: Map<string, number[]>,
   *   fullCountsByToken: Map<string, number[]>,
   *   sampleCount: number,
   *   wins: number,
   *   losses: number,
   *   sampleGameIds: string[],
   * }>}
   */
  const sigBuckets = new Map();
  /** @type {Map<string, number[]>} */
  const techTimes = new Map();
  /** @type {Map<string, number[]>} */
  const upgradeTimes = new Map();
  /** @type {Array<{gameId: unknown, units: Array<{token: string, count: number}>}>} */
  const summaryGames = [];
  let missingGames = 0;

  for (const { game, prepared } of classifiedGames) {
    const phaseData = prepared.phases[phase];
    if (!phaseData) continue;
    if (phaseData.observedUnits) {
      summaryGames.push({ gameId: game.gameId, units: phaseData.observedUnits });
    } else {
      missingGames += 1;
    }

    // Strict per-unit peaks feed both the summary and legacy groups.
    // Tech and upgrades retain the chronological phase midpoint cutoff.
    /** @type {Array<{token: string, count: number}>} */
    const units = phaseData.units;
    const allUnits = phaseData.allUnits;
    if (units.length > 0) {
      const key = signatureKey(units);
      // A changing count rank is not a new composition. Preserve the
      // legacy display order while grouping by the same set of tokens.
      const groupKey = units.map((u) => u.token).sort().join("|");
      let bucket = sigBuckets.get(groupKey);
      if (!bucket) {
        bucket = {
          key,
          countsByToken: new Map(),
          fullCountsByToken: new Map(),
          sampleCount: 0,
          wins: 0,
          losses: 0,
          sampleGameIds: [],
        };
        sigBuckets.set(groupKey, bucket);
      }
      const b = bucket;
      b.sampleCount += 1;
      // ``game.result`` is always recorded from the USER's side. From
      // the opponent's perspective a user Win is the opponent's loss
      // (and vice-versa), so the W/L is mirrored — otherwise the "what
      // they typically do" column reports the user's record verbatim
      // and both columns of the comparison view show an identical
      // (impossible) win rate.
      const won = isWonResult(game.result);
      const lost = isLossResult(game.result);
      if (perspective === "opponent") {
        if (won) b.losses += 1;
        else if (lost) b.wins += 1;
      } else {
        if (won) b.wins += 1;
        else if (lost) b.losses += 1;
      }
      // Track every observed count per token across games in this
      // bucket. Top-3 are used for the headline display; the full set
      // is exposed for the "show all units" expansion so a roach into
      // ravager transition isn't hidden behind a top-3 truncation.
      for (const u of units) {
        appendCount(b.countsByToken, u.token, u.count);
      }
      for (const u of allUnits) {
        appendCount(b.fullCountsByToken, u.token, u.count);
      }
      if (b.sampleGameIds.length < MAX_SAMPLE_GAME_IDS && game.gameId) {
        b.sampleGameIds.push(String(game.gameId));
      }
    }

    appendPreparedTimes(techTimes, phaseData.tech);
    appendPreparedTimes(upgradeTimes, phaseData.upgrades);
  }

  return {
    signatures: finalizeSignatures(sigBuckets),
    tech: finalizeRows(techTimes),
    upgrades: finalizeRows(upgradeTimes),
    unitSummary: summarizeObservedUnits(summaryGames, missingGames),
  };
}

/**
 * Strict, bounded sample reader for the transparent cohort summary.
 * Adjacent phases use [start, end); the final phase includes game end.
 * Missing samples stay missing rather than borrowing a later army.
 * An explicit empty side map is a valid observation of zero units.
 * @param {any} macroBreakdown
 * @param {{start: number, end: number}} window
 * @param {"you"|"opponent"} perspective
 * @param {boolean} includeEnd
 * @returns {Array<{token: string, count: number}>|null}
 */
function observedUnitsInWindow(macroBreakdown, window, perspective, includeEnd) {
  const timeline = Array.isArray(macroBreakdown?.unit_timeline)
    ? macroBreakdown.unit_timeline : [];
  const side = perspective === "opponent" ? "opp" : "my";
  const peak = new Map();
  let observed = false;
  for (let i = 0; i < Math.min(timeline.length, MAX_SUMMARY_TIMELINE_ROWS); i++) {
    const row = timeline[i];
    const time = row?.time;
    if (typeof time !== "number" || !Number.isFinite(time)
      || time < window.start || time > window.end
      || (!includeEnd && time === window.end)) continue;
    const values = row?.[side];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    const counts = new Map();
    let inspected = 0;
    let validValue = false;
    let hasKey = false;
    for (const name in values) {
      if (inspected >= MAX_UNIT_KEYS_PER_TICK_SIDE) break;
      inspected += 1;
      if (!HAS_OWN.call(values, name)) continue;
      hasKey = true;
      if (!name || name.length > MAX_UNIT_TOKEN_LENGTH) continue;
      const count = values[name];
      if (!Number.isSafeInteger(count) || count < 0) continue;
      validValue = true;
      if (!count || WORKER_SKIP.has(name) || TRANSIENT_UNITS.has(name)
        || /^(Beacon|Changeling)/.test(name)
        || /(Cocoon|Egg)$/.test(name)
        || isKnownBuilding(name) || isKnownUpgrade(name)) continue;
      const token = canonicalizeName(name);
      if (!token || WORKER_SKIP.has(token) || TRANSIENT_UNITS.has(token)
        || isKnownBuilding(token) || isKnownUpgrade(token)) continue;
      counts.set(token, (counts.get(token) || 0) + count);
    }
    // Malformed-only maps must not turn into a false zero observation.
    if (hasKey && !validValue) continue;
    observed = true;
    for (const [token, count] of counts) {
      peak.set(token, Math.max(peak.get(token) || 0, count));
    }
  }
  if (!observed) return null;
  return [...peak.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort(byCountDescTokenAsc)
    .slice(0, MAX_PHASE_UNITS);
}

/**
 * All statistics include absent-unit zeros from observed games.
 * @param {Array<{gameId: unknown, units: Array<{token: string, count: number}>}>} games
 * @param {number} missingGames
 * @returns {import('./types').BuildUnitSummary}
 */
function summarizeObservedUnits(games, missingGames) {
  /** @type {Map<string, {counts: number[], sampleGameIds: string[]}>} */
  const byToken = new Map();
  for (const game of games) {
    for (const { token, count } of game.units) {
      if (!byToken.has(token)) byToken.set(token, { counts: [], sampleGameIds: [] });
      const row = byToken.get(token);
      if (!row) continue;
      row.counts.push(count);
      if (game.gameId && row.sampleGameIds.length < MAX_SAMPLE_GAME_IDS) {
        row.sampleGameIds.push(String(game.gameId));
      }
    }
  }
  const observedGames = games.length;
  const units = [];
  for (const [token, row] of byToken) {
    const gamesPresent = row.counts.length;
    const sorted = [...row.counts, ...Array(observedGames - gamesPresent).fill(0)]
      .sort((a, b) => a - b);
    units.push({
      token,
      mean: sorted.reduce((total, n) => total + n, 0) / observedGames,
      median: percentile(sorted, 50),
      p25: percentile(sorted, 25),
      p75: percentile(sorted, 75),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      gamesPresent,
      sampleGameIds: row.sampleGameIds,
    });
  }
  units.sort((a, b) => b.mean - a.mean || a.token.localeCompare(b.token));
  return {
    metric: "peak_alive",
    source: "unit_timeline",
    observedGames,
    missingGames,
    emptyArmyGames: games.filter((game) => game.units.length === 0).length,
    units: units.slice(0, MAX_PHASE_UNITS),
  };
}

/**
 * @param {Array<{token: string, count: number}>} units
 */
function signatureKey(units) {
  return units.map((u) => u.token).join("|");
}

/**
 * @param {Map<string, number[]>} map
 * @param {string} token
 * @param {number} count
 */
function appendCount(map, token, count) {
  let list = map.get(token);
  if (!list) {
    list = [];
    map.set(token, list);
  }
  list.push(count);
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
function collectTechFirstSeen(game, midpoint, acc, perspective = "you") {
  const selected = perspective === "opponent" ? game?.oppEvents : game?.events;
  const events = Array.isArray(selected) ? selected : [];
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  for (const ev of events) {
    const name = ev && ev.name;
    if (!name || !TECH_SC2_NAMES.has(name)) continue;
    const time = ev.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) continue;
    firstSeen.set(name, Math.min(firstSeen.get(name) ?? Infinity, time));
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
function collectUpgradeFirstSeen(game, midpoint, acc, perspective = "you") {
  const selected = perspective === "opponent" ? game?.oppEvents : game?.events;
  const events = Array.isArray(selected) ? selected : [];
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  for (const ev of events) {
    if (!ev || ev.category !== "upgrade") continue;
    const name = ev.name;
    if (!name) continue;
    // Prepared events may carry inferred research starts; upgrades become
    // available only at their recorded completion time.
    const time = ev.complete_time ?? ev.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) continue;
    firstSeen.set(name, Math.min(firstSeen.get(name) ?? Infinity, time));
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
 * @param {Map<string, {
 *   key: string,
 *   countsByToken: Map<string, number[]>,
 *   fullCountsByToken: Map<string, number[]>,
 *   sampleCount: number,
 *   wins: number,
 *   losses: number,
 *   sampleGameIds: string[],
 * }>} buckets
 */
function finalizeSignatures(buckets) {
  const rows = [];
  for (const b of buckets.values()) {
    const denom = b.wins + b.losses;
    rows.push({
      key: b.key,
      // ``units`` keeps the legacy shape — top 3 tokens with the
      // median count across the bucket. Frontends that haven't been
      // updated yet still render the same way.
      units: medianUnitsList(b.countsByToken, b.key, 3),
      // ``fullComposition`` is the new field: every non-worker unit
      // observed across the bucket, with median + sample count per
      // token. Frontends opt into it for the expanded view.
      fullComposition: medianUnitsList(b.fullCountsByToken, b.key, Infinity),
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
    fullComposition: [],
    sampleCount,
    wins,
    losses,
    winRate: denom > 0 ? wins / denom : 0,
    sampleGameIds: [],
  });
  return top;
}

/**
 * Convert a token → counts[] map into a sorted list of
 * {token, count, sampleCount} entries where ``count`` is the median
 * across the observations and ``sampleCount`` is how many games saw
 * the token. Keys ordered by the signature key tokens (preserves the
 * left-to-right reading order from the cluster key), then by median
 * count desc for any extras.
 *
 * @param {Map<string, number[]>} countsByToken
 * @param {string} signatureKey — pipe-separated top tokens for the bucket
 * @param {number} limit — max tokens to include in the result
 */
function medianUnitsList(countsByToken, signatureKey, limit) {
  const headTokens = signatureKey ? signatureKey.split("|") : [];
  const seen = new Set();
  /** @type {Array<{token: string, count: number, sampleCount: number}>} */
  const out = [];
  for (const token of headTokens) {
    if (seen.has(token)) continue;
    const list = countsByToken.get(token);
    if (!list || list.length === 0) continue;
    seen.add(token);
    out.push(toMedianEntry(token, list));
    if (out.length >= limit) return out;
  }
  // Extras: tokens beyond the signature head (only the full-composition
  // map will have these; the top-3 map's keys are exactly the head).
  /** @type {Array<{token: string, count: number, sampleCount: number}>} */
  const extras = [];
  for (const [token, list] of countsByToken) {
    if (seen.has(token)) continue;
    if (!list || list.length === 0) continue;
    extras.push(toMedianEntry(token, list));
  }
  extras.sort(byCountDescTokenAsc);
  for (const e of extras) {
    out.push(e);
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * @param {string} token
 * @param {number[]} counts
 * @returns {{token: string, count: number, sampleCount: number}}
 */
function toMedianEntry(token, counts) {
  const sorted = counts.slice().sort((a, b) => a - b);
  return {
    token,
    count: Math.round(percentile(sorted, 50)),
    sampleCount: sorted.length,
  };
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

/**
 * @param {any} game
 * @param {"you"|"opponent"} [perspective]
 */
function prepareCompositionGame(game, perspective = "you") {
  const side = perspective === "opponent" ? "opponent" : "you";
  const macroBreakdown = (game && game.macroBreakdown) || {};
  const race = side === "opponent"
    ? ((game && game.oppRace) || (game && game.myRace))
    : (game && game.myRace);
  const durationSec = Math.min(
    Math.max(0, Number(game && game.durationSec) || 0),
    MAX_CLASSIFIER_DURATION_SEC,
  );
  const classifiedFull = classifyGame({
    macroBreakdown,
    race,
    durationSec,
    perspective: side,
    compact: true,
  });
  // Phase aggregation only consumes these three fields. Retaining the full
  // trajectories on every prepared replay multiplied hundreds of 30-second
  // rows across the cohort after the raw detail had otherwise been released.
  const classified = {
    crossings: classifiedFull.crossings,
    finalPhase: classifiedFull.finalPhase,
    finalScore: classifiedFull.finalScore,
  };
  /** @type {Record<string, any>} */
  const phases = {};
  for (const phase of PHASE_ORDER) {
    const window = getPhaseWindow(phase, classified.crossings, durationSec);
    if (!window) {
      phases[phase] = null;
      continue;
    }
    const midpoint = (window.start + window.end) / 2;
    const techTimes = new Map();
    const upgradeTimes = new Map();
    collectTechFirstSeen(game, midpoint, techTimes, side);
    collectUpgradeFirstSeen(game, midpoint, upgradeTimes, side);
    const observedUnits = observedUnitsInWindow(
      macroBreakdown, window, side, phase === classified.finalPhase,
    );
    phases[phase] = {
      observedUnits,
      units: observedUnits ? observedUnits.slice(0, 3) : [],
      allUnits: observedUnits || [],
      tech: firstPreparedTimes(techTimes),
      upgrades: firstPreparedTimes(upgradeTimes),
    };
  }
  return {
    perspective: side,
    durationSec,
    classified,
    hasOpponentStats: Array.isArray(macroBreakdown.opp_stats_events)
      && macroBreakdown.opp_stats_events.length > 0,
    phases,
  };
}

/** @param {any} game @param {"you"|"opponent"} perspective */
function preparedCompositionFor(game, perspective) {
  const prepared = game && game._phasePrepared;
  return prepared && prepared.perspective === perspective
    ? prepared
    : prepareCompositionGame(game, perspective);
}

/** @param {Map<string, number[]>} values */
function firstPreparedTimes(values) {
  return [...values.entries()]
    .slice(0, MAX_PHASE_TIMING_TOKENS)
    .map(([token, times]) => [token, times[0]]);
}

/** @param {Map<string, number[]>} target @param {Array<[string, number]>} rows */
function appendPreparedTimes(target, rows) {
  for (const [token, time] of Array.isArray(rows) ? rows : []) {
    const current = target.get(token);
    if (current) current.push(time);
    else target.set(token, [time]);
  }
}

/** @param {Array<{prepared: {hasOpponentStats?: boolean}}>} list */
function oppSignalTooSparse(list) {
  if (!list || list.length === 0) return false;
  let missing = 0;
  for (const row of list) {
    if (!row?.prepared?.hasOpponentStats) missing += 1;
  }
  return missing > list.length / 2;
}

/**
 * Build the zero-filled envelope returned when opp-perspective signal
 * is too sparse to render. Mirrors the empty-input shape callers
 * already handle so the frontend code path stays the same.
 *
 * @param {string[]} flags
 */
function emptyCompositionsResult(flags) {
  /** @type {Record<string, number>} */
  const zeroes = { early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0 };
  /** @type {Record<string, {signatures: any[], tech: any[], upgrades: any[], unitSummary: import('./types').BuildUnitSummary}>} */
  const perPhase = {};
  for (const p of PHASE_ORDER) {
    perPhase[p] = {
      signatures: [], tech: [], upgrades: [],
      unitSummary: summarizeObservedUnits([], 0),
    };
  }
  return {
    sampleSize: { ...zeroes },
    perPhase,
    finalPhaseDistribution: { ...zeroes },
    medianCrossings: {
      earlyMidAt: null, midAt: null, midLateAt: null, lateAt: null,
    },
    durationP95Sec: 0,
    flags: flags.slice(),
  };
}

module.exports = {
  computeCompositions,
  PHASE_ORDER,
  PHASE_WINDOWS,
  WORKER_SKIP,
  pickSignatureUnits,
  signatureKey,
  getPhaseWindow,
  prepareCompositionGame,
  MAX_PHASE_UNITS,
  MAX_PHASE_TIMING_TOKENS,
};
