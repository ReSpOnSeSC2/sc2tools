"use strict";

/**
 * The ladder VOD finder's search space and the shaping of SC2Pulse rows.
 *
 * A visitor can only pick from the fixed lists below, so the number of
 * distinct upstream searches (and cache entries) stays small and no free text
 * ever reaches SC2Pulse. Shaping keeps ADR 0075: a result carries the
 * streamer's VOD, both races, one rating rounded to 100, the map, the length
 * and the age. The other player's name, ids and VOD are dropped here.
 */

const { parseTwitchVod } = require("./pulseMatchVods");
const { SEED_MAPS } = require("./ladderVodMaps");

/** @typedef {import("./ladderVodMaps").MapChoice} MapChoice */

/** Matchup key to Pulse's `race` and `raceVersus` (the first race named first). */
const MATCHUPS = /** @type {Record<string, [Race, Race]>} */ ({
  tvz: ["TERRAN", "ZERG"],
  tvp: ["TERRAN", "PROTOSS"],
  zvp: ["ZERG", "PROTOSS"],
  tvt: ["TERRAN", "TERRAN"],
  zvz: ["ZERG", "ZERG"],
  pvp: ["PROTOSS", "PROTOSS"],
});

/** Rating bands by lower bound; a band without a top is open. Pulse treats both ends as inclusive. */
const RATING_BANDS = /** @type {Record<string, Band>} */ ({
  0: [0, 2999],
  3000: [3000, 3999],
  4000: [4000, 4999],
  5000: [5000, 5999],
  6000: [6000, null],
});

/** Game-length bands by lower bound in minutes, as seconds. */
const LENGTH_BANDS = /** @type {Record<string, Band>} */ ({
  0: [0, 299],
  5: [300, 599],
  10: [600, 899],
  15: [900, 1199],
  20: [1200, null],
});

const SEARCH_FIELDS = ["matchup", "rating", "length", "map", "after"];
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/** @typedef {"TERRAN" | "ZERG" | "PROTOSS" | "RANDOM"} Race */
/** @typedef {[number, number | null]} Band */
/**
 * One validated search: the cache key, the SC2Pulse query string, the matchup
 * and rating band asked for (null for any), and whether it asks for a later
 * page (`paged`).
 *
 * @typedef {{ key: string, query: URLSearchParams, matchup: [Race, Race] | null, ratingBand: Band | null, paged: boolean }} Search
 */
/**
 * One shaped, public-safe result. It carries no id of SC2Pulse's record of
 * the game, which names both players.
 *
 * @typedef {{
 *   vodUrl: string,
 *   videoId: string,
 *   subscribersOnly: boolean,
 *   streamerRace: Lowercase<Race>,
 *   opponentRace: Lowercase<Race>,
 *   rating: number,
 *   map: string,
 *   durationSec: number,
 *   playedAt: string,
 * }} LadderVod
 */
/**
 * The fields of an SC2Pulse `/sc2/api/matches` participant that are read.
 *
 * @typedef {{
 *   team?: { rating?: number, members?: Array<{ raceGames?: Record<string, number> }> },
 *   teamState?: { teamState?: { rating?: number } },
 *   twitchVodUrl?: string | null,
 *   subOnlyTwitchVod?: boolean,
 * }} PulseParticipant
 */
/**
 * @typedef {{
 *   match?: { id?: number, date?: string, duration?: number },
 *   map?: { name?: string },
 *   participants?: PulseParticipant[],
 * }} PulseMatch
 */

/**
 * @param {unknown} value
 * @returns {string | null} the single string value, or null when absent
 */
