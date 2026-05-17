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
 * Time-base note: as of 2026-05-17 the entire stack runs at real LotV
 * seconds. This classifier consumes macroBreakdown blobs at real scale
 * and emits crossings/finalScore in real seconds. Pre-migration data
 * (anything ingested before PR #309) is rewritten to the same scale by
 * the 2026-05-17-rescale-timebase migration so the classifier sees one
 * consistent timebase regardless of when the game was uploaded.
 *
 * The 60s base-ramp window in ``smoothedBaseCount`` is intentionally
 * left at 60: it means "60s of real wall-clock life," which is now
 * what the data actually provides. Pre-migration we were ramping over
 * 60 broken-seconds ≈ 84 real seconds.
 */

const { tierThreeInternalNames } = require("./timingCatalog");

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
  "Stargate", "FleetBeacon", "TemplarArchive", "DarkShrine",
  // Terran
  "Factory", "Starport", "Armory", "FusionCore", "GhostAcademy",
  // Zerg
  "BanelingNest", "RoachWarren", "HydraliskDen", "LurkerDen",
  "Spire", "GreaterSpire", "InfestationPit", "UltraliskCavern",
  "Lair", "Hive",
]);

/**
 * Tier-3 production-tech buildings. When ANY of these is active at
 * time ``t`` the per-second score is floored at ``PHASES.midLate``
 * — a 2-base game that has Hive or Templar Archives on the field has
 * reached the production point that *defines* mid/late SC2, even when
 * the base/worker terms say otherwise.
 *
 * Single source of truth: the ``tier: 3`` annotations on
 * ``timingCatalog.js``. Do NOT maintain a duplicate list here.
 *
 * @type {Set<string>}
 */
const T3_TECH = new Set(tierThreeInternalNames());

/**
 * Tier-3 units. When ONE has appeared in ``unit_timeline`` by time
 * ``t`` for the relevant perspective, the per-second score is floored
 * at ``PHASES.late``. Liberator / Viper / Disruptor sit at T2.5 in
 * practice — pulling a 5-minute Viper game into Late would over-
 * correct, so they're intentionally absent.
 *
 * @type {Set<string>}
 */
const T3_UNITS = new Set([
  // Zerg
  "BroodLord", "Ultralisk", "Lurker", "LurkerMP",
  // Protoss
  "Carrier", "Tempest", "Mothership",
  // Terran
  "Battlecruiser", "Thor",
]);

/**
 * Production-building names that double as expansions — used as the
 * fallback source when ``opp_bases`` is empty but ``opp_production_buildings``
 * carries the same hatchery/nexus/cc rows. Mirrors the ``_BASE_TYPES`` set
 * the extractor uses to split bases out of the production list.
 *
 * @type {Set<string>}
 */
