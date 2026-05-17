"use strict";

/**
 * Phase classifier — labels each moment of a stored game as one of
 * five phases (Early, Early/Mid, Mid, Mid/Late, Late) by scoring base
 * count, worker count, supply, tech variety and army value at each
 * sampled second.
 *
 * Pure function: takes a single macroBreakdown blob plus the game's
 * race and durationSec, returns a trajectory + threshold crossings +
 * final phase. No I/O, no dates, no DB access — matches the
 * `buildDossier.js` style.
 *
 * The scoring formula and phase thresholds in this file are the
 * calibration anchor for the snapshot tests in
 * `apps/api/__tests__/phaseClassifier.test.js`. Don't change the
 * numbers without re-running those snapshots.
 *
 * Time-base note: every `time`, `born_time`, `died_time` we read off
 * the macroBreakdown is on sc2reader's `event.second` scale, which
 * assumes 16fps and runs ~1.4x faster than real LotV game-time.
 * The whole replay-analyzer stack (buildLog timestamps, macro_score
 * computation, DNA timings) operates at this scale, so we DO NOT
 * convert. See issue #TBD ("global sc2reader 22.4fps fix") for the
 * cross-cutting fix.
 */

/** @type {Record<string, number>} */
const PHASES = {
  early: 0,
  earlyMid: 20,
  mid: 40,
  midLate: 60,
  late: 80,
};

/** @type {Record<string, string>} */
const PHASE_LABELS = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

const TECH_NAMES = new Set([
  // Protoss
  "CyberneticsCore", "TwilightCouncil", "RoboticsFacility", "RoboticsBay",
  "Stargate", "FleetBeacon", "TemplarArchives", "DarkShrine",
  // Terran
  "Factory", "Starport", "Armory", "FusionCore", "GhostAcademy",
  // Zerg
  "BanelingNest", "RoachWarren", "HydraliskDen", "LurkerDen",
  "Spire", "GreaterSpire", "InfestationPit", "UltraliskCavern",
  "Lair", "Hive",
]);

const BASE_PTS_ZERG = [0, 0, 12, 25, 38, 50, 55];
const BASE_PTS_NON_ZERG = [0, 0, 15, 30, 45, 55, 55];

/**
 * @param {string} race
 * @returns {Array<number>}
 */
function basePtsTiers(race) {
  return race === "Zerg" ? BASE_PTS_ZERG : BASE_PTS_NON_ZERG;
}

/**
 * Linearly interpolate within the tier table by smoothed-base count.
 *
 * @param {number} eff
 * @param {string} race
 */
function basePts(eff, race) {
  if (!(eff > 0)) return 0;
  const tiers = basePtsTiers(race);
  const lastIdx = tiers.length - 1;
  if (eff >= lastIdx) return tiers[lastIdx];
  const lo = Math.floor(eff);
  const hi = Math.ceil(eff);
  if (lo === hi) return tiers[lo];
  const frac = eff - lo;
  return tiers[lo] + (tiers[hi] - tiers[lo]) * frac;
}

/**
 * Sum of per-base ramp values at time `t`. Each base contributes
 * `min((t - born)/60, 1)` while it is alive. Bases born after
 * durationSec or whose lifespan doesn't include `t` contribute 0.
 *
 * @param {Array<{born_time:number,died_time:number}>} bases
 * @param {number} t
 * @param {number} durationSec
 */
function smoothedBaseCount(bases, t, durationSec) {
  let sum = 0;
  for (const b of bases) {
    const born = b.born_time;
    if (born > durationSec) continue;
    const died = b.died_time;
    if (t < born) continue;
    if (t > died) continue;
    const age = t - born;
    sum += age >= 60 ? 1 : age / 60;
  }
  return sum;
}

/**
 * Count of active tech structures at time `t`. Same born/died filter
 * as smoothedBaseCount; restricted to TECH_NAMES.
 *
 * @param {Array<{name:string,born_time:number,died_time:number}>} productionBuildings
 * @param {number} t
 * @param {number} durationSec
 */
function activeTechCount(productionBuildings, t, durationSec) {
  let n = 0;
  for (const p of productionBuildings) {
    if (!TECH_NAMES.has(p.name)) continue;
    if (p.born_time > durationSec) continue;
    if (t < p.born_time) continue;
    if (t > p.died_time) continue;
    n += 1;
  }
  return n;
}