function single(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read one optional choice from a fixed table. `undefined` means "not given";
 * `null` means the value is not one of the choices.
 *
 * @template T
 * @param {unknown} raw @param {Record<string, T>} table
 * @returns {{ key: string, value: T } | undefined | null}
 */
function choice(raw, table) {
  const text = single(raw);
  if (text === null) return undefined;
  return Object.hasOwn(table, text) ? { key: text, value: table[text] } : null;
}

/** @param {unknown} raw @returns {string | undefined | null} the page cursor, undefined when absent, null when malformed */
function cursorOf(raw) {
  const text = single(raw);
  if (text === null) return undefined;
  return CURSOR_PATTERN.test(text) ? text : null;
}

/**
 * Validate a visitor's query into a search, or null when any part is not one
 * of the fixed choices.
 *
 * @param {Record<string, unknown>} input
 * @param {readonly MapChoice[]} [maps] the maps on offer
 * @returns {Search | null}
 */
function parseSearch(input, maps = SEED_MAPS) {
  // A repeated or nested query value (`?matchup=a&matchup=b`) is not a choice.
  if (SEARCH_FIELDS.some(field => input[field] !== undefined && typeof input[field] !== "string")) return null;
  const mapTable = Object.fromEntries(maps.map(entry => [String(entry.id), entry]));
  const choices = {
    matchup: choice(input.matchup, MATCHUPS),
    rating: choice(input.rating, RATING_BANDS),
    length: choice(input.length, LENGTH_BANDS),
    map: choice(input.map, mapTable),
  };
  const cursor = cursorOf(input.after);
  if (cursor === null || Object.values(choices).includes(null)) return null;
  return buildSearch(/** @type {Parameters<typeof buildSearch>[0]} */ (choices), cursor);
}

/**
 * @param {{
 *   matchup?: { value: [Race, Race] },
 *   rating?: { value: Band },
 *   length?: { value: Band },
 *   map?: { value: MapChoice },
 * }} choices @param {string | undefined} cursor
 * @returns {Search}
 */
function buildSearch({ matchup, rating, length, map }, cursor) {
  const query = new URLSearchParams({ vod: "true" });
  if (matchup) {
    query.set("race", matchup.value[0]);
    query.set("raceVersus", matchup.value[1]);
  }
  setBand(query, "ratingMin", "ratingMax", rating?.value);
  setBand(query, "durationMin", "durationMax", length?.value);
  if (map) query.set("mapId", String(map.value.id));
  if (cursor) query.set("after", cursor);
  query.sort();
  return { key: query.toString(), query, matchup: matchup?.value ?? null, ratingBand: rating?.value ?? null, paged: Boolean(cursor) };
}

/**
 * @param {URLSearchParams} query @param {string} minName @param {string} maxName
 * @param {Band | undefined} band
 */
function setBand(query, minName, maxName, band) {
  if (!band) return;
  if (band[0] > 0) query.set(minName, String(band[0]));
  if (band[1] !== null) query.set(maxName, String(band[1]));
}

/** @param {PulseParticipant} participant */
function ratingOf(participant) {
  const rating = participant.teamState?.teamState?.rating ?? participant.team?.rating;
  return Number.isFinite(rating) ? Number(rating) : 0;
}

/** @param {PulseParticipant} participant @param {Race} race */
function gamesAs(participant, race) {
  return participant.team?.members?.[0]?.raceGames?.[race] ?? 0;
}

/**
 * Pulse stores a team's games per race, not the race of one match. With the
 * matchup known, the assignment that fits those counts best wins; without it,
 * each player's most played race stands in.
 *
 * @param {[PulseParticipant, PulseParticipant]} pair @param {[Race, Race] | null} matchup
 * @returns {[Race, Race]}
 */
function racesOf(pair, matchup) {
  if (matchup) {
    const [first, second] = matchup;
    const asListed = gamesAs(pair[0], first) + gamesAs(pair[1], second);
    const swapped = gamesAs(pair[0], second) + gamesAs(pair[1], first);
    return asListed >= swapped ? [first, second] : [second, first];
  }
  return /** @type {[Race, Race]} */ (pair.map(participant => {
    const played = Object.entries(participant.team?.members?.[0]?.raceGames ?? {});
    return /** @type {Race} */ (played.sort((a, b) => b[1] - a[1])[0]?.[0] ?? "RANDOM");
  }));
}

/**
 * The rating as shown: nearest 100. A rating inside the band the visitor chose
 * stays inside it ("5,000 to 5,999" never shows 6,000), since every band ends
 * at x,999.
 *
 * @param {number} exact @param {Band | null} band
 */
function publicRating(exact, band) {
  const rounded = Math.round(exact / 100) * 100;
  if (!band || exact < band[0] || (band[1] !== null && exact > band[1])) return rounded;
  const high = band[1] === null ? Infinity : Math.floor(band[1] / 100) * 100;
  return Math.min(Math.max(rounded, Math.ceil(band[0] / 100) * 100), high);
}

/** @param {unknown} value */
function isDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** @param {PulseMatch} row @returns {boolean} a two-player game with a map, a length and a date */
function isShowable({ participants, match, map }) {
  if (!Array.isArray(participants) || participants.length !== 2) return false;
  const { id, date, duration } = match ?? {};
  return Boolean(id) && Boolean(map?.name) && Number.isFinite(duration) && isDate(date);
}

/**
 * The player whose VOD is shown: when both have one, the higher-rated.
 *
 * @param {[PulseParticipant, PulseParticipant]} pair
 */
function pickStreamer(pair) {
  return pair
    .map((participant, index) => ({ index, vod: parseTwitchVod(participant.twitchVodUrl), participant }))
    .filter(candidate => candidate.vod !== null)
    .sort((a, b) => ratingOf(b.participant) - ratingOf(a.participant))[0];
}

/**
 * One public result from a Pulse match, or null when it cannot be shown: not
 * a two-player game, no usable Twitch VOD, or a missing map, length or date.
 *
 * @param {PulseMatch} row @param {[Race, Race] | null} matchup @param {Band | null} [ratingBand] the rating band searched
 * @returns {LadderVod | null}
 */
function shapeMatch(row, matchup, ratingBand = null) {
  if (!isShowable(row)) return null;
  const { match, map } = /** @type {Required<Pick<PulseMatch, "match" | "map">>} */ (row);
  const pair = /** @type {[PulseParticipant, PulseParticipant]} */ (row.participants);
  const streamer = pickStreamer(pair);
  if (!streamer?.vod) return null;
  const races = racesOf(pair, matchup);
  return {
    vodUrl: `https://www.twitch.tv/videos/${streamer.vod.videoId}?t=${streamer.vod.offsetSec}s`,
    videoId: streamer.vod.videoId,
    subscribersOnly: streamer.participant.subOnlyTwitchVod === true,
    streamerRace: /** @type {Lowercase<Race>} */ (races[streamer.index].toLowerCase()),
    opponentRace: /** @type {Lowercase<Race>} */ (races[1 - streamer.index].toLowerCase()),
    rating: publicRating(ratingOf(streamer.participant), ratingBand),
    map: String(map.name),
    durationSec: Math.round(Number(match.duration)),
    playedAt: new Date(String(match.date)).toISOString(),
  };
}

module.exports = { MATCHUPS, RATING_BANDS, LENGTH_BANDS, parseSearch, shapeMatch };
