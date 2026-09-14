"use strict";

const {
  STRUCTURE_MORPHS, STRUCTURE_BUILD_SECONDS, UNIT_BUILD_SECONDS,
  UPGRADE_BUILD_SECONDS, isFinishTimeEvent,
} = require("./buildDurations");

const DETAIL_VERSION = 1;
const { randomUUID } = require("crypto");
const CHECKPOINTS = Object.freeze([300, 480, 720]);
const MAX_SNAPSHOT_AGE_SEC = 30;
const DETAIL_READ_FIELDS = Object.freeze([
  "buildLog", "macroBreakdown.bases", "macroBreakdown.stats_events",
  "macroBreakdown.opp_stats_events", "macroBreakdown.player_stats",
]);
const BASE_NAMES = new Set([
  "Nexus", "Hatchery", "Lair", "Hive", "CommandCenter", "OrbitalCommand",
  "PlanetaryFortress", "CommandCenterFlying", "OrbitalCommandFlying",
]);
const CATALOG = new Map(Object.keys({
  ...STRUCTURE_BUILD_SECONDS, ...STRUCTURE_MORPHS,
  ...UNIT_BUILD_SECONDS, ...UPGRADE_BUILD_SECONDS,
}).map((name) => [name.toLowerCase(), name]));

/** @param {unknown} value @returns {value is number} */
function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Compact, deterministic facts only. Building log timestamps describe starts,
 * while units, morphs and upgrades describe completion. Preserve the stored
 * timestamp and name its meaning; subtracting a modern balance duration would
 * invent historical precision and ignore accelerated research/production.
 * Missing branches remain absent so partial recomputes can patch independently.
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
function extractDetailSummary(fields) {
  /** @type {Record<string, any>} */
  const summary = { version: DETAIL_VERSION };
  if (Object.prototype.hasOwnProperty.call(fields, "buildLog")) {
    /** @type {Map<string, number>} */
    const first = new Map();
    for (const line of Array.isArray(fields.buildLog) ? fields.buildLog : []) {
      if (typeof line !== "string") continue;
      const match = /^\[(\d{1,4}):([0-5]\d)\]\s+([A-Za-z][A-Za-z0-9]*)\s*$/.exec(line);
      if (!match) continue;
      const name = CATALOG.get(match[3].toLowerCase());
      const sec = Number(match[1]) * 60 + Number(match[2]);
      if (!name || sec > 86400) continue;
      const id = `first:${name}`;
      first.set(id, Math.min(first.get(id) ?? Infinity, sec));
    }
    summary.build = {
      available: Array.isArray(fields.buildLog) && fields.buildLog.length > 0,
      milestones: [...first].sort(([a], [b]) => a.localeCompare(b)).map(([id, sec]) => ({ id, sec })),
    };
  }
  if (Object.prototype.hasOwnProperty.call(fields, "macroBreakdown")) {
    const macro = fields.macroBreakdown || {};
    summary.bases = extractBases(macro.bases);
    summary.leads = extractLeads(macro.stats_events, macro.opp_stats_events);
    /** @param {unknown} value */
    const rating = (value) => typeof value === "number" && Number.isInteger(value) && value >= 500 && value <= 9999 ? value : null;
    summary.ratings = {
      myMmr: rating(macro.player_stats?.me?.mmr),
      opponentMmr: rating(macro.player_stats?.opponent?.mmr),
    };
  }
  return summary;
}

/** Atomic dotted-field patches preserve a branch during unrelated recomputes.
 * @param {Record<string, any>} fields @returns {Record<string, any>} */
function detailSummaryUpdate(fields) {
  const summary = extractDetailSummary(fields);
  if (Object.keys(summary).length === 1) return {};
  return {
    ...Object.fromEntries(Object.entries(summary).map(([key, value]) => [`trendsExplorerDetail.${key}`, value])),
    trendsExplorerRevision: randomUUID(),
  };
}

