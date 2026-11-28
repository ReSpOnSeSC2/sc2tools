"use strict";

/**
 * Pros on Ladder: the Grandmasters who played a 1v1 ladder game in the last
 * hour, and which of them are known pros, how they did lately and whether
 * they are streaming.
 *
 * Two gates, both off until set (G2, ADR 0065): the board itself, and the
 * showing of pro names. Visitors never reach SC2Pulse: a timer calls
 * `refresh()` (one `/teams` call, plus at most `MAX_HISTORY_CALLS` pro
 * histories, each only when the pro has played since the last look), and
 * `view()` reads what the last refresh stored. With names off no pro is
 * looked up at all, so no name, channel or game is ever held.
 */

const { PulseClient, PulseBusyError } = require("./pulseClient");
const { shapeSeen, gamesOf, liveOf, roundRating } = require("./proBoardShape");

const ENABLE_FLAG = "SC2TOOLS_PROS_ON_LADDER_ENABLED";
const NAMES_FLAG = "SC2TOOLS_PROS_ON_LADDER_NAMES";
const USER_AGENT = "sc2tools.com pros-on-ladder (+https://sc2tools.com)";
/** A team counts as playing now for an hour after its last game. */
const PLAYING_WINDOW_MS = 60 * 60 * 1000;
/** A board older than this is not shown: a long outage must not pass for "now". */
const STALE_LIMIT_MS = 30 * 60 * 1000;
const MAX_PLAYERS = 24;
const MAX_PROS = 12;
/** Pro histories fetched in one refresh; the rest of the pros are listed without games. */
const MAX_HISTORY_CALLS = 6;
const MAX_REMEMBERED_PROS = 60;
/** The timer's own refresh may wait this long for a free slot behind visitors' searches. */
const MAX_WAIT_MS = 4000;
const TEAMS_QUERY = { queue: "LOTV_1V1", teamType: "ARRANGED", league: "GRANDMASTER", recent: "true" };

/** @typedef {import("./proBoardShape").Seen} Seen */
/** @typedef {import("./proBoardShape").ProGame} ProGame */
/** @typedef {import("./proBoardShape").PulseTeam} PulseTeam */
/** @typedef {import("./proBoardShape").PulseHistoryMatch} PulseHistoryMatch */
/** @typedef {import("./proBoardShape").Race} Race */
/** @typedef {{ platform: "twitch" | "kick", channel: string, url: string, viewers: number }} ProLive */
/** @typedef {{ race: Race, league: string, rating: number }} PlayerRow */
/** @typedef {{ nickname: string, team: string | null, playedAt: string, live: ProLive | null, games: ProGame[] } & PlayerRow} ProRow */
/**
 * What the route serves. `pros` is empty while names are off, and the pros'
 * teams are then among `players` like everyone else.
 *
 * @typedef {{ available: true, showNames: boolean, pros: ProRow[], players: PlayerRow[], fetchedAt: string }} ProBoard
 */

/**
 * Rows for players who are not named. They carry no time of any kind, and
 * come strongest first rather than newest first, because SC2Pulse's public
 * `recent` list shows each account's exact last-played time and order, and
 * either would let a row be matched to its account.
 *
 * @param {Seen[]} entries
 * @returns {PlayerRow[]}
 */
function anonymousRows(entries) {
  return entries
    .map(entry => ({ race: entry.race, league: entry.league, rating: roundRating(entry.rating) }))
    .sort((a, b) => b.rating - a.rating || a.race.localeCompare(b.race));
}

class ProBoardError extends Error {
  constructor() {
    super("unavailable");
    this.code = "unavailable";
  }
}

class ProBoardService {
  /**
   * @param {{
   *   enabled?: boolean,
   *   showNames?: boolean,
   *   pulse?: PulseClient,
   *   liveStreams?: { list: () => Promise<{ streams: import("./liveStreamProviders").LiveStream[] }> } | null,
   *   now?: () => number,
   *   log?: { warn?: (fields: object, message: string) => void },
   * }} [options]
   */
  constructor({
    enabled = process.env[ENABLE_FLAG] === "1",
    showNames = process.env[NAMES_FLAG] === "1",
    pulse = new PulseClient(),
    liveStreams = null,
    now = Date.now,
    log,
  } = {}) {
    this.enabled = enabled;
    this.showNames = enabled && showNames;
    this.pulse = pulse;
    this.liveStreams = liveStreams;
    this.now = now;
    this.log = log;
    /** @type {{ board: ProBoard, at: number } | null} */
    this.stored = null;
    /** @type {Map<number, { playedAtMs: number, games: ProGame[] }>} the last look at each pro's games */
    this.histories = new Map();
  }

