"use strict";

/**
 * Shaping for the pros board: SC2Pulse teams and matches become the public
 * rows. A row never carries an account name, a battle tag, an id of
 * SC2Pulse's records or the other player of a game (ADR 0075). A pro's
 * nickname, team, live channel and last games exist only when the server's
 * names gate is open (ADR 0065); `shapeSeen` is the only place a name is read.
 */

const { plainMapName } = require("./ladderVodMaps");

/** @typedef {"terran" | "zerg" | "protoss" | "random"} Race */
/** @typedef {import("./liveStreamProviders").LiveStream} LiveStream */
/**
 * The fields of an SC2Pulse `/sc2/api/teams` row that are read.
 *
 * @typedef {{
 *   rating?: number,
 *   lastPlayed?: string,
 *   league?: { type?: number },
 *   members?: Array<{
 *     character?: { id?: number },
 *     raceGames?: Record<string, number>,
 *     proId?: number,
 *     proNickname?: string,
 *     proTeam?: string | null,
 *     proPlayer?: { links?: Array<{ url?: string }> },
 *   }>,
 * }} PulseTeam
 */
/**
 * The fields of an SC2Pulse `/sc2/api/character-matches` row that are read.
 *
 * @typedef {{
 *   match?: { date?: string, duration?: number, type?: string },
 *   map?: { name?: string },
 *   participants?: Array<{
 *     participant?: { decision?: string },
 *     team?: { members?: Array<{ proId?: number, raceGames?: Record<string, number> }> } | null,
 *   }>,
 * }} PulseHistoryMatch
 */
/**
 * A team that played lately, before the names gate decides what is shown.
 * `pro` is null for every team while names are off.
 *
 * @typedef {{
 *   race: Race,
 *   league: string,
 *   rating: number,
 *   playedAtMs: number,
 *   pro: { id: number, nickname: string, team: string | null, channels: ChannelRef[] } | null,
 * }} Seen
 */
/** @typedef {{ platform: "twitch" | "kick", login: string }} ChannelRef */
/** @typedef {{ map: string, opponentRace: Race | null, won: boolean, durationSec: number, playedAt: string }} ProGame */

/** SC2Pulse league type to name; the board asks for Grandmaster only. */
const LEAGUES = /** @type {Record<number, string>} */ ({ 6: "grandmaster" });
const RACES = /** @type {const} */ (["terran", "zerg", "protoss", "random"]);
const MAX_GAMES = 3;
const CHANNEL_LINK = /(twitch\.tv|kick\.com)\/([A-Za-z0-9_]{2,25})(?:[/?#]|$)/i;

/** @param {number} rating @returns {number} the rating to the nearest 100, as the other public pages show it */
function roundRating(rating) {
  return Math.round(rating / 100) * 100;
}

/** @param {Record<string, number> | undefined} raceGames @returns {Race | null} the race played most */
function mainRace(raceGames) {
  let best = 0;
  /** @type {Race | null} */
  let race = null;
  for (const candidate of RACES) {
    const games = raceGames?.[candidate.toUpperCase()];
    if (typeof games === "number" && games > best) {
      best = games;
      race = candidate;
    }
  }
  return race;
}

/**
 * The channels the pro's own SC2Pulse links name. The nickname is never taken
 * for a channel name: a stranger's channel can carry it, and a wrong "Live"
 * link is worse than none.
 *
 * @param {NonNullable<PulseTeam["members"]>[number]} member
 * @returns {ChannelRef[]}
 */
function channelsOf(member) {
  const seen = new Set();
  return (member.proPlayer?.links ?? []).flatMap(link => {
    const found = CHANNEL_LINK.exec(link?.url ?? "");
    if (!found) return [];
    const platform = /** @type {ChannelRef["platform"]} */ (found[1].toLowerCase().startsWith("twitch") ? "twitch" : "kick");
    const login = found[2].toLowerCase();
    const key = `${platform}/${login}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ platform, login }];
  });
}

/** @param {NonNullable<PulseTeam["members"]>[number]} member @returns {Seen["pro"]} null unless SC2Pulse knows the account as a pro */
function proOf(member) {
  if (!Number.isInteger(member.proId) || !member.proNickname) return null;
  return { id: /** @type {number} */ (member.proId), nickname: String(member.proNickname), team: member.proTeam || null, channels: channelsOf(member) };
}

/**
 * @param {PulseTeam} team
 * @param {boolean} withPros whether the names gate is open
 * @returns {Seen | null} null for a team that is not a lone player with a race, rating and time
 */
function shapeSeen(team, withPros) {
  const members = team?.members;
  const member = members?.length === 1 ? members[0] : null;
  const race = member ? mainRace(member.raceGames) : null;
  const league = LEAGUES[team?.league?.type ?? 0];
  const playedAtMs = Date.parse(team?.lastPlayed ?? "");
  if (!member || !race || !league || !Number.isFinite(playedAtMs) || typeof team.rating !== "number") return null;
  return { race, league, rating: team.rating, playedAtMs, pro: withPros ? proOf(member) : null };
}

/**
 * The pro's most recent 1v1 games, newest first. The pro's own side is the
 * participant whose team carries the pro id; the other side gives only a race.
 *
 * @param {PulseHistoryMatch[]} rows
 * @param {number} proId
 * @returns {ProGame[]}
 */
function gamesOf(rows, proId) {
  return rows.flatMap(row => {
    const date = row?.match?.date;
    const duration = row?.match?.duration;
    const sides = row?.participants ?? [];
    const mine = sides.find(side => side?.team?.members?.some(member => member?.proId === proId));
    const decision = mine?.participant?.decision;
    if (row?.match?.type !== "_1V1" || !mine || !date || typeof duration !== "number" || (decision !== "WIN" && decision !== "LOSS")) return [];
    const other = sides.find(side => side !== mine);
    return [{
      map: plainMapName(row?.map?.name ?? "Unknown map"),
      opponentRace: mainRace(other?.team?.members?.[0]?.raceGames),
      won: decision === "WIN",
      durationSec: duration,
      playedAt: date,
    }];
  }).slice(0, MAX_GAMES);
}

/**
 * The channel a pro is live on, from the live list: a channel the pro's own
 * links name, on the platform the link names.
 *
 * @param {ChannelRef[]} channels
 * @param {LiveStream[]} streams
 * @returns {{ platform: "twitch" | "kick", channel: string, url: string, viewers: number } | null}
 */
function liveOf(channels, streams) {
  for (const { platform, login } of channels) {
    const stream = streams.find(candidate => candidate.platform === platform && candidate.channel.toLowerCase() === login);
    if (stream) return { platform: stream.platform, channel: stream.channel, url: stream.url, viewers: stream.viewers };
  }
  return null;
}

module.exports = { shapeSeen, gamesOf, liveOf, roundRating, mainRace, MAX_GAMES };
