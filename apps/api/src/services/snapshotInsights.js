"use strict";

const { roundToTick, resultOf } = require("./snapshotCohort");
const { VERDICTS } = require("./snapshotCompare");

/**
 * SnapshotInsightsService — derive the three insight blocks the
 * snapshot drilldown surfaces:
 *
 *  1. ``inflectionTick`` — the first 30 s tick where the game's
 *     verdict crossed from {neutral, likely_winning, winning} into
 *     the losing half. The metric whose score dropped most across
 *     the boundary is flagged as the proximate cause.
 *
 *  2. ``timingMisses`` — units / buildings the cohort winners had
 *     before a given tick that the user either skipped entirely or
 *     built >60 s after the cohort's median timing. Severity rises
 *     with how predictive that timing was inside the cohort (we
 *     proxy with the share of winners who actually had it).
 *
 *  3. ``coachingTags`` — small rule table that maps (metric, score,
 *     tick range) tuples to short tags the UI shows on the focused
 *     tick. The rules are intentionally narrow — each tag should
 *     read like a coach's one-liner, not a paragraph.
 */

const LOSING_SET = new Set([VERDICTS.LOSING, VERDICTS.LIKELY_LOSING]);
const NON_LOSING_SET = new Set([
  VERDICTS.NEUTRAL,
  VERDICTS.LIKELY_WINNING,
  VERDICTS.WINNING,
]);

const TIMING_DELAY_THRESHOLD_SEC = 60;
const TIMING_FAMILY_BUILDINGS = new Set([
  "Stargate",
  "RoboticsFacility",
  "TwilightCouncil",
  "DarkShrine",
  "TemplarArchive",
  "Factory",
  "Starport",
  "Armory",
  "FusionCore",
  "GhostAcademy",
  "BanelingNest",
  "RoachWarren",
  "Spire",
  "HydraliskDen",
  "InfestationPit",
  "UltraliskCavern",
  "LurkerDen",
]);

class SnapshotInsightsService {
  /**
   * @param {Array<{
   *   t: number,
   *   my: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   opp: { value: Record<string, number|null>, scores: Record<string, number>, aggregateScore: number },
   *   verdict: string,
   * }>} tickScores
   * @returns {{ inflectionTick: number|null, primaryMetric: string|null, secondaryMetric: string|null }}
   */
  detectInflection(tickScores) {
    for (let i = 1; i < tickScores.length; i += 1) {
      const prev = tickScores[i - 1];
      const cur = tickScores[i];
      if (NON_LOSING_SET.has(prev.verdict) && LOSING_SET.has(cur.verdict)) {
        const { primary, secondary } = biggestDrops(prev.my.scores, cur.my.scores);
        return {
          inflectionTick: cur.t,
          primaryMetric: primary,
          secondaryMetric: secondary,
        };
      }
    }
    return { inflectionTick: null, primaryMetric: null, secondaryMetric: null };
  }

  /**
   * Compute the median tick at which each unit / building first
   * appears for cohort winners, then surface entries where the
   * user either skipped (absent) or delayed (>60 s past median)
   * the build. Severity scales with the share of winners who
   * actually carried that unit at the median tick — a 90%-of-
   * winners-have-it Stargate miss is "high"; a 30% one is "low".
   *
   * @param {Array<object>} cohortGames
   * @param {Map<string, object>} detailsByGameId
   * @param {Array<any>} userTimeline the user's own unit_timeline
   * @returns {Array<{ type: 'tech'|'unit', unit: string, cohortWinnerMedianAt: number|null, gameBuiltAt: number|null, severity: 'low'|'medium'|'high', winnerShare: number }>}
   */
  detectTimingMisses(cohortGames, detailsByGameId, userTimeline) {
    const winnerFirstAppearances = collectFirstAppearances(cohortGames, detailsByGameId, true);
    const userFirstAppearances = firstAppearancesFor(userTimeline);
    /** @type {Array<any>} */
    const misses = [];
    for (const [unit, times] of winnerFirstAppearances) {
      const totalWinners = countWinners(cohortGames);
      const winnerShare = totalWinners > 0 ? times.length / totalWinners : 0;
      const medianAt = medianTick(times);
      if (medianAt === null || winnerShare < 0.5) continue;
      const userTime = userFirstAppearances.get(unit);
      const isTech = TIMING_FAMILY_BUILDINGS.has(unit);
      if (userTime === undefined) {
        misses.push({
          type: isTech ? "tech" : "unit",
          unit,
          cohortWinnerMedianAt: medianAt,
          gameBuiltAt: null,
          severity: severityFor(winnerShare, Infinity),
          winnerShare,
        });
      } else if (userTime > medianAt + TIMING_DELAY_THRESHOLD_SEC) {
        misses.push({
          type: isTech ? "tech" : "unit",
          unit,
          cohortWinnerMedianAt: medianAt,
          gameBuiltAt: userTime,
          severity: severityFor(winnerShare, userTime - medianAt),
          winnerShare,
        });
      }
    }
    misses.sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      if (sev !== 0) return sev;
      return (a.cohortWinnerMedianAt ?? 0) - (b.cohortWinnerMedianAt ?? 0);
    });
    return misses.slice(0, 12);
  }

  /**
   * Per-tick coaching tags from a fixed rule table. Each rule
   * inspects one tick's per-metric scores plus the absolute time
   * and emits a short tag the UI renders as a chip.
   *
   * Rules:
   *
   *  ``worker-deficit-early``   workers ≤ -1 with t < 360 s
   *  ``tech-rushed``            army_value +2 AND workers ≤ -1, both t < 300
   *  ``over-expanded``          bases +1 AND army_value ≤ -1, t < 420
   *  ``over-droned``            workers +2 AND army_value ≤ -1, t > 420
   *  ``supply-blocked``         army_supply ≤ -2 (any tick)
   *  ``income-starved``         income_min ≤ -2 with t > 240
   *
   * @param {Array<any>} tickScores
   */
  deriveCoachingTags(tickScores) {
    /** @type {Array<{ t: number, tags: string[] }>} */
    const out = [];
    for (const row of tickScores) {
      const tags = applyTagRules(row);
      if (tags.length > 0) out.push({ t: row.t, tags });
    }
    return out;
  }
}

