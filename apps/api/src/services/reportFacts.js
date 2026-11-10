"use strict";

/**
 * Pure fact builders shared by the weekly and stream reports. Every value
 * is a count, a record or a measured number; nothing here explains a
 * result. Comparisons carry their sample sizes, and "best"/"worst" rows
 * exist only above the decided-games floor.
 */

const MIN_DECIDED = 3;
const MIN_MACRO = 3;

/** @param {unknown} race */
function raceLetter(race) {
  const letter = typeof race === "string" ? race.trim().charAt(0).toUpperCase() : "";
  return ["P", "T", "Z", "R"].includes(letter) ? letter : "?";
}

/** @param {any} row */
function matchupOf(row) { return `${raceLetter(row.myRace)}v${raceLetter(row.opponent?.race)}`; }

/** @param {any} row @returns {"win"|"loss"|null} */
function outcome(row) { return row.result === "Victory" ? "win" : row.result === "Defeat" ? "loss" : null; }

/** @param {any[]} rows */
function record(rows) {
  let wins = 0; let losses = 0;
  for (const row of rows) { const o = outcome(row); if (o === "win") wins += 1; else if (o === "loss") losses += 1; }
  return { games: rows.length, wins, losses };
}

/**
 * Records grouped by a key, largest sample first.
 * @param {any[]} rows @param {(row: any) => string|null} keyOf @param {number} limit
 */
function groupRecords(rows, keyOf, limit) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(row); groups.set(key, list);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, ...record(list) }))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * Best and worst by win rate among keys with at least MIN_DECIDED decided
 * games. Worst is omitted when only one key qualifies.
 * @param {any[]} rows @param {(row: any) => string|null} keyOf
 */
function bestAndWorst(rows, keyOf) {
  const qualified = groupRecords(rows, keyOf, 200).filter((row) => row.wins + row.losses >= MIN_DECIDED)
    .map((row) => ({ ...row, rate: row.wins / (row.wins + row.losses) }));
  if (!qualified.length) return { best: null, worst: null, minDecided: MIN_DECIDED };
  const sorted = [...qualified].sort((a, b) => b.rate - a.rate || (b.wins + b.losses) - (a.wins + a.losses));
  const strip = (/** @type {any} */ row) => ({ name: row.name, games: row.games, wins: row.wins, losses: row.losses });
  return { best: strip(sorted[0]), worst: sorted.length > 1 ? strip(sorted[sorted.length - 1]) : null, minDecided: MIN_DECIDED };
}

/** @param {unknown} value @param {number} max */
function cleanName(value, max = 80) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null : null;
}

const REGIONS = /** @type {Record<string, string>} */ ({ 1: "Americas", 2: "Europe", 3: "Korea", 5: "China", 6: "SEA" });

/**
 * MMR readings per account and race, in play order, largest first.
 * @param {any[]} rows sorted by date ascending
 */
function mmrSeries(rows) {
  /** @type {Map<string, {account: string, race: string, values: number[]}>} */
  const groups = new Map();
  for (const row of rows) {
    if (typeof row.myMmr !== "number" || !Number.isFinite(row.myMmr) || row.myMmr <= 0) continue;
    const handle = typeof row.myToonHandle === "string" ? row.myToonHandle : "";
    const key = `${handle}|${raceLetter(row.myRace)}`;
    const entry = groups.get(key) || { account: REGIONS[handle.split("-")[0]] || "Account", race: String(row.myRace || "").slice(0, 12), values: [] };
    entry.values.push(Math.round(row.myMmr)); groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.values.length - a.values.length);
}

/** Start/end/peak per account and race (top four). @param {any[]} rows sorted by date ascending */
function mmrByAccount(rows) {
  return mmrSeries(rows).slice(0, 4).map((entry) => ({
    account: entry.account, race: entry.race, games: entry.values.length,
    start: entry.values[0], end: entry.values[entry.values.length - 1], peak: Math.max(...entry.values),
    delta: entry.values[entry.values.length - 1] - entry.values[0],
  }));
}

/** Average macro score and the most frequent leak, each with its sample. @param {any[]} rows */
function macroFacts(rows) {
  const scored = rows.filter((row) => typeof row.macroScore === "number" && Number.isFinite(row.macroScore));
  /** @type {Map<string, number>} */
  const leaks = new Map();
  for (const row of rows) for (const leak of Array.isArray(row.top3Leaks) ? row.top3Leaks : []) {
    const name = cleanName(leak?.name, 60);
    if (name) leaks.set(name, (leaks.get(name) || 0) + 1);
  }
  const top = [...leaks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    average: scored.length >= MIN_MACRO ? Math.round(scored.reduce((sum, row) => sum + row.macroScore, 0) / scored.length * 10) / 10 : null,
    games: scored.length,
    topLeak: top && top[1] >= MIN_MACRO ? { name: top[0], games: top[1] } : null,
  };
}

/** Count of play sessions separated by more than ``gapMinutes``. @param {any[]} rows sorted ascending @param {number} gapMinutes */
function sessionCount(rows, gapMinutes) {
  let count = 0; let last = -Infinity;
  for (const row of rows) {
    const t = new Date(row.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (t - last > gapMinutes * 60_000) count += 1;
    last = t;
  }
  return count;
}

/** @param {any[]} rows */
function hoursPlayed(rows) {
  const seconds = rows.reduce((sum, row) => sum + (typeof row.durationSec === "number" && row.durationSec > 0 ? row.durationSec : 0), 0);
  return Math.round(seconds / 360) / 10;
}

/** @param {number} delta */
function signed(delta) { return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}`; }

module.exports = { MIN_DECIDED, MIN_MACRO, raceLetter, matchupOf, outcome, record, groupRecords, bestAndWorst, cleanName, mmrSeries, mmrByAccount, macroFacts, sessionCount, hoursPlayed, signed };