/** @param {unknown} input */
function extractBases(input) {
  const available = Array.isArray(input) && input.length > 0;
  /** @type {Map<string, {start:number,end:number}>} */
  const unique = new Map();
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || !BASE_NAMES.has(item.name) || !nonnegative(item.born_time)) continue;
    // Tracker identity prevents a Hatchery/Lair/Hive or CC/Orbital morph
    // from becoming a fictitious extra base. An unidentified legacy lifetime
    // cannot establish that distinction reliably.
    if (!(["string", "number"].includes(typeof item.unit_id)) || String(item.unit_id) === "") continue;
    const key = String(item.unit_id);
    const start = item.born_time;
    const end = nonnegative(item.died_time) ? item.died_time : Infinity;
    if (end < start) continue;
    const old = unique.get(key);
    unique.set(key, { start: Math.min(old?.start ?? Infinity, start), end: Math.max(old?.end ?? -Infinity, end) });
  }
  const lifetimes = [...unique.values()];
  /** @type {Array<{id:string,sec:number}>} */
  const milestones = [];
  // Require evidence of the starting base. Otherwise a partial tracker stream
  // with only late expansions would silently shift "second" into "third".
  if (lifetimes.some((base) => base.start <= 15)) {
    for (const [count, id] of [[2, "second-base"], [3, "third-base"]]) {
      const time = lifetimes.map((base) => base.start).sort((a, b) => a - b).find((at) => (
        at > 15 && lifetimes.filter((base) => base.start <= at && base.end > at).length >= Number(count)
      ));
      if (time !== undefined) milestones.push({ id: String(id), sec: time });
    }
  }
  return { available, milestones };
}

/** @param {unknown} own @param {unknown} opponent */
function extractLeads(own, opponent) {
  /** @type {Map<number, any>} */
  const my = new Map();
  /** @type {Map<number, any>} */
  const opp = new Map();
  for (const [input, target] of [[own, my], [opponent, opp]]) {
    for (const event of Array.isArray(input) ? input : []) {
      if (event && nonnegative(event.time) && event.time <= 86400) {
        /** @type {Map<number, any>} */ (target).set(event.time, event);
      }
    }
  }
  const commonTimes = [...my.keys()].filter((time) => opp.has(time)).sort((a, b) => b - a);
  /** @type {Array<{second:number,at:number,workers:[number,number]|null,army:[number,number]|null}>} */
  const snapshots = [];
  for (const second of CHECKPOINTS) {
    // Both players must have a real observation at the SAME tracker tick.
    // Never carry the last sample across an extended gap, interpolate, or use
    // a future post-fight observation to classify the earlier position.
    const at = commonTimes.find((time) => time <= second && second - time <= MAX_SNAPSHOT_AGE_SEC);
    if (at === undefined) continue;
    const mine = my.get(at);
    const theirs = opp.get(at);
    /** @param {string} field @returns {[number, number]|null} */
    const pair = (field) => nonnegative(mine[field]) && nonnegative(theirs[field])
      ? [mine[field], theirs[field]] : null;
    const workers = pair("food_workers");
    const army = pair("army_value");
    if (workers || army) snapshots.push({ second, at, workers, army });
  }
  return { available: my.size > 0 && opp.size > 0, snapshots };
}

/** @param {string} id */
function milestoneLabel(id) {
  if (id === "second-base") return "Second base operational";
  if (id === "third-base") return "Third base operational";
  const name = id.startsWith("first:") ? id.slice(6) : id;
  const display = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/Level(\d)/g, "Level $1");
  return `First ${display} ${isFinishTimeEvent(name) ? "completed" : "started"}`;
}

