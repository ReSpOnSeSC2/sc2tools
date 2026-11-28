"use strict";

/**
 * The ladder VOD finder's Map menu. SC2Pulse has no map-list endpoint, so the
 * ids come from its own match feed: a short seed (the pool when this was
 * written) plus any map the feed shows later. The live 1v1 pool (Liquipedia,
 * `ladderMapPool.js`) decides which of them are offered, so a rotation
 * retires and adds maps without a code change.
 */

/** @typedef {{ id: number, name: string }} MapChoice */

/** @type {readonly MapChoice[]} */
const SEED_MAPS = [
  { id: 55370, name: "Lockdown" },
  { id: 55371, name: "Sanctuary III" },
  { id: 55372, name: "Rainfall" },
  { id: 55373, name: "Blackrock" },
  { id: 55374, name: "Old Sun Temple" },
  { id: 55375, name: "Fear and Faith" },
  { id: 55376, name: "At Eternity's Edge" },
  { id: 55377, name: "Washout" },
  { id: 55378, name: "Rorschach" },
];

/** "Blackrock LE" and "Blackrock" are the same map. @param {string} name */
function plainMapName(name) {
  return name.replace(/\s+(LE|CE)$/i, "").trim();
}

/**
 * @param {ReadonlyMap<number, string>} learned maps the match feed showed, by id
 * @param {readonly string[] | null | undefined} poolNames the live 1v1 pool; absent keeps every known map
 * @returns {MapChoice[]} the maps to offer, by name
 */
function buildMapMenu(learned, poolNames) {
  /** @type {Map<number, MapChoice>} */
  const known = new Map(SEED_MAPS.map(entry => [entry.id, entry]));
  learned.forEach((name, id) => { if (!known.has(id)) known.set(id, { id, name }); });
  const all = [...known.values()];
  const live = new Set((poolNames ?? []).map(name => plainMapName(name).toLowerCase()));
  const offered = live.size > 0 ? all.filter(entry => live.has(entry.name.toLowerCase())) : all;
  return (offered.length > 0 ? offered : all).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { SEED_MAPS, plainMapName, buildMapMenu };
