"use strict";

/**
 * A reviewer's league in each region they play ranked 1v1 in (Replay
 * Review Exchange).
 *
 * Which accounts count comes from the reviewer's OWN synced games: the
 * toon handles they played ranked 1v1 on in the verification window.
 * Nothing is self-reported. For each of those accounts, the league is the
 * one Blizzard gave it this season, read from SC2Pulse. That is the only
 * way to know Grandmaster, which is a region's top 200 rather than an MMR
 * line. A region's games still verify the band their MMR reaches
 * (util/leagueBands.js), which covers the previous season and the times
 * SC2Pulse has no team or is down. The higher of the two wins.
 *
 * Pure functions only; ReviewerReputationService does the I/O.
 */

const { REVIEWS } = require("../config/constants");
const { bandFromId, bandFromMmr, approximateMmr, isPlausibleMmr } = require("../util/leagueBands");
const { regionFromToonHandle } = require("../util/regionFromToonHandle");
const { normalizeRace } = require("./reviewRedaction");

/** Region order for display, and the only regions a payload may carry. */
const REGION_ORDER = Object.freeze(["NA", "EU", "KR", "CN", "SEA"]);
/** Bound on the accounts looked up on SC2Pulse per verification. */
const MAX_LADDER_ACCOUNTS = 6;

/**
 * @typedef {{id: number, label: string}} Band
 * @typedef {{race: string, mmr: number, band: Band, games: number}} RaceBest
 * @typedef {{region: string, band: Band, race: string, mmr: number, games: number, source: "ladder" | "games"}} RegionLeague
 * @typedef {{region: string | null, race: string | null, leagueId: number | null, rating: number, games: number}} LadderTeam
 * @typedef {{byRace: Map<string, number[]>, toons: Map<string, number>}} RegionGames
 */

/**
 * Group the window's ranked 1v1 rows by race (every region together) and
 * by region, counting the games played on each account (toon handle).
 * Random and implausible rows are skipped. A row without a readable toon
 * handle (older agents) still counts toward its race.
 *
 * Example:
 *   groupLadderRows([{ myRace: "Protoss", myMmr: 5350, myToonHandle: "1-S2-1-267727" }])
 *   // -> byRace Protoss [5350]; byRegion NA: toons {"1-S2-1-267727" => 1}
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {{byRace: Map<string, number[]>, byRegion: Map<string, RegionGames>}}
 */
function groupLadderRows(rows) {
  /** @type {Map<string, number[]>} */
  const byRace = new Map();
  /** @type {Map<string, RegionGames>} */
  const byRegion = new Map();
  for (const row of rows) {
    const race = normalizeRace(row.myRace);
    if (!race || race === "Random" || !isPlausibleMmr(row.myMmr)) continue;
    const mmr = Number(row.myMmr);
    pushTo(byRace, race, mmr);
    const toon = typeof row.myToonHandle === "string" ? row.myToonHandle.trim() : "";
    const region = regionFromToonHandle(toon);
    if (!region) continue;
    const slot = byRegion.get(region) || { byRace: new Map(), toons: new Map() };
    pushTo(slot.byRace, race, mmr);
    slot.toons.set(toon, (slot.toons.get(toon) || 0) + 1);
    byRegion.set(region, slot);
  }
  return { byRace, byRegion };
}

/**
 * The band a set of games verifies. Per race with VERIFY_MIN_GAMES or
 * more games, it is the band of the race's VERIFY_BAND_SUPPORT-th best
 * game, so one outlier never verifies anyone upward. The highest band
 * wins, then the higher MMR.
 *
 * Example: 12 Terran games at 3800 plus one at 6900 → Diamond Terran.
 *
 * @param {Map<string, number[]>} byRace
 * @returns {RaceBest | null}
 */
function bestBandFromGames(byRace) {
  /** @type {RaceBest | null} */
  let best = null;
  for (const [race, mmrs] of byRace) {
    if (mmrs.length < REVIEWS.VERIFY_MIN_GAMES) continue;
    const supported = [...mmrs].sort((a, b) => b - a)[REVIEWS.VERIFY_BAND_SUPPORT - 1];
    const band = bandFromMmr(supported);
    if (!band) continue;
    const entry = { race, mmr: supported, band: { id: band.id, label: band.label }, games: mmrs.length };
    if (!best || isStronger(entry, best)) best = entry;
  }
  return best;
}

/**
 * The accounts to look up on SC2Pulse: toon handles behind at least
 * VERIFY_BAND_SUPPORT of the window's games, so a single misattributed
 * replay never lends anyone another account's league. Busiest first.
 *
 * @param {Map<string, RegionGames>} byRegion
 * @returns {string[]}
 */
function ladderAccounts(byRegion) {
  /** @type {Array<[string, number]>} */
  const accounts = [];
  for (const slot of byRegion.values()) {
    for (const [toon, games] of slot.toons) {
      if (games >= REVIEWS.VERIFY_BAND_SUPPORT) accounts.push([toon, games]);
    }
  }
  return accounts
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LADDER_ACCOUNTS)
    .map(([toon]) => toon);
}