/** @param {any} record */
function gameKey(record) { return record.gameKey || `${record.userId}|${record.gameId}`; }
/** @param {any} record */
function playerKey(record) { return record.playerId || record.userId || "unknown"; }
/** @param {any} record */
function outcome(record) {
  const result = String(record.result || "").toLowerCase();
  return result === "victory" || result === "win" ? 1 : result === "defeat" || result === "loss" ? 0 : null;
}
/** @param {any} record @param {string} interval */
function dateBucket(record, interval) {
  const date = new Date(record.date);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCHours(0, 0, 0, 0);
  if (interval === "month") date.setUTCDate(1);
  else if (interval !== "day") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
/** @param {Array<{record:any,value:number}>} samples @param {boolean} equalPlayers */
function weightedSamples(samples, equalPlayers) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const sample of samples) counts.set(playerKey(sample.record), (counts.get(playerKey(sample.record)) || 0) + 1);
  return samples.map((sample) => ({ ...sample, weight: equalPlayers ? 1 / (counts.get(playerKey(sample.record)) || 1) : 1 }));
}
/** @param {Array<{value:number,weight:number}>} samples @param {number} proportion */
function percentile(samples, proportion) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const target = sorted.reduce((sum, sample) => sum + sample.weight, 0) * proportion;
  let weight = 0;
  for (const sample of sorted) { weight += sample.weight; if (weight >= target) return sample.value; }
  return sorted[sorted.length - 1].value;
}

/** @param {string} key @param {string} label @param {Array<{record:any,value:number}>} samples @param {boolean} equalPlayers */
function summarize(key, label, samples, equalPlayers) {
  const weighted = weightedSamples(samples, equalPlayers);
  const decided = weighted.filter((sample) => outcome(sample.record) !== null);
  const wins = weighted.filter((sample) => outcome(sample.record) === 1);
  const losses = weighted.filter((sample) => outcome(sample.record) === 0);
  const decidedWeights = weightedSamples(decided, equalPlayers);
  const denominator = decidedWeights.reduce((sum, sample) => sum + sample.weight, 0);
  return {
    key, label, games: samples.length, wins: wins.length, losses: losses.length,
    decided: decided.length,
    winRate: denominator ? decidedWeights.reduce((sum, sample) => sum + (outcome(sample.record) === 1 ? sample.weight : 0), 0) / denominator : null,
    players: new Set(samples.map((sample) => playerKey(sample.record))).size,
    gameKeys: samples.map((sample) => gameKey(sample.record)),
    medianSec: percentile(weighted, 0.5), p25Sec: percentile(weighted, 0.25), p75Sec: percentile(weighted, 0.75),
    winMedianSec: percentile(wins, 0.5), lossMedianSec: percentile(losses, 0.5),
  };
}

/**
 * Shared personal/global analysis. Callers apply the normal race, map, build,
 * date and selected-player filters first. The counts are always real game
 * counts; optional player weighting changes rates/distributions only.
 * @param {string} view
 * @param {any[]} records
 * @param {Record<string, any>} [options]
 */