  /** Whether the feature gate is open; costs no call. */
  isOpen() {
    return this.enabled;
  }

  /**
   * @returns {{ available: false } | ProBoard}
   * @throws {ProBoardError} no refresh has succeeded lately
   */
  view() {
    if (!this.enabled) return { available: false };
    if (!this.stored || this.now() - this.stored.at > STALE_LIMIT_MS) throw new ProBoardError();
    return this.stored.board;
  }

  /**
   * One bounded refresh, for the timer. A no-op while the gate is off. A
   * failed `/teams` call keeps the last board; a failed history only leaves
   * that pro without games.
   */
  async refresh() {
    if (!this.enabled) return;
    const teams = await this.fetchTeams();
    const cutoff = this.now() - PLAYING_WINDOW_MS;
    const seen = teams
      .flatMap(team => shapeSeen(team, this.showNames) ?? [])
      .filter(entry => entry.playedAtMs >= cutoff)
      .sort((a, b) => b.playedAtMs - a.playedAtMs);
    const proEntries = this.showNames ? seen.filter(entry => entry.pro).slice(0, MAX_PROS) : [];
    const pros = await this.proRows(proEntries);
    const listed = new Set(proEntries);
    const players = anonymousRows(seen.filter(entry => !listed.has(entry)).slice(0, MAX_PLAYERS));
    this.stored = {
      board: { available: true, showNames: this.showNames, pros, players, fetchedAt: new Date(this.now()).toISOString() },
      at: this.now(),
    };
  }

  /** @returns {Promise<PulseTeam[]>} */
  async fetchTeams() {
    const json = await this.pulse.get("/teams", new URLSearchParams(TEAMS_QUERY), { maxWaitMs: MAX_WAIT_MS, userAgent: USER_AGENT, background: true });
    return Array.isArray(json) ? json : [];
  }

  /**
   * @param {Seen[]} entries the pros seen, newest first
   * @returns {Promise<ProRow[]>}
   */
  async proRows(entries) {
    if (entries.length === 0) return [];
    const streams = await this.liveList();
    /** @type {ProRow[]} */
    const rows = [];
    let lookups = MAX_HISTORY_CALLS;
    for (const entry of entries) {
      const pro = /** @type {NonNullable<Seen["pro"]>} */ (entry.pro);
      const known = this.histories.get(pro.id);
      let games = known?.games ?? [];
      if (known?.playedAtMs !== entry.playedAtMs && lookups > 0) {
        lookups -= 1;
        games = await this.loadGames(pro.id, entry.playedAtMs);
      }
      rows.push({
        nickname: pro.nickname,
        team: pro.team,
        race: entry.race,
        league: entry.league,
        rating: entry.rating,
        playedAt: new Date(entry.playedAtMs).toISOString(),
        live: liveOf(pro.channels, streams),
        games,
      });
    }
    return rows;
  }

  /** @returns {Promise<import("./liveStreamProviders").LiveStream[]>} the live list, or none when it cannot be read */
  async liveList() {
    try {
      return (await this.liveStreams?.list())?.streams ?? [];
    } catch (err) {
      this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "pros board live list unavailable");
      return [];
    }
  }

  /**
   * @param {number} proId @param {number} playedAtMs
   * @returns {Promise<ProGame[]>} the pro's last games, or none when SC2Pulse could not give them
   */
  async loadGames(proId, playedAtMs) {
    try {
      const query = new URLSearchParams({ proPlayerId: String(proId) });
      const json = /** @type {{ result?: PulseHistoryMatch[] }} */ (await this.pulse.get("/character-matches", query, { maxWaitMs: MAX_WAIT_MS, userAgent: USER_AGENT, background: true }));
      const games = gamesOf(Array.isArray(json?.result) ? json.result : [], proId);
      this.remember(proId, { playedAtMs, games });
      return games;
    } catch (err) {
      if (!(err instanceof PulseBusyError)) {
        this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "pros board history failed");
      }
      return this.histories.get(proId)?.games ?? [];
    }
  }

  /** @param {number} proId @param {{ playedAtMs: number, games: ProGame[] }} entry */
  remember(proId, entry) {
    this.histories.delete(proId);
    this.histories.set(proId, entry);
    while (this.histories.size > MAX_REMEMBERED_PROS) this.histories.delete(/** @type {number} */ (this.histories.keys().next().value));
  }
}

module.exports = { ProBoardService, ProBoardError, ENABLE_FLAG, NAMES_FLAG, STALE_LIMIT_MS, PLAYING_WINDOW_MS, MAX_HISTORY_CALLS, MAX_PROS, MAX_PLAYERS };
