"use strict";

const { eraForGame } = require("../util/patchEra");
const { validateCasualtyEvents } = require("../validation/casualtyEvents");
const UNIT_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RACES = new Map([["Protoss", "P"], ["Terran", "T"], ["Zerg", "Z"]]);
const TRADE_PREVIEW_SIZE = 25;

/** @param {unknown} version */
function hasTradeEngine(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return false;
  const [major, minor, patch] = version.split(/[+-]/, 1)[0].split(".").map(Number);
  return major > 1 || major === 1 && (minor > 6 || minor === 6 && patch >= 13);
}

/**
 * Keep only type/count aggregates. No replay IDs, player names, or positions
 * belong in this report. A pathological replay is excluded as a whole.
 * @param {Record<string, any>} game @param {any} breakdown
 */
function compactTradeReplay(game, breakdown) {
  const deaths = breakdown?.casualty_events;
  const own = RACES.get(game.myRace), opponent = RACES.get(game.opponent?.race);
  if (!own || !opponent || !validateCasualtyEvents(deaths)
    || !deaths.some((/** @type {any} */ row) => row.killerUnit || row.bornAt !== undefined)) return null;
  /** @type {Map<string, number>} */ const losses = new Map();
  /** @type {Map<string, {unit: string, target: string, count: number}>} */ const kills = new Map();
  for (const row of deaths) {
    if (row.category === "buildings" || !UNIT_TOKEN.test(row.name)) continue;
    if (row.owner === "me") {
      losses.set(row.name, (losses.get(row.name) ?? 0) + 1);
    } else if (row.killer === "me" && typeof row.killerUnit === "string" && UNIT_TOKEN.test(row.killerUnit)) {
      const key = `${row.killerUnit}:${row.name}`;
      const prior = kills.get(key);
      if (prior) prior.count++;
      else kills.set(key, { unit: row.killerUnit, target: row.name, count: 1 });
    }
    if (losses.size > 128 || kills.size > 128) return null;
  }
  return { matchup: `${own}v${opponent}`, era: eraForGame(game),
    losses: [...losses].map(([unit, count]) => ({ unit, count })), kills: [...kills.values()] };
}

/** @param {Array<Record<string, any>>} games */
function tradeSample(games) {
  return { selected: games.length, replays: games.flatMap(game => game.tradeSample ? [game.tradeSample] : []) };
}

module.exports = { compactTradeReplay, tradeSample, hasTradeEngine, TRADE_PREVIEW_SIZE };