function analyzeDetail(view, records, options = {}) {
  const equalPlayers = options.weight === "players";
  const detailed = records.filter((record) => record.trendsExplorerDetail?.version === DETAIL_VERSION);
  const notes = [];
  if (view === "execution") {
    const milestone = options.milestone || "third-base";
    let interval = options.interval || "auto";
    if (interval === "auto") {
      let first = Infinity;
      let last = -Infinity;
      for (const record of records) {
        const time = new Date(record.date).getTime();
        if (!Number.isFinite(time)) continue;
        first = Math.min(first, time);
        last = Math.max(last, time);
      }
      interval = last - first > 180 * 86400000 ? "month" : "week";
    }
    const available = new Set(["second-base", "third-base"]);
    /** @type {Map<string, Array<{record:any,value:number}>>} */
    const groups = new Map();
    let eligibleGames = 0;
    let sourceGames = 0;
    for (const record of detailed) {
      const detail = record.trendsExplorerDetail;
      const all = [...(detail.build?.milestones || []), ...(detail.bases?.milestones || [])];
      for (const item of all) available.add(item.id);
      if ((milestone.startsWith("first:") ? detail.build : detail.bases)?.available) sourceGames += 1;
      const value = all.find((item) => item.id === milestone)?.sec;
      if (!nonnegative(value)) continue;
      const bucket = dateBucket(record, interval);
      if (!bucket) continue;
      eligibleGames += 1;
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket)?.push({ record, value });
    }
    notes.push("Only observed milestones are included; an absent milestone is not a zero-second execution.");
    notes.push(`${interval === "month" ? "Monthly" : interval === "day" ? "Daily" : "Weekly"} timing distributions use UTC calendar boundaries.`);
    notes.push(milestone.endsWith("-base")
      ? "Base timings require distinct tracker identities and count simultaneously operational bases, excluding town-hall morphs and replacements after a loss."
      : "Timings preserve recorded replay events: ordinary buildings start; units, upgrades and building morphs complete. No estimated production duration is subtracted.");
    return {
      rows: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, samples]) => summarize(key, key, samples, equalPlayers)),
      eligibleGames, sourceGames, detailedGames: detailed.length,
      options: { milestone, interval, milestones: [...available].sort().map((id) => ({ id, label: milestoneLabel(id) })) },
      notes,
    };
  }
  const checkpoint = CHECKPOINTS.includes(Number(options.checkpoint)) ? Number(options.checkpoint) : 480;
  const metric = options.metric === "army" ? "army" : "workers";
  const tolerance = metric === "army" ? 250 : 3;
  /** @type {Map<string, Array<{record:any,value:number}>>} */
  const groups = new Map([ ["behind", []], ["even", []], ["ahead", []] ]);
  let sourceGames = 0;
  let reachedCheckpoint = 0;
  for (const record of detailed) {
    const isDuel = record.matchFormat === "1v1"
      || (!record.matchFormat && record.playerCount === 2);
    const knownRace = /^(?:protoss|terran|zerg|p|t|z)$/i;
    if (!isDuel || !knownRace.test(record.myRace || "")
      || !knownRace.test(record.opponent?.race || record.oppRace || "")) continue;
    const duration = record.durationSec ?? record.duration;
    if (!nonnegative(duration) || duration < checkpoint) continue;
    reachedCheckpoint += 1;
    if (record.trendsExplorerDetail.leads?.available) sourceGames += 1;
    const snapshot = record.trendsExplorerDetail.leads?.snapshots?.find((/** @type {any} */ item) => item.second === checkpoint);
    const pair = snapshot?.[metric];
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(nonnegative)) continue;
    const value = pair[0] - pair[1];
    const group = value < -tolerance ? "behind" : value > tolerance ? "ahead" : "even";
    groups.get(group)?.push({ record, value });
  }
  const label = metric === "army" ? "army value" : "workers";
  /** @type {Record<string, string>} */
  const labels = { behind: `Behind (more than ${tolerance} ${label})`, even: `Even (within ${tolerance} ${label})`, ahead: `Ahead (more than ${tolerance} ${label})` };
  const rows = [...groups].map(([key, samples]) => {
    const row = summarize(key, labels[key], samples, equalPlayers);
    const { medianSec, p25Sec, p75Sec, winMedianSec, lossMedianSec, ...counts } = row;
    return { ...counts, medianGap: medianSec };
  });
  notes.push(`Uses paired observations at the same tracker tick, at or up to ${MAX_SNAPSHOT_AGE_SEC} seconds before ${checkpoint / 60}:00. Missing, stale and future observations are excluded.`);
  notes.push("Only verified 1v1 games with known spawned races and a duration reaching the checkpoint qualify. Position is measured by the selected statistic, not an assessment of which player should win.");
  if (metric === "army") notes.push("Army value is the replay's active-forces mineral plus gas value; supply units can contribute to this statistic.");
  return {
    rows, eligibleGames: rows.reduce((sum, row) => sum + row.games, 0),
    sourceGames, reachedCheckpoint, detailedGames: detailed.length,
    options: { checkpoint, metric, tolerance }, notes,
  };
}

module.exports = {
  DETAIL_VERSION, DETAIL_READ_FIELDS, CHECKPOINTS, MAX_SNAPSHOT_AGE_SEC,
  extractDetailSummary, detailSummaryUpdate, analyzeDetail, milestoneLabel,
};
