"use strict";

const {
  DECISION_BUILDINGS,
  pathSignature,
  pathIdFromSignature,
  pathLabel,
  filterToDecisionBuildings,
} = require("./snapshotTechPathLabels");
const { raceLetter, TICK_SECONDS, NUM_TICKS, resultOf } = require("./snapshotCohort");

/**
 * SnapshotTechPathService — categorize a game's tech path at each
 * 30 s tick and look up the per-path win rate from a cohort.
 *
 * Why categorical instead of tier-numeric: two players "at tier 2"
 * can be in completely different strategic positions — Twilight vs
 * Robo vs Stargate are categorical decisions, not points on a
 * scalar. Compressing them loses the information the player needs
 * most.
 *
 * Inputs are the per-game ``buildLog`` (string lines like
 * ``"[1:23] Stalker"``) — we parse those into ``(time, name)``
 * events, filter to decision buildings, and compute the path
 * signature as a sorted frozenset of building names completed by
 * tick ``t``. Cohort win rate is read off pre-aggregated counts.
 *
 * The transitions block surfaces what cohort winners on the same
 * path built next — the actionable insight is "you're on the same
 * path as the winners, but they added X by Y; you didn't". The
 * alternatives block surfaces other tier-2 paths so the user can
 * see whether their pick is the dominant winning choice in the
 * cohort or a coinflip.
 */

const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+([A-Za-z0-9_]+)/;
const TRANSITION_LOOKAHEAD_SEC = 180;

class SnapshotTechPathService {
  /**
   * Parse a ``buildLog`` (array of "[mm:ss] Name" strings) into
   * decision-building first-appearance times, race-filtered.
   *
   * @param {string[]|undefined} buildLog
   * @param {string|null} race
   * @returns {Map<string, number>}
   */
  parseDecisionBuildings(buildLog, race) {
    /** @type {Map<string, number>} */
    const firstAt = new Map();
    if (!Array.isArray(buildLog) || !race) return firstAt;
    const allowed = DECISION_BUILDINGS[/** @type {'P'|'T'|'Z'} */ (race)];
    if (!allowed) return firstAt;
    for (const line of buildLog) {
      const m = BUILD_LOG_LINE_RE.exec(String(line || ""));
      if (!m) continue;
      const minutes = Number.parseInt(m[1], 10);
      const seconds = Number.parseInt(m[2], 10);
      const name = m[3];
      if (!allowed.has(name) || firstAt.has(name)) continue;
      firstAt.set(name, minutes * 60 + seconds);
    }
    return firstAt;
  }

  /**
   * Walk the timeline tick-by-tick and return one path signature
   * per tick. Each tick's signature is the set of decision
   * buildings completed AT OR BEFORE the tick's timestamp.
   *
   * @param {Map<string, number>} firstAt building → first-seen sec
   * @param {string|null} race
   * @returns {Array<{ t: number, pathId: string, signature: string, buildings: string[], label: string }>}
   */
  buildPerTickPath(firstAt, race) {
    /** @type {Array<any>} */
    const out = [];
    for (let i = 0; i < NUM_TICKS; i += 1) {
      const t = i * TICK_SECONDS;
      /** @type {string[]} */
      const present = [];
      for (const [name, atSec] of firstAt) {
        if (atSec <= t) present.push(name);
      }
      present.sort();
      const sig = pathSignature(present);
      out.push({
        t,
        pathId: pathIdFromSignature(sig),
        signature: sig,
        buildings: present,
        label: pathLabel(present, race),
      });
    }
    return out;
  }

  /**
   * Aggregate per-path win counts across a cohort at a single
   * tick. Returns one row per distinct path that appeared with
   * the wins/losses + the share of the cohort that took it.
   *
   * @param {Array<object>} cohortGames slim rows
   * @param {Map<string, object>} detailsByGameId
   * @param {number} tickSec
   * @returns {Array<{ pathId: string, signature: string, buildings: string[], label: string, wins: number, losses: number, total: number, frequency: number, winRate: number, winRateCI: [number, number] }>}
   */
  computePathStatsAtTick(cohortGames, detailsByGameId, tickSec) {
    /** @type {Map<string, { wins: number, losses: number, buildings: string[], race: string|null }>} */
    const byPath = new Map();
    let cohortTotal = 0;
    for (const game of cohortGames) {
      const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
      if (!detail) continue;
      const race = raceLetter(game.myRace);
      const first = this.parseDecisionBuildings(detail.buildLog, race);
      const present = [];
      for (const [name, atSec] of first) {
        if (atSec <= tickSec) present.push(name);
      }
      present.sort();
      const sig = pathSignature(present);
      const result = resultOf(game);
      if (result !== "win" && result !== "loss") continue;
      cohortTotal += 1;
      let row = byPath.get(sig);
      if (!row) {
        row = { wins: 0, losses: 0, buildings: present, race };
        byPath.set(sig, row);
      }
      if (result === "win") row.wins += 1;
      else row.losses += 1;
    }
    /** @type {Array<any>} */
    const out = [];
    for (const [sig, row] of byPath) {
      const total = row.wins + row.losses;
      const winRate = total > 0 ? row.wins / total : 0;
      out.push({
        pathId: pathIdFromSignature(sig),
        signature: sig,
        buildings: row.buildings,
        label: pathLabel(row.buildings, row.race),
        wins: row.wins,
        losses: row.losses,
        total,
        frequency: cohortTotal > 0 ? total / cohortTotal : 0,
        winRate,
        winRateCI: wilsonCI(row.wins, total),
      });
    }
    out.sort((a, b) => b.total - a.total);
    return out;
  }