const EXPANSION_NAMES = new Set([
  // Zerg
  "Hatchery", "Lair", "Hive",
  // Protoss
  "Nexus",
  // Terran
  "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
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
 * True if any T3 production-tech structure is alive at time ``t``.
 *
 * @param {Array<{name:string,born_time:number,died_time:number}>} productionBuildings
 * @param {number} t
 * @param {number} durationSec
 */
function hasActiveT3Tech(productionBuildings, t, durationSec) {
  for (const p of productionBuildings) {
    if (!T3_TECH.has(p.name)) continue;
    if (p.born_time > durationSec) continue;
    if (t < p.born_time) continue;
    if (t > p.died_time) continue;
    return true;
  }
  return false;
}

/**
 * True if any T3 unit (per ``T3_UNITS``) has been observed on the
 * given perspective's side of the unit timeline at or before ``t``.
 *
 * @param {Array<{time:number,my?:Record<string,number>,opp?:Record<string,number>}>} timeline
 * @param {number} t
 * @param {"you"|"opponent"} perspective
 */
function hasT3UnitByTime(timeline, t, perspective) {
  if (!Array.isArray(timeline) || timeline.length === 0) return false;
  const sideKey = perspective === "opponent" ? "opp" : "my";
  for (const row of timeline) {
    if (!row || typeof row !== "object") continue;
    const rowT = Number(row.time);
    if (!Number.isFinite(rowT) || rowT > t) continue;
    const side = row[sideKey];
    if (!side || typeof side !== "object") continue;
    for (const token of Object.keys(side)) {
      if (!T3_UNITS.has(token)) continue;
      const n = Number(side[token]);
      if (n > 0) return true;
    }
  }
  return false;
}

/**
 * @param {{
 *   bases: Array<object>,
 *   production_buildings: Array<object>,
 *   stats: {empty: boolean, lookup: (t:number)=>{workers:number|null,supply:number|null,armyValue:number|null}},
 *   race: string,
 *   durationSec: number,
 *   t: number,
 *   unitTimeline?: Array<object>,
 *   perspective?: "you"|"opponent",
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
  // Tier-3 floors: a 2-base Zerg with Brood Lords on the field should
  // never read as "Mid" just because the base/worker terms cap out
  // early. Production-tech being up floors at midLate; a T3 unit
  // having spawned floors at late. Floors only raise the score —
  // never lower it — so the rawScore is preserved for debugging.
  let floor = 0;
  if (hasActiveT3Tech(ctx.production_buildings, ctx.t, ctx.durationSec)) {
    floor = PHASES.midLate;
  }
  const timeline = Array.isArray(ctx.unitTimeline) ? ctx.unitTimeline : null;
  if (timeline && hasT3UnitByTime(timeline, ctx.t, ctx.perspective || "you")) {
    if (PHASES.late > floor) floor = PHASES.late;
  }
  const rawScore = score;
  const adjustedScore = rawScore > floor ? rawScore : floor;
  return {
    score: adjustedScore,
    rawScore,
    floor,
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
 * When ``opp_bases`` is empty but ``opp_production_buildings`` carries
 * expansion rows, synthesizes the bases array from the expansion
 * rows in production_buildings (sc2reader tracker quirk on some Zerg
 * replays — the hatchery rows are present, just not in the dedicated
 * bases stream).
 *
 * @param {object} macroBreakdown
 */
function readOppLifetimes(macroBreakdown) {
  const rawBases = Array.isArray(macroBreakdown.opp_bases)
    ? macroBreakdown.opp_bases : null;
  const production = Array.isArray(macroBreakdown.opp_production_buildings)
    ? macroBreakdown.opp_production_buildings : null;
  let bases = rawBases;
  if ((!rawBases || rawBases.length === 0) && production) {
    const synth = synthesizeBasesFromProduction(production);
    if (synth.length > 0) bases = synth;
  }
  return { bases, production };
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
      rawScore: sample.rawScore,
      floor: sample.floor,
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
 * Synthesize a bases array from the production-buildings list by
 * filtering on the expansion-building names. Used as the fallback
 * when ``opp_bases`` is empty (sc2reader tracker quirk on some Zerg
 * replays) but ``opp_production_buildings`` still carries the
 * Hatchery / Lair / Hive rows with their real born/died timestamps.
 *
 * @param {Array<{name:string,born_time:number,died_time:number}>} prodBuildings
 */
function synthesizeBasesFromProduction(prodBuildings) {
  /** @type {Array<{name:string,born_time:number,died_time:number}>} */
  const out = [];
  for (const p of prodBuildings) {
    if (!EXPANSION_NAMES.has(p.name)) continue;
    out.push({
      name: p.name,
      born_time: p.born_time,
      died_time: p.died_time,
    });
  }
  return out;
}

/**
 * Pick the right ``bases / production_buildings / stats /
 * unit_timeline`` set for the requested perspective. Centralises the
 * opp-fallback decision so the rest of the classifier doesn't branch
 * on it.
 *
 * When ``opp_bases`` is empty but ``opp_production_buildings`` carries
 * expansion rows, synthesizes a bases array from those rows so the
 * base term still contributes to the score on Zerg replays where the
 * tracker dropped the dedicated bases stream. Flags this fallback
 * with ``basesFromExpansionFallback: true`` so the test suite can pin
 * that the fallback fired.
 *
 * @param {object} mb
 * @param {number} durationSec
 * @param {"you"|"opponent"} perspective
 */
function pickClassifierInputs(mb, durationSec, perspective) {
  if (perspective === "opponent") {
    const rawBases = Array.isArray(mb.opp_bases) ? mb.opp_bases : [];
    const prodBuildings = Array.isArray(mb.opp_production_buildings)
      ? mb.opp_production_buildings : [];
    let bases = rawBases;
    let basesFromExpansionFallback = false;
    if (rawBases.length === 0 && prodBuildings.length > 0) {
      const synth = synthesizeBasesFromProduction(prodBuildings);
      if (synth.length > 0) {
        bases = synth;
        basesFromExpansionFallback = true;
      }
    }
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
    const unitTimeline = Array.isArray(mb.unit_timeline) ? mb.unit_timeline : [];
    return { bases, prodBuildings, stats, unitTimeline, basesFromExpansionFallback };
  }
  const bases = Array.isArray(mb.bases) ? mb.bases : [];
  const prodBuildings = Array.isArray(mb.production_buildings)
    ? mb.production_buildings : [];
  const stats = buildStatsLookup(mb.stats_events || [], durationSec);
  const unitTimeline = Array.isArray(mb.unit_timeline) ? mb.unit_timeline : [];
  return { bases, prodBuildings, stats, unitTimeline, basesFromExpansionFallback: false };
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
  const {
    bases,
    prodBuildings,
    stats,
    unitTimeline,
    basesFromExpansionFallback,
  } = pickClassifierInputs(mb, durationSec, perspective);

  const ctx = {
    bases,
    production_buildings: prodBuildings,
    stats,
    race,
    durationSec,
    unitTimeline,
    perspective,
  };
  const scoreFn = (t) => scoreAt({ ...ctx, t }).score;
  const sampleFn = (t) => scoreAt({ ...ctx, t });

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
    basesFromExpansionFallback,
  };
}

module.exports = {
  classifyGame,
  PHASES,
  PHASE_LABELS,
  T3_TECH,
  T3_UNITS,
  EXPANSION_NAMES,
};

/*
 * Calibration anchors (post-timebase fix 2026-05-17, post-T3-floor 2026-05-17):
 *
 * Replay                          finalPhase    midAt   lateAt
 * --------------------------------------------------------------
 * PvZ Adept Timing (warpgate)     mid           3:30   never
 * PvT 20m Skytoss WIN (TIIIII)    late          3:30   8:30
 * PvT 11m Cut-short LOSS (TPer.)  midLate       3:19   5:47
 * PvZ 15m Skytoss WIN (JmaC)      late          3:09   6:12
 *
 * Only the warpgate row is auto-verified in CI — its macroBreakdown
 * dump ships under apps/api/__tests__/fixtures/phase/ and is the
 * locked snapshot in apps/api/__tests__/phaseClassifier.test.js. The
 * other three calibration replays live in the maintainer's local
 * archive (see apps/api/__tests__/fixtures/macro_score_before_vs_after.csv
 * for the corresponding score envelope and the test.skip() entries
 * in phaseClassifier.test.js for the wiring).
 *
 * T3 floor (2026-05-17): the warpgate fixture is a Protoss build that
 * never reaches a tier-3 production-tech structure (no TemplarArchive
 * / DarkShrine / RoboticsBay / FleetBeacon active by game end) and
 * has no T3 unit in unit_timeline, so the floor logic adds zero
 * adjustment — the snapshot above is unchanged. The remaining three
 * calibration replays sit at finalPhase late/midLate/late already, so
 * the floor (which only raises scores) is also a no-op for them.
 *
 * Any change to scoring weights MUST regenerate these anchors and
 * include them in the same commit as the weight change — re-dump the
 * fixtures with scripts/dump-macro-fixture.py, flip the test.skip()
 * to test() once the replay is available, and refresh the table
 * above so it stays the source of truth for the calibration shape.
 */

