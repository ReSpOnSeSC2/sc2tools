"use strict";

// Read-time bounds for detail objects written before strict ingest validation
// existed. These helpers deep-copy only fields consumed by phase/timing/scouting
// analysis, so a small retained sample cannot keep a giant legacy backing
// object alive.
const BUILD_LOG_MAX_LINES = 256;
const BUILD_LOG_PREFIX_CHARS = 256;
const BUILD_LOG_LINE_RE =
  /^\[(\d{1,5}):([0-5]\d)\]\s+([A-Za-z0-9_ .'-]{1,128})/;
const MACRO_STATS_MAX = 512;
const MACRO_TIMELINE_MAX = 512;
const MACRO_LIFETIMES_MAX = 512;
const MACRO_BASES_MAX = 200;
const TIMELINE_SIDE_KEYS_MAX = 64;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function compactAnalysisBuildLog(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const limit = Math.min(value.length, BUILD_LOG_MAX_LINES);
  for (let i = 0; i < limit; i += 1) {
    const raw = value[i];
    if (typeof raw !== "string") continue;
    const match = BUILD_LOG_LINE_RE.exec(raw.slice(0, BUILD_LOG_PREFIX_CHARS));
    if (!match) continue;
    // Force a copy: V8 may otherwise retain a small slice/capture as a view
    // over a multi-megabyte legacy string.
    const name = Buffer.from(match[3].trim(), "utf8").toString("utf8");
    out.push(`[${Number(match[1])}:${match[2]}] ${name}`);
  }
  return out;
}

/** @param {unknown} value @param {number} max */
function safeString(value, max) {
  if (typeof value !== "string") return "";
  return Buffer.from(value.slice(0, max), "utf8").toString("utf8");
}

/** @param {unknown} value */
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value @param {number} max */
function compactLifetimes(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const limit = Math.min(value.length, max);
  for (let i = 0; i < limit; i += 1) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    out.push({
      name: safeString(row.name, 64),
      born_time: finiteNumber(row.born_time),
      died_time: finiteNumber(row.died_time),
      destroyed: row.destroyed === true,
    });
  }
  return out;
}

/** @param {unknown} value */
function compactStats(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const limit = Math.min(value.length, MACRO_STATS_MAX);
  for (let i = 0; i < limit; i += 1) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    out.push({
      time: finiteNumber(row.time),
      food_workers: finiteNumber(row.food_workers),
      food_used: finiteNumber(row.food_used),
      army_value: finiteNumber(row.army_value),
    });
  }
  return out;
}

/** @param {unknown} value */
function compactUnitBag(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const source = /** @type {Record<string, unknown>} */ (value);
  let inspected = 0;
  for (const rawKey in source) {
    if (!Object.prototype.hasOwnProperty.call(source, rawKey)) continue;
    inspected += 1;
    if (inspected > TIMELINE_SIDE_KEYS_MAX) break;
    const key = safeString(rawKey, 64);
    if (!key) continue;
    const count = finiteNumber(source[rawKey]);
    if (count > 0) out[key] = count;
  }
  return out;
}

/** @param {unknown} value */
function compactTimeline(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const limit = Math.min(value.length, MACRO_TIMELINE_MAX);
  for (let i = 0; i < limit; i += 1) {
    const row = value[i];
    if (!row || typeof row !== "object") continue;
    out.push({
      time: finiteNumber(row.time),
      my: compactUnitBag(row.my),
      opp: compactUnitBag(row.opp),
    });
  }
  return out;
}

/**
 * Deep allow-list clone for the only macro fields phase/scouting uses.
 * @param {unknown} value
 */
function compactAnalysisMacroBreakdown(value) {
  const raw = /** @type {Record<string, any>} */ (
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {}
  );
  return {
    bases: compactLifetimes(raw.bases, MACRO_BASES_MAX),
    opp_bases: compactLifetimes(raw.opp_bases, MACRO_BASES_MAX),
    production_buildings: compactLifetimes(
      raw.production_buildings,
      MACRO_LIFETIMES_MAX,
    ),
    opp_production_buildings: compactLifetimes(
      raw.opp_production_buildings,
      MACRO_LIFETIMES_MAX,
    ),
    stats_events: compactStats(raw.stats_events),
    opp_stats_events: compactStats(raw.opp_stats_events),
    unit_timeline: compactTimeline(raw.unit_timeline),
  };
}

module.exports = {
  compactAnalysisBuildLog,
  compactAnalysisMacroBreakdown,
};
