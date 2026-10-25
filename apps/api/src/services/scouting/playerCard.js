"use strict";

const { tierThreeInternalNames } = require("../timingCatalog");
const { T3_UNITS } = require("../phaseClassifier");
const { canonicalizeName } = require("./compositionAt");

/** @typedef {{earlyFinish:boolean|null,expansion:boolean|null,economy:boolean|null,tech:boolean|null,air:boolean|null}} Tendencies */
/** @typedef {Record<string, any>} Row */

const BASES = new Set(["Hatchery", "Lair", "Hive", "Nexus", "CommandCenter", "OrbitalCommand", "PlanetaryFortress"]);
const T3_TECH = new Set(tierThreeInternalNames());
// Supply/scouting units (Overlord, Observer) are deliberately excluded.
const COMBAT_AIR = new Set(["Mutalisk", "Corruptor", "BroodLord", "Viper", "Phoenix", "VoidRay", "Oracle", "Tempest", "Carrier", "Mothership", "Viking", "Banshee", "Battlecruiser", "Liberator", "Raven", "Medivac", "WarpPrism"]);
const AXES = [
  { key: "earlyFinish", label: "Early finish", detail: "Games ending before 5:00. This describes game length, not aggression or skill." },
  { key: "expansion", label: "Expansion", detail: "Games where at least two opponent bases were alive together." },
  { key: "economy", label: "Economy", detail: "Games where the opponent reached 60 workers." },
  { key: "tech", label: "Tech", detail: "Games with an observed opponent tier-3 technology building or unit." },
  { key: "air", label: "Air", detail: "Games with observed opponent combat or army-support air units; supply and scouting units are excluded." },
];

/** @param {unknown} value @returns {number|null} */
function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** @param {unknown} value @param {number} limit @returns {Row[]} */
function rows(value, limit = 512) {
  return Array.isArray(value) ? value.slice(0, limit).filter((row) => row && typeof row === "object") : [];
}

/** A negative observation requires coverage through the end of the game.
 * A positive observation is conclusive even if the retained timeline is short.
 * @param {Row[]} series @param {number|null} duration @returns {boolean} */
function coversGame(series, duration) {
  return duration !== null && duration > 0 && series.some((row) => {
    const time = nonnegative(row.time);
    return time !== null && time >= Math.max(0, duration - 30);
  });
}

/** @param {Row[]} bases @param {number|null} duration @returns {boolean|null} */
function expanded(bases, duration) {
  const valid = bases.filter((row) => BASES.has(row.name) && nonnegative(row.born_time) !== null);
  if (!valid.length) return null;
  // Checking every birth instant also handles bases lost before a later
  // expansion; morph lifetimes meeting at a boundary are not counted twice.
  for (const birth of valid) {
    if (duration !== null && birth.born_time > duration) continue;
    const active = valid.filter((base) => base.born_time <= birth.born_time
      && (nonnegative(base.died_time) === null || base.died_time > birth.born_time));
    if (active.length >= 2) return true;
  }
  return valid.some((row) => duration !== null && nonnegative(row.died_time) !== null && row.died_time >= duration - 1) ? false : null;
}

/**
 * A compact observation created while replay detail is already hydrated.
 * This is descriptive evidence, never an estimate of micro/macro skill.
 * Missing/incomplete channels remain unknown instead of becoming zeros.
 * @param {Row} game @returns {Tendencies}
 */
function computeOpponentTendencies(game) {
  const macro = game?.macroBreakdown || {};
  const duration = nonnegative(game?.durationSec);
  /** @param {Row} row */
  const inGame = (row) => nonnegative(row.time) !== null && (duration === null || row.time <= duration);
  const stats = rows(macro.opp_stats_events).filter((row) => inGame(row) && nonnegative(row.food_workers) !== null);
  // Every standard replay starts with workers. An all-zero legacy channel
  // cannot establish that the opponent actually stayed below the threshold.
  const hasWorkers = stats.some((row) => row.food_workers > 0);
  const economy = stats.some((row) => row.food_workers >= 60) ? true
    : hasWorkers && coversGame(stats, duration) ? false : null;
  const timeline = rows(macro.unit_timeline).filter((row) => inGame(row) && row.opp && typeof row.opp === "object"
    && Object.values(row.opp).some((n) => typeof n === "number" && n > 0));
  /** @param {Set<string>} names */
  const unitSeen = (names) => timeline.some((row) => Object.entries(row.opp)
    .some(([name, count]) => names.has(canonicalizeName(name)) && typeof count === "number" && count > 0));
  const air = unitSeen(COMBAT_AIR) ? true : coversGame(timeline, duration) ? false : null;
  const log = Array.isArray(game?.oppBuildLog) ? game.oppBuildLog.slice(0, 256) : [];
  const events = log.flatMap((line) => {
    if (typeof line !== "string") return [];
    const match = /^\[(\d{1,5}):([0-5]\d)\]\s+([A-Za-z0-9_ .'-]{1,128})\s*$/.exec(line);
    return match ? [{ time: Number(match[1]) * 60 + Number(match[2]), name: match[3] }] : [];
  });
  const validEvents = events.filter((event) => duration === null || event.time <= duration);
  const techSeen = validEvents.some((event) => T3_TECH.has(event.name) || T3_UNITS.has(event.name)) || unitSeen(T3_UNITS);
  // A capped or early-only log may omit a later tech transition, including
  // legacy migrated rows with fewer than 256 events. Require coverage near
  // game end before a negative; army snapshots cannot rule out tech buildings.
  const tech = techSeen ? true : log.length < 256 && coversGame(validEvents, duration) ? false : null;
  const baseRows = rows(macro.opp_bases, 200);
  const bases = baseRows.length ? baseRows : rows(macro.opp_production_buildings).filter((row) => BASES.has(row.name));
  return {
    earlyFinish: duration !== null && duration > 0 ? duration < 300 : null,
    expansion: expanded(bases, duration),
    economy,
    tech,
    air,
  };
}

/**
 * All axes are observed rates on their own explicitly reported denominator.
 * The caller has already scoped observations to the authenticated user's
 * opponent and cohort. This pure reducer never searches another user's data.
 * @param {Array<Tendencies|null|undefined>} observations
 * @param {{totalGames?:number|null,sampleLimit:number,sampled?:boolean}} options
 */
function computePlayerCard(observations, options) {
  const sample = observations.filter((observation) => observation && typeof observation === "object");
  const totalGames = nonnegative(options.totalGames);
  return {
    version: 1,
    sampleSize: sample.length,
    totalGames,
    sampleLimit: options.sampleLimit,
    sampled: options.sampled === true || (totalGames !== null && sample.length < totalGames),
    axes: AXES.map(({ key, label, detail }) => {
      const values = sample.map((observation) => /** @type {Row} */ (observation)[key]).filter((value) => typeof value === "boolean");
      const matches = values.filter(Boolean).length;
      return { key, label, value: values.length ? Math.round(matches / values.length * 1000) / 10 : null,
        matches, samples: values.length, detail };
    }),
  };
}

module.exports = { computeOpponentTendencies, computePlayerCard };
