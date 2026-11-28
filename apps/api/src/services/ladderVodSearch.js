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

/** Pulse's ids for the current ladder map pool (read from its match feed). */
const LADDER_MAPS = /** @type {const} */ ([
  { id: 55370, name: "Lockdown LE" },
  { id: 55371, name: "Sanctuary III LE" },
  { id: 55372, name: "Rainfall LE" },
  { id: 55373, name: "Blackrock LE" },
  { id: 55374, name: "Old Sun Temple LE" },
  { id: 55375, name: "Fear and Faith LE" },
  { id: 55376, name: "At Eternity's Edge LE" },
  { id: 55377, name: "Washout LE" },
  { id: 55378, name: "Rorschach LE" },
]);

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
const RATING_BANDS = /** @type {Record<string, [number, number | null]>} */ ({
  0: [0, 2999],
  3000: [3000, 3999],
  4000: [4000, 4999],
  5000: [5000, 5999],
  6000: [6000, null],
});

/** Game-length bands by lower bound in minutes, as seconds. */
const LENGTH_BANDS = /** @type {Record<string, [number, number | null]>} */ ({
  0: [0, 299],
  5: [300, 599],
  10: [600, 899],
  15: [900, 1199],
  20: [1200, null],
});

const SEARCH_FIELDS = ["matchup", "rating", "length", "map", "after"];
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/** @typedef {"TERRAN" | "ZERG" | "PROTOSS" | "RANDOM"} Race */
/**
 * One validated search: the cache key, the SC2Pulse query string and the
 * matchup asked for (null for any).
 *
 * @typedef {{ key: string, query: URLSearchParams, matchup: [Race, Race] | null }} Search
 */
/**
 * One shaped, public-safe result.
 *
 * @typedef {{
 *   id: string,
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

/**
 * Validate a visitor's query into a search, or null when any part is not one
 * of the fixed choices.
 *
 * @param {Record<string, unknown>} input
 * @returns {Search | null}
 */
function parseSearch(input) {
  // A repeated or nested query value (`?matchup=a&matchup=b`) is not a choice.
  if (SEARCH_FIELDS.some(field => input[field] !== undefined && typeof input[field] !== "string")) return null;
  const matchup = choice(input.matchup, MATCHUPS);
  const rating = choice(input.rating, RATING_BANDS);
  const length = choice(input.length, LENGTH_BANDS);
  const mapText = single(input.map);
  const map = mapText === null ? undefined : LADDER_MAPS.find(entry => String(entry.id) === mapText) ?? null;
  const cursorText = single(input.after);
  const cursor = cursorText !== null && CURSOR_PATTERN.test(cursorText) ? cursorText : null;
  if ([matchup, rating, length, map].includes(null) || (cursorText !== null && cursor === null)) return null;

  const query = new URLSearchParams({ vod: "true" });
  if (matchup) {
    query.set("race", matchup.value[0]);
    query.set("raceVersus", matchup.value[1]);
  }
  setBand(query, "ratingMin", "ratingMax", rating?.value);
  setBand(query, "durationMin", "durationMax", length?.value);
  if (map) query.set("mapId", String(map.id));
  if (cursor) query.set("after", cursor);
  query.sort();
  return { key: query.toString(), query, matchup: matchup?.value ?? null };
}

/**
 * @param {URLSearchParams} query @param {string} minName @param {string} maxName
 * @param {[number, number | null] | undefined} band
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
 * One public result from a Pulse match, or null when it cannot be shown: not
 * a two-player game, no usable Twitch VOD, or a missing map, length or date.
 * When both players have a VOD the higher-rated one is the streamer.
 *
 * @param {PulseMatch} row @param {[Race, Race] | null} matchup
 * @returns {LadderVod | null}
 */
function shapeMatch(row, matchup) {
  const { participants, match, map } = row;
  if (!Array.isArray(participants) || participants.length !== 2 || !match?.id || !map?.name) return null;
  if (!Number.isFinite(match.duration) || !match.date || Number.isNaN(Date.parse(match.date))) return null;
  const pair = /** @type {[PulseParticipant, PulseParticipant]} */ (participants);
  const streamers = pair
    .map((participant, index) => ({ index, vod: parseTwitchVod(participant.twitchVodUrl), participant }))
    .filter(candidate => candidate.vod !== null)
    .sort((a, b) => ratingOf(b.participant) - ratingOf(a.participant));
  const streamer = streamers[0];
  if (!streamer?.vod) return null;
  const races = racesOf(pair, matchup);
  return {
    id: String(match.id),
    vodUrl: streamer.vod.url,
    videoId: streamer.vod.videoId,
    subscribersOnly: streamer.participant.subOnlyTwitchVod === true,
    streamerRace: /** @type {Lowercase<Race>} */ (races[streamer.index].toLowerCase()),
    opponentRace: /** @type {Lowercase<Race>} */ (races[1 - streamer.index].toLowerCase()),
    rating: Math.round(ratingOf(streamer.participant) / 100) * 100,
    map: map.name,
    durationSec: Math.round(Number(match.duration)),
    playedAt: new Date(match.date).toISOString(),
  };
}

module.exports = { LADDER_MAPS, MATCHUPS, RATING_BANDS, LENGTH_BANDS, parseSearch, shapeMatch };