/**
 * @param {Record<string, number>} prev
 * @param {Record<string, number>} cur
 */
function biggestDrops(prev, cur) {
  /** @type {Array<[string, number]>} */
  const diffs = [];
  for (const k of Object.keys(prev)) {
    const before = prev[k] ?? 0;
    const after = cur[k] ?? 0;
    diffs.push([k, after - before]);
  }
  diffs.sort((a, b) => a[1] - b[1]);
  return {
    primary: diffs[0]?.[1] < 0 ? diffs[0][0] : null,
    secondary: diffs[1]?.[1] < 0 ? diffs[1][0] : null,
  };
}

/**
 * For each game in the cohort, find the first tick each unit /
 * building appeared (count > 0). Aggregate across games into
 * unit → number[] of first appearances.
 *
 * @param {Array<object>} cohortGames
 * @param {Map<string, object>} detailsByGameId
 * @param {boolean} winnersOnly
 * @returns {Map<string, number[]>}
 */
function collectFirstAppearances(cohortGames, detailsByGameId, winnersOnly) {
  /** @type {Map<string, number[]>} */
  const out = new Map();
  for (const game of cohortGames) {
    if (winnersOnly && resultOf(game) !== "win") continue;
    const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
    if (!detail || !detail.macroBreakdown) continue;
    const fa = firstAppearancesFor(detail.macroBreakdown.unit_timeline);
    for (const [unit, time] of fa) {
      let arr = out.get(unit);
      if (!arr) {
        arr = [];
        out.set(unit, arr);
      }
      arr.push(time);
    }
  }
  return out;
}

/**
 * @param {Array<any>|undefined} timeline
 * @returns {Map<string, number>}
 */
function firstAppearancesFor(timeline) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!Array.isArray(timeline)) return out;
  for (const frame of timeline) {
    const t = roundToTick(frame?.time ?? frame?.t);
    if (t === null) continue;
    const my = frame?.my;
    if (!my || typeof my !== "object") continue;
    for (const [name, raw] of Object.entries(my)) {
      if (out.has(name)) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) continue;
      out.set(name, t);
    }
  }
  return out;
}

/** @param {Array<object>} games */
function countWinners(games) {
  let n = 0;
  for (const g of games) if (resultOf(g) === "win") n += 1;
  return n;
}

/** @param {number[]} arr */
function medianTick(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2 / 30) * 30;
  }
  return sorted[mid];
}

/**
 * @param {number} winnerShare 0..1
 * @param {number} delaySec
 */
function severityFor(winnerShare, delaySec) {
  if (winnerShare >= 0.85 && delaySec >= 90) return "high";
  if (winnerShare >= 0.7 || delaySec >= 90) return "medium";
  return "low";
}

/** @param {string} sev */
function severityRank(sev) {
  if (sev === "high") return 2;
  if (sev === "medium") return 1;
  return 0;
}

/**
 * @param {{ t: number, my: { scores: Record<string, number> } }} row
 */
function applyTagRules(row) {
  const t = row.t;
  const s = row.my.scores || {};
  /** @type {string[]} */
  const tags = [];
  if ((s.workers ?? 0) <= -1 && t < 360) tags.push("worker-deficit-early");
  if ((s.army_value ?? 0) >= 2 && (s.workers ?? 0) <= -1 && t < 300) {
    tags.push("tech-rushed");
  }
  if ((s.bases ?? 0) >= 1 && (s.army_value ?? 0) <= -1 && t < 420) {
    tags.push("over-expanded");
  }
  if ((s.workers ?? 0) >= 2 && (s.army_value ?? 0) <= -1 && t > 420) {
    tags.push("over-droned");
  }
  if ((s.army_supply ?? 0) <= -2) tags.push("supply-blocked");
  if ((s.income_min ?? 0) <= -2 && t > 240) tags.push("income-starved");
  return tags;
}

module.exports = {
  SnapshotInsightsService,
  applyTagRules,
  collectFirstAppearances,
  firstAppearancesFor,
  medianTick,
  severityFor,
  TIMING_DELAY_THRESHOLD_SEC,
};