  /**
   * Walk cohort winners on the focal path and surface the
   * follow-up buildings they added in the next ~3 minutes after
   * arriving at the path. "afterSec" is the gap from arrival.
   *
   * @param {string[]} focalBuildings the path the user is on
   * @param {Array<object>} cohortGames
   * @param {Map<string, object>} detailsByGameId
   * @param {number} tickSec
   * @returns {Array<{ addedBuilding: string, afterSec: number, frequencyAmongWinners: number }>}
   */
  computeTransitions(focalBuildings, cohortGames, detailsByGameId, tickSec) {
    /** @type {Map<string, { afterTotal: number, count: number }>} */
    const byAdded = new Map();
    let winnersOnPath = 0;
    const focalSet = new Set(focalBuildings);
    for (const game of cohortGames) {
      if (resultOf(game) !== "win") continue;
      const detail = detailsByGameId.get(`${game.userId}:${game.gameId}`);
      if (!detail) continue;
      const race = raceLetter(game.myRace);
      const first = this.parseDecisionBuildings(detail.buildLog, race);
      const presentAtTick = [];
      for (const [name, atSec] of first) {
        if (atSec <= tickSec) presentAtTick.push(name);
      }
      if (!sameSet(presentAtTick, focalSet)) continue;
      winnersOnPath += 1;
      for (const [name, atSec] of first) {
        if (atSec <= tickSec || atSec > tickSec + TRANSITION_LOOKAHEAD_SEC) continue;
        if (focalSet.has(name)) continue;
        let row = byAdded.get(name);
        if (!row) {
          row = { afterTotal: 0, count: 0 };
          byAdded.set(name, row);
        }
        row.afterTotal += atSec - tickSec;
        row.count += 1;
      }
    }
    if (winnersOnPath === 0) return [];
    /** @type {Array<any>} */
    const out = [];
    for (const [name, row] of byAdded) {
      out.push({
        addedBuilding: name,
        afterSec: Math.round(row.afterTotal / row.count),
        frequencyAmongWinners: row.count / winnersOnPath,
      });
    }
    out.sort((a, b) => b.frequencyAmongWinners - a.frequencyAmongWinners);
    return out.slice(0, 5);
  }

  /**
   * Translate a cohort-relative path win rate into a -2..+2 score
   * the compare service can fold into the aggregate. Baseline is
   * 50% (neutral). +2 at 70%, -2 at 30%. Linear in between.
   *
   * @param {number} pathWinRate
   */
  scoreFromWinRate(pathWinRate) {
    if (!Number.isFinite(pathWinRate)) return 0;
    const centered = pathWinRate - 0.5;
    const scaled = centered / 0.1;
    if (scaled > 2) return 2;
    if (scaled < -2) return -2;
    return scaled;
  }
}

/**
 * @param {string[]} arr
 * @param {Set<string>} set
 */
function sameSet(arr, set) {
  if (arr.length !== set.size) return false;
  for (const x of arr) if (!set.has(x)) return false;
  return true;
}

/**
 * Wilson score interval for a binomial proportion. Tighter than
 * the normal approximation at small sample sizes — important when
 * a tier-1 cohort path only has ~12 games.
 *
 * @param {number} successes
 * @param {number} total
 * @returns {[number, number]}
 */
function wilsonCI(successes, total) {
  if (total <= 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Convenience helper used by the route layer — for a focal game,
 * build everything (path, win rate, alternatives, transitions)
 * for a single tick.
 *
 * @param {SnapshotTechPathService} svc
 * @param {{ buildLog: string[]|undefined, race: string|null }} focal
 * @param {Array<object>} cohortGames
 * @param {Map<string, object>} detailsByGameId
 * @param {number} tickSec
 */
function buildTickResponse(svc, focal, cohortGames, detailsByGameId, tickSec) {
  const stats = svc.computePathStatsAtTick(cohortGames, detailsByGameId, tickSec);
  const focalFirst = svc.parseDecisionBuildings(focal.buildLog, focal.race);
  const focalBuildings = [];
  for (const [name, atSec] of focalFirst) {
    if (atSec <= tickSec) focalBuildings.push(name);
  }
  focalBuildings.sort();
  const focalSig = pathSignature(focalBuildings);
  const focalPath = stats.find((s) => s.signature === focalSig);
  const alternatives = stats
    .filter((s) => s.signature !== focalSig && s.total >= 5)
    .slice(0, 5);
  const transitions = svc.computeTransitions(focalBuildings, cohortGames, detailsByGameId, tickSec);
  const winRate = focalPath?.winRate ?? 0.5;
  const sampleSize = focalPath?.total ?? 0;
  return {
    pathId: pathIdFromSignature(focalSig),
    pathLabel: pathLabel(focalBuildings, focal.race),
    buildingsInPath: focalBuildings,
    pathFrequency: focalPath?.frequency ?? 0,
    pathWinRate: winRate,
    pathWinRateCI: focalPath?.winRateCI ?? [0, 1],
    sampleSize,
    score: svc.scoreFromWinRate(winRate),
    alternatives,
    transitions,
  };
}

module.exports = {
  SnapshotTechPathService,
  BUILD_LOG_LINE_RE,
  buildTickResponse,
  wilsonCI,
  filterToDecisionBuildings,
};