/**
 * Index of the nearest stats row at or before `t`. Returns -1 when
 * `t` precedes the first sample. `times` MUST be ascending — the
 * extractor emits them in walk order which is monotonic.
 *
 * @param {Array<number>} times
 * @param {number} t
 */
function nearestPrecedingIndex(times, t) {
  if (!times.length || t < times[0]) return -1;
  // Linear scan is fine — stats_events tops out around ~30 rows/min
  // and we're called once per integer second of the game. Replacing
  // it with binary search saves microseconds and obscures the code.
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Build a stats lookup that returns {workers, supply, armyValue} for
 * any `t`. When stats_events is missing/empty, the lookup returns
 * `null` for each field so the score formula can drop the term
 * instead of multiplying by NaN.
 *
 * @param {Array<object>} statsEvents
 * @param {number} durationSec
 */
function buildStatsLookup(statsEvents, durationSec) {
  const list = Array.isArray(statsEvents) ? statsEvents : [];
  const filtered = list.filter((s) => Number(s.time) <= durationSec);
  if (filtered.length === 0) {
    return {
      empty: true,
      lookup: () => ({ workers: null, supply: null, armyValue: null }),
    };
  }
  const times = filtered.map((s) => Number(s.time));
  return {
    empty: false,
    /** @param {number} t */
    lookup(t) {
      const idx = nearestPrecedingIndex(times, t);
      if (idx < 0) {
        return { workers: 0, supply: 0, armyValue: 0 };
      }
      const s = filtered[idx];
      return {
        workers: Number(s.food_workers) || 0,
        supply: Number(s.food_used) || 0,
        armyValue: Number(s.army_value) || 0,
      };
    },
  };
}

/**
 * Map a numeric score to a phase key using the {0,20,40,60,80}
 * thresholds.
 *
 * @param {number} score
 * @returns {"early"|"earlyMid"|"mid"|"midLate"|"late"}
 */
function phaseFromScore(score) {
  if (score >= PHASES.late) return "late";
  if (score >= PHASES.midLate) return "midLate";
  if (score >= PHASES.mid) return "mid";
  if (score >= PHASES.earlyMid) return "earlyMid";
  return "early";
}

/**
 * @param {{
 *   bases: Array<object>,
 *   production_buildings: Array<object>,
 *   stats: {empty: boolean, lookup: (t:number)=>{workers:number|null,supply:number|null,armyValue:number|null}},
 *   race: string,
 *   durationSec: number,
 *   t: number,
 * }} ctx
 */
function scoreAt(ctx) {
  const eff = smoothedBaseCount(ctx.bases, ctx.t, ctx.durationSec);
  const tech = activeTechCount(
    ctx.production_buildings, ctx.t, ctx.durationSec);
  const s = ctx.stats.lookup(ctx.t);
  let score = basePts(eff, ctx.race);
  if (s.workers !== null) {
    score += Math.min(s.workers / 80, 1) * 25;
  }
  if (s.supply !== null) {
    score += Math.min(Math.max(s.supply - 12, 0) / 188, 1) * 20;
  }
  score += Math.min(tech / 5, 1) * 15;
  if (s.armyValue !== null) {
    score += Math.min(s.armyValue / 5000, 1) * 10;
  }
  return {
    score,
    bases: countActiveBases(ctx.bases, ctx.t, ctx.durationSec),
    basesEffective: eff,
    workers: s.workers,
    supply: s.supply,
    tech,
    armyValue: s.armyValue,
  };
}

/**
 * @param {Array<{born_time:number,died_time:number}>} bases
 * @param {number} t
 * @param {number} durationSec
 */
function countActiveBases(bases, t, durationSec) {
  let n = 0;
  for (const b of bases) {
    if (b.born_time > durationSec) continue;
    if (t < b.born_time) continue;
    if (t > b.died_time) continue;
    n += 1;
  }
  return n;
}

/**
 * Collect deaths (bases + tech structures) that occurred BEFORE the
 * game ended. The extractor caps `died_time` at `game_length_sec` for
 * structures that survived to the end — we don't want those showing
 * up as deaths, hence the strict `< durationSec` comparison.
 *
 * @param {Array<{name:string,born_time:number,died_time:number}>} bases
 * @param {Array<{name:string,born_time:number,died_time:number}>} prodBuildings
 * @param {number} durationSec
 */
function collectDeathEvents(bases, prodBuildings, durationSec) {
  const out = [];
  for (const b of bases) {
    if (b.born_time > durationSec) continue;
    if (b.died_time >= durationSec) continue;
    if (b.died_time <= b.born_time) continue;
    out.push({ t: b.died_time, kind: "base", name: b.name });
  }
  for (const p of prodBuildings) {
    if (!TECH_NAMES.has(p.name)) continue;
    if (p.born_time > durationSec) continue;
    if (p.died_time >= durationSec) continue;
    if (p.died_time <= p.born_time) continue;
    out.push({ t: p.died_time, kind: "tech", name: p.name });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Find the first integer second at which score crosses each
 * threshold. Returns null per threshold when never reached.
 *
 * @param {(t:number) => number} scoreFn
 * @param {number} durationSec
 */
function findCrossings(scoreFn, durationSec) {
  const targets = {
    earlyMidAt: PHASES.earlyMid,
    midAt: PHASES.mid,
    midLateAt: PHASES.midLate,
    lateAt: PHASES.late,
  };
  /** @type {Record<string, number|null>} */
  const out = {
    earlyMidAt: null,
    midAt: null,
    midLateAt: null,
    lateAt: null,
  };
  const cap = Math.max(0, Math.floor(durationSec));
  for (let t = 0; t <= cap; t++) {
    const s = scoreFn(t);
    if (out.earlyMidAt === null && s >= targets.earlyMidAt) out.earlyMidAt = t;
    if (out.midAt === null && s >= targets.midAt) out.midAt = t;
    if (out.midLateAt === null && s >= targets.midLateAt) out.midLateAt = t;
    if (out.lateAt === null && s >= targets.lateAt) out.lateAt = t;
    if (out.lateAt !== null) break;
  }
  return out;
}

/**
 * Pick the opponent's bases / production buildings out of the
 * macroBreakdown blob if they were captured. The extractor doesn't
 * currently emit `opp_bases` / `opp_production_buildings` for the
 * opponent — when those keys are absent we omit base/tech terms from
 * the opponent's trajectory rather than fabricating them from
 * stats_events.
 *
 * @param {object} macroBreakdown
 */
function readOppLifetimes(macroBreakdown) {
  return {
    bases: Array.isArray(macroBreakdown.opp_bases)
      ? macroBreakdown.opp_bases : null,
    production: Array.isArray(macroBreakdown.opp_production_buildings)
      ? macroBreakdown.opp_production_buildings : null,
  };
}

/**
 * Sample a trajectory every 30s up to and including durationSec.
 *
 * @param {(t:number) => ReturnType<typeof scoreAt>} sampleFn
 * @param {number} durationSec
 */
function sampleTrajectory(sampleFn, durationSec) {
  /** @type {Array<object>} */
  const out = [];
  const cap = Math.max(0, Math.floor(durationSec));
  for (let t = 0; t <= cap; t += 30) {
    const sample = sampleFn(t);
    out.push({
      t,
      phase: phaseFromScore(sample.score),
      score: sample.score,
      bases: sample.bases,
      basesEffective: sample.basesEffective,
      workers: sample.workers,
      supply: sample.supply,
      tech: sample.tech,
      armyValue: sample.armyValue,
    });
  }
  return out;
}

/**
 * Build the opponent trajectory using whatever fields the
 * macroBreakdown actually carries. Omits any field we can't observe
 * rather than zero-filling.
 *
 * @param {object} macroBreakdown
 * @param {string} race
 * @param {number} durationSec
 */
function buildOppTrajectory(macroBreakdown, race, durationSec) {
  const stats = buildStatsLookup(
    macroBreakdown.opp_stats_events || [], durationSec);
  const opp = readOppLifetimes(macroBreakdown);
  const cap = Math.max(0, Math.floor(durationSec));
  const out = [];
  for (let t = 0; t <= cap; t += 30) {
    const s = stats.lookup(t);
    /** @type {Record<string, any>} */
    const row = { t };
    if (opp.bases) {
      const eff = smoothedBaseCount(opp.bases, t, durationSec);
      row.bases = countActiveBases(opp.bases, t, durationSec);
      row.basesEffective = eff;
    }
    if (opp.production) {
      row.tech = activeTechCount(opp.production, t, durationSec);
    }
    if (!stats.empty) {
      row.workers = s.workers;
      row.supply = s.supply;
      row.armyValue = s.armyValue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Average score across the last 30s of the game (durationSec-30 ..
 * durationSec), sampled at 5s steps. Used for the final-phase label.
 *
 * @param {(t:number) => number} scoreFn
 * @param {number} durationSec
 */
function finalWindowScore(scoreFn, durationSec) {
  const end = Math.max(0, Math.floor(durationSec));
  const start = Math.max(0, end - 30);
  let sum = 0;
  let n = 0;
  for (let t = start; t <= end; t += 5) {
    sum += scoreFn(t);
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Pick the right ``bases / production_buildings / stats`` triple for
 * the requested perspective. Centralises the opp-fallback decision so
 * the rest of the classifier doesn't branch on it.
 *
 * @param {object} mb
 * @param {number} durationSec
 * @param {"you"|"opponent"} perspective
 */
function pickClassifierInputs(mb, durationSec, perspective) {
  if (perspective === "opponent") {
    const bases = Array.isArray(mb.opp_bases) ? mb.opp_bases : [];
    const prodBuildings = Array.isArray(mb.opp_production_buildings)
      ? mb.opp_production_buildings : [];
    const oppStatsEvents = Array.isArray(mb.opp_stats_events)
      ? mb.opp_stats_events : [];
    // Fall back to the user's stats stream when opp's is missing.
    // sc2reader sometimes drops the opponent's tracker stream
    // entirely on Zerg replays — without the fallback the score
    // would always be 0 for those games, dragging the median
    // crossings to ``never reached``.
    const statsSource = oppStatsEvents.length > 0
      ? oppStatsEvents
      : (Array.isArray(mb.stats_events) ? mb.stats_events : []);
    const stats = buildStatsLookup(statsSource, durationSec);
    return { bases, prodBuildings, stats };
  }
  const bases = Array.isArray(mb.bases) ? mb.bases : [];
  const prodBuildings = Array.isArray(mb.production_buildings)
    ? mb.production_buildings : [];
  const stats = buildStatsLookup(mb.stats_events || [], durationSec);
  return { bases, prodBuildings, stats };
}

/**
 * Classify each moment of a single game.
 *
 * @param {{
 *   macroBreakdown: object,
 *   race: "Protoss"|"Terran"|"Zerg",
 *   durationSec: number,
 *   perspective?: "you"|"opponent",
 * }} input
 *
 * ``perspective="opponent"`` rescores the trajectory from the
 * opponent's side: ``opp_bases``, ``opp_production_buildings``, and
 * ``opp_stats_events`` are the primary inputs. When the extractor
 * dropped ``opp_stats_events`` (a known sc2reader tracker quirk on
 * some Zerg replays) we fall back to ``stats_events`` for the
 * workers / supply / army terms so the classifier still has signal;
 * bases / tech stay null-handled and just drop their score
 * contribution rather than borrow from the user's side.
 */
function classifyGame(input) {
  const mb = (input && input.macroBreakdown) || {};
  const race = input && input.race;
  const durationSec = Math.max(0, Math.floor((input && input.durationSec) || 0));
  const perspective = input && input.perspective === "opponent" ? "opponent" : "you";
  const { bases, prodBuildings, stats } = pickClassifierInputs(
    mb, durationSec, perspective,
  );

  const scoreFn = (t) => scoreAt({
    bases, production_buildings: prodBuildings, stats,
    race, durationSec, t,
  }).score;
  const sampleFn = (t) => scoreAt({
    bases, production_buildings: prodBuildings, stats,
    race, durationSec, t,
  });

  const crossings = findCrossings(scoreFn, durationSec);
  const finalScore = finalWindowScore(scoreFn, durationSec);
  const finalPhase = phaseFromScore(finalScore);
  const trajectory = sampleTrajectory(sampleFn, durationSec);
  const oppTrajectory = buildOppTrajectory(mb, race, durationSec);
  const deathEvents = collectDeathEvents(bases, prodBuildings, durationSec);

  return {
    crossings,
    finalPhase,
    finalScore,
    trajectory,
    oppTrajectory,
    deathEvents,
  };
}

module.exports = { classifyGame, PHASES, PHASE_LABELS };
