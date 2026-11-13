"use strict";

const { LEAGUES } = require("./pulseBalanceSummary");

const REGIONS = /** @type {const} */ (["US", "EU", "KR"]);
const LADDER_QUEUE = 201;
const ARRANGED = 0;
const TIER_NAMES = ["FIRST", "SECOND", "THIRD"];
const RACE_PAIRS = new Map([
  ["PROTOSS/TERRAN", { matchup: "PvT", reverse: false }],
  ["ZERG/PROTOSS", { matchup: "PvZ", reverse: true }],
  ["TERRAN/ZERG", { matchup: "TvZ", reverse: false }],
]);
const RANDOM_PAIRS = new Set(["RANDOM/TERRAN", "RANDOM/PROTOSS", "RANDOM/ZERG"]);
const DURATION_MAXIMA = [4, 5, 6, 7, 8, 9, 11, 14, 19, 29];
const TIER_REQUESTS = LEAGUES.flatMap((league, leagueId) => {
  const tiers = league === "grandmaster" ? TIER_NAMES.slice(0, 1) : TIER_NAMES;
  return tiers.map((tier, tierId) => ({
    league, leagueId, tier, tierId, division: league === "grandmaster" ? null : tierId + 1,
  }));
});

/** @typedef {typeof TIER_REQUESTS[number]} TierRequest */
/** @typedef {typeof REGIONS[number]} Region */
/** @typedef {typeof import("./pulseBalanceSummary").MATCHUPS[number]} Matchup */
/** @typedef {{matchup: Matchup, mapId: number, map: string, region: Region, crossTier: boolean,
 * duration: number, wins: number, games: number}} Cell */
/** @typedef {{region: Region, minRating: number, maxRating: number}} Bounds */
/** @typedef {{league: TierRequest["league"], division: TierRequest["division"], rows: Cell[], bounds: Bounds[]}} TierCube */
/** @typedef {{mapId:number,map:string,region:Region,spec:{matchup:Matchup,reverse:boolean}|null,
 * crossTier:boolean,minutes:Set<number|null>}} Film */

