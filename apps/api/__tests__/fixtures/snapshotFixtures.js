// @ts-nocheck
"use strict";

/**
 * Real-shape fixtures for the snapshot cohort analytics tests. The
 * stats_events / unit_timeline shapes mirror what the v0.4.3+ agent
 * actually emits — opaque-array entries keyed by ``time`` (seconds),
 * 30 s cadence, integer / float values. The factories below build
 * plausibly-shaped tick series so the percentile and centroid math
 * runs against realistic inputs without us having to ship a 200 kB
 * anonymized replay blob inside the test bundle.
 *
 * Two builders:
 *
 *   ``makeStatsSeries(opts)``    — stats_events tick series for one
 *                                  side. Pass profile=winner|loser
 *                                  to bias the numbers toward what
 *                                  a winning / losing player has at
 *                                  each tick.
 *
 *   ``makeUnitTimeline(race, profile)`` — unit_timeline frames keyed
 *                                  by race so the base-count code
 *                                  path (Nexus / CommandCenter /
 *                                  Hatchery) actually hits a real
 *                                  unit name.
 *
 * The numbers are loosely derived from real PvZ macro replays — a
 * winner at 6:00 has ~60 workers / 18 supply army / 2-3 bases; a
 * loser at the same tick has ~45 workers / 12 supply army / 1-2
 * bases. Adjust with the ``boost`` knob inside a single test if a
 * narrower distribution is needed.
 */

const TICK_SECONDS = 30;
const MAX_TICK = 20 * 60;

function range(start, end, step) {
  const out = [];
  for (let t = start; t <= end; t += step) out.push(t);
  return out;
}

/**
 * @param {{ profile?: 'winner'|'loser', boost?: number, lastTick?: number }} opts
 */
function makeStatsSeries(opts = {}) {
  const profile = opts.profile ?? "winner";
  const boost = opts.boost ?? 1;
  const last = opts.lastTick ?? 720;
  const isWin = profile === "winner";
  return range(0, last, TICK_SECONDS).map((time) => {
    const minutes = time / 60;
    const workerBase = isWin ? 12 + minutes * 7 : 12 + minutes * 5;
    const armyBase = isWin ? minutes * 220 : minutes * 150;
    const supplyBase = isWin ? 12 + minutes * 4.5 : 12 + minutes * 3.5;
    const mineralIncome = isWin ? minutes * 230 : minutes * 170;
    const gasIncome = minutes > 1 ? (isWin ? minutes * 110 : minutes * 80) : 0;
    return {
      time,
      workers_active_count: Math.round(workerBase * boost),
      army_value: Math.round(armyBase * boost),
      food_used: Math.round(supplyBase * boost),
      minerals_collection_rate: Math.round(mineralIncome * boost),
      gas_collection_rate: Math.round(gasIncome * boost),
    };
  });
}

/**
 * @param {'P'|'T'|'Z'} race
 * @param {'winner'|'loser'} profile
 * @param {{ lastTick?: number }} [opts]
 */
function makeUnitTimeline(race, profile, opts = {}) {
  const last = opts.lastTick ?? 720;
  const isWin = profile === "winner";
  const baseUnit = race === "P" ? "Nexus" : race === "T" ? "CommandCenter" : "Hatchery";
  const armyUnit = race === "P" ? "Stalker" : race === "T" ? "Marine" : "Roach";
  const workerUnit = race === "P" ? "Probe" : race === "T" ? "SCV" : "Drone";
  return range(0, last, TICK_SECONDS).map((time) => {
    const minutes = time / 60;
    const bases = minutes < 1 ? 1 : minutes < 3 ? (isWin ? 2 : 1) : minutes < 5 ? (isWin ? 3 : 2) : isWin ? 3 : 2;
    const workers = Math.round(isWin ? 12 + minutes * 7 : 12 + minutes * 5);
    const army = Math.round(isWin ? minutes * 4 : minutes * 2.5);
    /** @type {Record<string, number>} */
    const my = {
      [baseUnit]: bases,
      [workerUnit]: workers,
    };
    if (army > 0) my[armyUnit] = army;
    if (minutes > 3 && race === "P") my.Stargate = isWin ? 1 : 0;
    if (minutes > 4 && race === "P" && isWin) my.Phoenix = Math.max(0, Math.round(minutes - 4));
    return {
      time,
      my,
      opp: { [race === "P" ? "Hatchery" : "Nexus"]: bases, [race === "P" ? "Drone" : "Probe"]: workers },
    };
  });
}

/**
 * Full game record + matching detail blob in one shot. Idempotent —
 * call with explicit gameId / userId per test to keep dedupe clean
 * inside the games unique index.
 */
function makeGameAndDetail({
  userId = "u1",
  gameId,
  result = "Victory",
  myRace = "Protoss",
  myBuild = "Protoss - Robo Opener",
  oppRace = "Zerg",
  oppOpening = "Zerg - Hatch First",
  date = new Date("2026-05-09T12:00:00Z"),
  myMmr = 4500,
  oppMmr = 4500,
  map = "Hard Lead LE",
  duration = 720,
  myProfile,
  oppProfile,
} = {}) {
  const isWin = result === "Victory";
  const mp = myProfile ?? (isWin ? "winner" : "loser");
  const op = oppProfile ?? (isWin ? "loser" : "winner");
  return {
    game: {
      userId,
      gameId,
      date,
      result,
      myRace,
      myBuild,
      myMmr,
      map,
      durationSec: duration,
      opponent: {
        pulseId: `${userId}-${gameId}-opp`,
        toonHandle: "1-S2-1-1",
        displayName: "Foe",
        race: oppRace,
        mmr: oppMmr,
        strategy: oppOpening,
        opening: oppOpening,
      },
    },
    detail: {
      macroBreakdown: {
        stats_events: makeStatsSeries({ profile: mp, lastTick: duration }),
        opp_stats_events: makeStatsSeries({ profile: op, lastTick: duration }),
        unit_timeline: makeUnitTimeline(myRace[0], mp, { lastTick: duration }),
      },
    },
  };
}

module.exports = {
  TICK_SECONDS,
  MAX_TICK,
  makeStatsSeries,
  makeUnitTimeline,
  makeGameAndDetail,
};
