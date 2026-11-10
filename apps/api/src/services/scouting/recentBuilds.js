"use strict";

const { STATS_GAME_MATCH } = require("../../util/gameVisibility");
const { attachScoutingIdsToFilter } = require("../../util/opponentIdentity");
const { OPP_INTENT_LABEL_PROJECTION } = require("../buildIntentShape");
const { chipResult, escapeRegex } = require("../overlayLiveAggregations");
const { personalOppStrategy } = require("./opponentTendencies");

/**
 * Each player's most recent builds, for the desktop agent's private
 * game-start scouting report and loading-screen strip.
 *
 * A build is known only from a game the account owner played, so the
 * opponent's list is the owner's own games against that player. It is
 * never filled from other users' libraries or from guesses: a first
 * meeting is an empty list.
 */

/** The owner asked for the builds from each player's previous five games. */
const RECENT_BUILDS_LIMIT = 5;

const NEWEST_FIRST = Object.freeze({ date: -1, _id: -1 });

/**
 * @typedef {{
 *   gameId: string|null,
 *   result: 'Win'|'Loss'|'Tie'|null,
 *   map: string,
 *   build: string,
 *   date: string|null,
 * }} RecentBuildRow
 * ``result`` is the owner's result in that game on both lists. ``build``
 * is empty when the game was never classified.
 *
 * @typedef {{
 *   matchup: string|null,
 *   mine: RecentBuildRow[],
 *   theirs: Array<RecentBuildRow & {race: string}>|null,
 * }} RecentBuilds
 * ``theirs`` is null while the opponent's account is unknown, so only an
 * identified player with no earlier game reads as a first meeting.
 */

/** @param {string} userId @returns {Record<string, any>} */
function ownStatsGames(userId) {
  return { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true } };
}

/**
 * Match a stored race by its initial, as the sibling live aggregations do.
 * A stored game keeps the race each player spawned as, never Random, so a
 * Random pick narrows nothing.
 * @param {unknown} race
 * @returns {{$regex: string, $options: string}|null} null when the race is
 *   unknown or Random
 */
function raceInitialMatch(race) {
  const initial = typeof race === "string" ? race.trim().charAt(0).toUpperCase() : "";
  return initial && initial !== "R" ? { $regex: `^${escapeRegex(initial)}`, $options: "i" } : null;
}

/** @param {unknown} value @returns {string} */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** @param {unknown} value @returns {string|null} */
function isoDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {Record<string, any>} game
 * @param {string} build
 * @returns {RecentBuildRow}
 */
function buildRow(game, build) {
  const gameId = trimmed(game.gameId);
  return {
    // Without an id the agent lists the game but cannot open its build chain.
    gameId: gameId && gameId.length <= 200 ? gameId : null,
    result: chipResult(game.result),
    map: trimmed(game.map),
    build,
    date: isoDate(game.date),
  };
}

/**
 * The owner's newest games in one matchup, whoever the opponent was.
 * An unknown or Random race never narrows the set.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string|undefined} myRace
 * @param {string|undefined} oppRace
 * @returns {Promise<RecentBuildRow[]>}
 */
async function ownRecentBuilds(games, userId, myRace, oppRace) {
  if (!userId) return [];
  const filter = ownStatsGames(userId);
  const mine = raceInitialMatch(myRace);
  const theirs = raceInitialMatch(oppRace);
  if (mine) filter.myRace = mine;
  if (theirs) filter["opponent.race"] = theirs;
  const rows = await games
    .find(filter, { projection: { _id: 0, gameId: 1, result: 1, map: 1, date: 1, myBuild: 1 } })
    .sort(NEWEST_FIRST)
    .limit(RECENT_BUILDS_LIMIT)
    .toArray();
  return rows.map((game) => buildRow(game, trimmed(game.myBuild)));
}

/**
 * The newest games in the owner's library against one player, in every
 * matchup, with the opening as the owner's own stats count it.
 *
 * Identity is the toon handle and/or character id, linked accounts
 * included. A bare display name is never enough: barcode names are
 * shared by many players.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {Record<string, any>|null|undefined} identity
 * @returns {Promise<Array<RecentBuildRow & {race: string}>|null>} null when
 *   the identity names no account: an empty list would claim a first meeting
 */
async function opponentRecentBuilds(games, userId, identity) {
  const filter = userId && identity ? attachScoutingIdsToFilter(ownStatsGames(userId), identity) : null;
  if (!filter) return null;
  const rows = await games
    .find(filter, { projection: {
      _id: 0,
      gameId: 1,
      result: 1,
      map: 1,
      date: 1,
      "opponent.race": 1,
      "opponent.strategy": 1,
      ...OPP_INTENT_LABEL_PROJECTION,
    } })
    .sort(NEWEST_FIRST)
    .limit(RECENT_BUILDS_LIMIT)
    .toArray();
  return rows.map((game) => ({
    ...buildRow(game, personalOppStrategy(game)),
    // The player may have met the owner as another race before.
    race: trimmed(game.opponent?.race),
  }));
}

/**
 * Both lists for one live game, or null when a read failed.
 *
 * A failed read must not look like an empty list: that would call a known
 * opponent a first meeting. Without the lists the agent draws the report
 * it drew before they existed, and the rest of the enrichment still lands.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {{
 *   identity: Record<string, any>|null|undefined,
 *   myRace?: string,
 *   oppRace?: string,
 *   matchup?: string,
 * }} game
 * @returns {Promise<RecentBuilds|null>}
 */
async function recentBuilds(games, userId, game) {
  try {
    const [mine, theirs] = await Promise.all([
      ownRecentBuilds(games, userId, game.myRace, game.oppRace),
      opponentRecentBuilds(games, userId, game.identity),
    ]);
    return { matchup: game.matchup || null, mine, theirs };
  } catch {
    return null;
  }
}

module.exports = {
  recentBuilds,
  ownRecentBuilds,
  opponentRecentBuilds,
  RECENT_BUILDS_LIMIT,
};