/** @param {string} field */
function invalid(field) {
  return Object.assign(new TypeError("Invalid SC2Pulse balance " + field), {
    code: "pulse_balance_invalid_source", reason: field.replaceAll(" ", "_"),
  });
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
function record(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(field);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} field */
function count(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(field);
  return value;
}

/** @param {unknown} value @param {string} field */
function dictionary(value, field) {
  /** @type {Map<number,Record<string,unknown>>} */
  const output = new Map();
  for (const [key, valueRow] of Object.entries(record(value, field))) {
    const row = record(valueRow, field);
    const id = count(row.id, field);
    if (id === 0 || key !== String(id)) throw invalid(field);
    output.set(id, row);
  }
  if (!output.size) throw invalid(field);
  return output;
}

/** @param {Map<number,Record<string, unknown>>} map @param {unknown} id @param {string} field */
function lookup(map, id, field) {
  const row = map.get(count(id, field));
  if (!row) throw invalid(field);
  return row;
}

/** @param {Map<number,Record<string,unknown>>} rows @param {number} season */
function validateRegions(rows, season) {
  const regions = new Set();
  for (const row of rows.values()) {
    if (row.battlenetId !== season || !isRegion(row.region) || regions.has(row.region)) {
      throw invalid("season region");
    }
    regions.add(row.region);
  }
  if (regions.size !== REGIONS.length) throw invalid("season coverage");
}

/** @param {unknown} value @returns {value is Region} */
function isRegion(value) {
  return REGIONS.some(region => region === value);
}

/** @param {Map<number,Record<string,unknown>>} specs */
function matchupSpecs(specs) {
  /** @type {Map<number,{matchup:Matchup,reverse:boolean}|null>} */
  const output = new Map();
  const seen = new Set();
  for (const [id, row] of specs) {
    const pair = row.race + "/" + row.versusRace;
    if (row.frameDuration !== "PT1M" || seen.has(pair)) throw invalid("matchup spec");
    seen.add(pair);
    const spec = RACE_PAIRS.get(pair);
    if (!spec && !RANDOM_PAIRS.has(pair)) throw invalid("race orientation");
    output.set(id, spec ? /** @type {{matchup: Matchup, reverse: boolean}} */ (spec) : null);
  }
  if (![...RACE_PAIRS.keys()].every(pair => seen.has(pair))) throw invalid("matchup coverage");
  return output;
}

/** @param {ReturnType<typeof dictionary>} tiers @param {ReturnType<typeof dictionary>} leagues
 * @param {ReturnType<typeof dictionary>} seasons @param {TierRequest} request */
function tierRegions(tiers, leagues, seasons, request) {
  /** @type {Map<number,Bounds>} */
  const regions = new Map();
  for (const [id, tier] of tiers) {
    const league = lookup(leagues, tier.leagueId, "league");
    const season = lookup(seasons, league.seasonId, "season");
    const minRating = count(tier.minRating, "tier minimum rating");
    const maxRating = count(tier.maxRating, "tier maximum rating");
    if (tier.type !== request.tierId || league.type !== request.leagueId || league.queueType !== LADDER_QUEUE
      || league.teamType !== ARRANGED || !isRegion(season.region) || maxRating < minRating
      || [...regions.values()].some(bounds => bounds.region === season.region)) {
      throw invalid("ladder tier");
    }
    regions.set(id, { region: season.region, minRating, maxRating });
  }
  if (regions.size !== REGIONS.length) throw invalid("tier coverage");
  return regions;
}

/** @param {ReturnType<typeof dictionary>} rows @param {ReturnType<typeof dictionary>} maps
 * @param {ReturnType<typeof tierRegions>} regions @param {ReturnType<typeof matchupSpecs>} specs */
function mapFilms(rows, maps, regions, specs) {
  const seen = new Set();
  /** @type {Map<number,Film>} */
  const films = new Map();
  for (const [id, row] of rows) {
    const mapId = count(row.mapId, "map");
    const map = lookup(maps, mapId, "map").name;
    const region = regions.get(count(row.leagueTierId, "film tier"))?.region;
    const specId = count(row.mapStatsFilmSpecId, "film spec");
    const spec = specs.get(specId);
    if (typeof map !== "string" || !map.trim() || map.length > 120 || !region || spec === undefined
      || typeof row.crossTier !== "boolean") throw invalid("film reference");
    const key = JSON.stringify([mapId, region, specId, row.crossTier]);
    if (seen.has(key)) throw invalid("duplicate film");
    seen.add(key);
    films.set(id, { mapId, map, region, spec, crossTier: row.crossTier, minutes: new Set() });
  }
  return films;
}

/** @param {number|null} minute */
function durationBucket(minute) {
  if (minute === null) return 0;
  const band = DURATION_MAXIMA.findIndex(maximum => minute <= maximum);
  return band === -1 ? DURATION_MAXIMA.length + 1 : band + 1;
}

/** @param {unknown} value @param {ReturnType<typeof mapFilms>} films @param {Map<string,Cell>} buckets */
function addFrame(value, films, buckets) {
  const frame = record(value, "frame");
  const film = films.get(count(frame.mapStatsFilmId, "frame film"));
  const minute = frame.number === null ? null : count(frame.number, "frame minute");
  const games = count(frame.games, "frame games");
  const wins = count(frame.wins, "frame wins");
  if (!film || film.minutes.has(minute) || games === 0 || wins > games) throw invalid("frame counts or film association");
  film.minutes.add(minute);
  if (!film.spec) return;
  const { matchup, reverse } = film.spec;
  const { mapId, map, region, crossTier } = film;
  const duration = durationBucket(minute);
  const key = JSON.stringify([matchup, mapId, region, crossTier, duration]);
  const cell = buckets.get(key) ?? { matchup, mapId, map, region, crossTier, duration, wins: 0, games: 0 };
  cell.games = count(cell.games + games, "pooled games");
  cell.wins += reverse ? games - wins : wins;
  buckets.set(key, cell);
}

/**
 * Convert one source tier to disjoint count buckets. No per-frame outcome
 * estimate is exposed. Unknown duration is a separate bucket in every total.
 * @param {unknown} source @param {TierRequest} request @param {number} season
 * @returns {TierCube}
 */
function readBalanceTier(source, request, season) {
  const data = record(source, "response");
  const seasons = dictionary(data.seasons, "seasons");
  validateRegions(seasons, season);
  const leagues = dictionary(data.leagues, "leagues");
  const regions = tierRegions(dictionary(data.tiers, "tiers"), leagues, seasons, request);
  const specs = matchupSpecs(dictionary(data.specs, "specs"));
  const films = mapFilms(dictionary(data.films, "films"), dictionary(data.maps, "maps"), regions, specs);
  if (!Array.isArray(data.frames) || !data.frames.length) throw invalid("frames");
  const buckets = new Map();
  for (const frame of data.frames) addFrame(frame, films, buckets);
  if ([...films.values()].some(film => !film.minutes.size) || !buckets.size) throw invalid("frame coverage");
  return { league: request.league, division: request.division, rows: [...buckets.values()], bounds: [...regions.values()] };
}

module.exports = { REGIONS, TIER_REQUESTS, readBalanceTier };