/**
 * Each region's strongest current-season SC2Pulse team (highest league,
 * then rating), only for regions the reviewer's own games came from.
 *
 * @param {LadderTeam[]} teams
 * @param {Map<string, RegionGames>} byRegion
 * @returns {Map<string, RegionLeague>}
 */
function ladderLeaguesByRegion(teams, byRegion) {
  /** @type {Map<string, RegionLeague>} */
  const out = new Map();
  for (const team of teams) {
    const entry = ladderEntry(team, byRegion);
    if (!entry) continue;
    const current = out.get(entry.region);
    if (!current || isStronger(entry, current)) out.set(entry.region, entry);
  }
  return out;
}

/**
 * One SC2Pulse team as a region league, or null when the row is unusable
 * (no league, Random, no rating) or its region never appears in the
 * reviewer's own games.
 *
 * @param {LadderTeam} team
 * @param {Map<string, RegionGames>} byRegion
 * @returns {RegionLeague | null}
 */
function ladderEntry(team, byRegion) {
  const slot = typeof team.region === "string" ? byRegion.get(team.region) : undefined;
  const band = bandFromId(team.leagueId);
  const race = normalizeRace(team.race);
  const rating = Number(team.rating);
  if (!slot || !band || !race || race === "Random" || !Number.isFinite(rating)) return null;
  return {
    region: String(team.region),
    band: { id: band.id, label: band.label },
    race,
    mmr: rating,
    games: slot.byRace.get(race)?.length || 0,
    source: "ladder",
  };
}

/**
 * Each region's band from its own games (see ``bestBandFromGames``).
 *
 * @param {Map<string, RegionGames>} byRegion
 * @returns {Map<string, RegionLeague>}
 */
function gameLeaguesByRegion(byRegion) {
  /** @type {Map<string, RegionLeague>} */
  const out = new Map();
  for (const [region, slot] of byRegion) {
    const best = bestBandFromGames(slot.byRace);
    if (best) out.set(region, { region, ...best, source: "games" });
  }
  return out;
}

/**
 * One league per region, strongest first. SC2Pulse's league wins unless
 * the region's games verify a higher band.
 *
 * Example: NA ladder Grandmaster vs NA games Master → NA Grandmaster.
 *
 * @param {Map<string, RegionLeague>} ladder
 * @param {Map<string, RegionLeague>} games
 * @returns {RegionLeague[]}
 */
function mergeRegionLeagues(ladder, games) {
  const merged = new Map(games);
  for (const [region, entry] of ladder) {
    const fromGames = merged.get(region);
    if (!fromGames || entry.band.id >= fromGames.band.id) merged.set(region, entry);
  }
  return [...merged.values()].sort((a, b) => (isStronger(a, b) ? -1 : isStronger(b, a) ? 1 : regionRank(a) - regionRank(b)));
}

/**
 * Regions as stored on ``users.reviewer.verified``: MMR rounded like the
 * top-level figure.
 *
 * @param {RegionLeague[]} regions
 */
function storedRegions(regions) {
  return regions.map((r) => ({
    region: r.region,
    band: r.band,
    race: r.race,
    mmr: approximateMmr(r.mmr),
    games: r.games,
    source: r.source,
  }));
}

/**
 * The public facts of each region's league: region, band and race. Rows
 * with an unknown region or band, and repeated regions, are dropped.
 *
 * @param {unknown} raw
 * @returns {Array<{region: string, band: Band, race: string | null}>}
 */
function publicRegions(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{region: string, band: Band, race: string | null}>} */
  const out = [];
  for (const entry of raw.slice(0, REGION_ORDER.length)) {
    const region = REGION_ORDER.includes(entry?.region) ? entry.region : null;
    const band = bandFromId(entry?.band?.id);
    if (!region || !band || out.some((r) => r.region === region)) continue;
    out.push({ region, band: { id: band.id, label: band.label }, race: normalizeRace(entry.race) });
  }
  return out;
}

/**
 * @param {{band: Band, mmr: number}} a
 * @param {{band: Band, mmr: number}} b
 * @returns {boolean} true when ``a`` is a higher band, or the same band at a higher MMR.
 */
function isStronger(a, b) {
  return a.band.id > b.band.id || (a.band.id === b.band.id && a.mmr > b.mmr);
}

/** @param {{region: string}} entry */
function regionRank(entry) {
  const i = REGION_ORDER.indexOf(entry.region);
  return i === -1 ? REGION_ORDER.length : i;
}

/**
 * @param {Map<string, number[]>} map
 * @param {string} key
 * @param {number} value
 */
function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

module.exports = {
  REGION_ORDER,
  MAX_LADDER_ACCOUNTS,
  groupLadderRows,
  bestBandFromGames,
  ladderAccounts,
  ladderLeaguesByRegion,
  gameLeaguesByRegion,
  mergeRegionLeagues,
  storedRegions,
  publicRegions,
  isStronger,
};
