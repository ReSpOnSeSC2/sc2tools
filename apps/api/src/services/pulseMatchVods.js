"use strict";

/**
 * Resolve SC2Pulse's participant-scoped Twitch VODs for replay games.
 *
 * SC2Pulse attaches ``twitchVodUrl`` to the participant whose stream was
 * indexed, so one match can legitimately expose zero, one, or two points of
 * view.  This client keeps that participant association intact and never
 * turns a match-level VOD into a link for the other player.
 *
 * The upstream service is community-run.  Requests are cached per opponent
 * toon handle, concurrent requests share one promise, and every error path
 * degrades to an empty result (or a stale cached result) rather than failing
 * the games endpoint.
 */

const PULSE_MATCHES_URL =
  "https://sc2pulse.nephest.com/sc2/api/character-matches";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;
const FETCH_CONCURRENCY = 4;
const MAX_OPPONENT_TOONS = 50;

// The Battle.net ladder result and a locally parsed replay normally agree to
// the second, but allowing a small window accommodates API rounding/delayed
// result timestamps without opening the door to nearby unrelated games.
const END_TIME_TOLERANCE_MS = 2 * 60 * 1000;

class PulseMatchVodsService {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   logger?: { warn?: Function },
   *   now?: () => number,
   *   cacheTtlMs?: number,
   *   userAgent?: string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.logger = opts.logger || null;
    this.now = opts.now || (() => Date.now());
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" && opts.cacheTtlMs >= 0
        ? opts.cacheTtlMs
        : CACHE_TTL_MS;
    this.userAgent =
      opts.userAgent || "sc2tools.com game-vod-links (+https://sc2tools.com)";
    /** @type {Map<string, {matches: any[], fetchedAt: number}>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<any[]>>} */
    this._inflight = new Map();
  }

  /**
   * Return timestamped Twitch links keyed by local ``gameId``.
   *
   * @param {any[]} games
   * @returns {Promise<{
   *   linksByGameId: Record<string, Array<{
   *     platform: 'twitch',
   *     perspective: 'me'|'opponent',
   *     playerName: string,
   *     url: string,
   *     offsetSec: number,
   *     videoId: string,
   *     source: 'sc2pulse',
   *   }>>
   * }>}
   */
  async resolveForGames(games) {
    if (!Array.isArray(games) || games.length === 0) {
      return { linksByGameId: {} };
    }

    /** @type {Map<string, any[]>} */
    const gamesByToon = new Map();
    for (const game of games) {
      const gameId = cleanGameId(game && game.gameId);
      const toon = normaliseToon(
        game && game.opponent && game.opponent.toonHandle,
      );
      if (!gameId || !toon) continue;
      if (!gamesByToon.has(toon) && gamesByToon.size >= MAX_OPPONENT_TOONS) {
        continue;
      }
      const grouped = gamesByToon.get(toon) || [];
      grouped.push(game);
      gamesByToon.set(toon, grouped);
    }

    /** @type {Map<string, any[]>} */
    const pulseByToon = new Map();
    const toons = Array.from(gamesByToon.keys());
    await mapWithConcurrency(toons, FETCH_CONCURRENCY, async (toon) => {
      pulseByToon.set(toon, await this._matchesForToon(toon));
    });

    /** @type {Record<string, any[]>} */
    const linksByGameId = Object.create(null);
    for (const [toon, toonGames] of gamesByToon.entries()) {
      const pulseMatches = pulseByToon.get(toon) || [];
      for (const game of toonGames) {
        const gameId = cleanGameId(game.gameId);
        if (!gameId) continue;
        const match = findPulseMatch(game, pulseMatches, toon);
        if (!match) continue;
        const links = linksForMatch(game, match, toon);
        if (links.length > 0) linksByGameId[gameId] = links;
      }
    }

    return { linksByGameId };
  }

  /** @param {string} toon */
  async _matchesForToon(toon) {
    const cached = this._cache.get(toon);
    if (cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
      this._touch(toon, cached);
      return cached.matches;
    }

    const inflight = this._inflight.get(toon);
    if (inflight) return inflight;

    const promise = this._fetchMatches(toon)
      .then((matches) => {
        this._touch(toon, { matches, fetchedAt: this.now() });
        return matches;
      })
      .catch((err) => {
        this._warn(err, toon);
        // The match-to-VOD association is immutable, so a stale page is much
        // more useful than dropping known links during a transient outage.
        // Refresh its cache timestamp (including an empty miss) so a provider
        // outage is not retried by every open dossier until the TTL elapses.
        const matches = cached ? cached.matches : [];
        this._touch(toon, { matches, fetchedAt: this.now() });
        return matches;
      })
      .finally(() => this._inflight.delete(toon));
    this._inflight.set(toon, promise);
    return promise;
  }

  /** @param {string} toon */
  async _fetchMatches(toon) {
    if (!this.fetchImpl) throw new Error("fetch unavailable");
    const url = new URL(PULSE_MATCHES_URL);
    url.searchParams.set("toonHandle", toon);
    url.searchParams.set("type", "_1V1");
    url.searchParams.set("limit", "100");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw new Error(`pulse_http_${response ? response.status : "unknown"}`);
      }
      const payload = await response.json();
      return payload && Array.isArray(payload.result) ? payload.result : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} toon @param {{matches: any[], fetchedAt: number}} entry */
  _touch(toon, entry) {
    this._cache.delete(toon);
    this._cache.set(toon, entry);
    while (this._cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this._cache.keys().next().value;
      if (oldest === undefined) break;
      this._cache.delete(oldest);
    }
  }

  /** @param {unknown} err @param {string} toon */
  _warn(err, toon) {
    if (!this.logger || typeof this.logger.warn !== "function") return;
    this.logger.warn(
      { err: String(err), toonHandle: toon },
      "pulse_match_vods_fetch_failed",
    );
  }
}

/**
 * Pick the single plausible Pulse row for a replay.  Every available local
 * identity signal is treated as a guard, not merely a score: returning no
 * link is preferable to opening the wrong game in a many-hour broadcast.
 *
 * @param {any} game
 * @param {any[]} rows
 * @param {string} queriedToon
 */
function findPulseMatch(game, rows, queriedToon) {
  const endMs = parseDateMs(game && game.date);
  const localMap = normaliseMapName(
    game && (game.map || game.mapName || game.mapPlayback?.mapName),
  );
  const localDuration = finiteNonNegative(
    game && (game.durationSec ?? game.mapPlayback?.gameLength),
  );
  const myId = battlenetIdFromToon(game && game.myToonHandle);
  const opponentId =
    battlenetIdFromToon(game && game.opponent?.toonHandle) ||
    battlenetIdFromToon(queriedToon);
  if (endMs === null || !localMap) return null;

  /** @type {Array<{row: any, score: number}>} */
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const pulseEnd = parseDateMs(row && row.match && row.match.date);
    if (pulseEnd === null) continue;
    const endDelta = Math.abs(endMs - pulseEnd);
    if (endDelta > END_TIME_TOLERANCE_MS) continue;

    const pulseMap = normaliseMapName(row && row.map && row.map.name);
    if (!pulseMap || pulseMap !== localMap) continue;

    const pulseDuration = finiteNonNegative(row && row.match?.duration);
    let durationDelta = 0;
    if (localDuration !== null && pulseDuration !== null) {
      durationDelta = Math.abs(localDuration - pulseDuration);
      if (durationDelta > durationTolerance(localDuration)) continue;
    }

    const participantIds = participantBattleNetIds(row);
    if (opponentId && participantIds.size > 0 && !participantIds.has(opponentId)) {
      continue;
    }
    if (myId && participantIds.size > 0 && !participantIds.has(myId)) continue;

    candidates.push({
      row,
      score: endDelta / 1000 + durationDelta,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  if (candidates.length === 0) return null;
  // Refuse a true ambiguity instead of relying on upstream response order.
  if (
    candidates.length > 1 &&
    Math.abs(candidates[0].score - candidates[1].score) < 0.001
  ) {
    return null;
  }
  return candidates[0].row;
}

/**
 * @param {any} game
 * @param {any} row
 * @param {string} queriedToon
 */
function linksForMatch(game, row, queriedToon) {
  const myId = battlenetIdFromToon(game && game.myToonHandle);
  const opponentId =
    battlenetIdFromToon(game && game.opponent?.toonHandle) ||
    battlenetIdFromToon(queriedToon);
  const participants = Array.isArray(row && row.participants)
    ? row.participants
    : [];

  /** @type {Array<{
   *   participant: any,
   *   ids: Set<string>,
   *   playerName: string|null,
   * }>} */
  const described = participants.map(
    /** @param {any} participant */
    (participant) => ({
      participant,
      ids: participantIds(participant),
      playerName: participantName(participant),
    }),
  );
  const opponentIndex = opponentId
    ? described.findIndex((p) => p.ids.has(opponentId))
    : -1;
  const myIndex = myId ? described.findIndex((p) => p.ids.has(myId)) : -1;

  /** @type {any[]} */
  const links = [];
  const seen = new Set();
  described.forEach((entry, index) => {
    const vod = parseTwitchVod(entry.participant?.twitchVodUrl);
    if (!vod || !entry.playerName) return;

    /** @type {'me'|'opponent'|null} */
    let perspective = null;
    if (myIndex === index) perspective = "me";
    else if (opponentIndex === index) perspective = "opponent";
    // Required fallback: the participant identified by the queried toon is
    // the opponent; in a 1v1, the sole remaining participant is the user.
    else if (opponentIndex >= 0 && described.length === 2) perspective = "me";
    if (!perspective) return;

    const key = `${perspective}:${vod.videoId}:${vod.offsetSec}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      platform: "twitch",
      perspective,
      playerName: entry.playerName,
      url: vod.url,
      offsetSec: vod.offsetSec,
      videoId: vod.videoId,
      source: "sc2pulse",
    });
  });

  links.sort((a, b) => {
    if (a.perspective === b.perspective) return 0;
    return a.perspective === "me" ? -1 : 1;
  });
  return links;
}

/** @param {unknown} value */
function parseTwitchVod(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "twitch.tv" && host !== "www.twitch.tv") return null;
  const match = /^\/videos\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const offsetSec = parseTwitchOffset(parsed.searchParams.get("t"));
  if (offsetSec === null) return null;
  return {
    url: parsed.toString(),
    videoId: match[1],
    offsetSec,
  };
}

/** @param {string|null} raw */
function parseTwitchOffset(raw) {
  if (typeof raw !== "string" || !raw) return null;
  if (/^\d+s$/i.test(raw)) return Number(raw.slice(0, -1));
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (!match || !match[1] && !match[2] && !match[3]) return null;
  const seconds =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

/** @param {any} row */
function participantBattleNetIds(row) {
  const result = new Set();
  const participants = Array.isArray(row && row.participants)
    ? row.participants
    : [];
  for (const participant of participants) {
    for (const id of participantIds(participant)) result.add(id);
  }
  return result;
}

/** @param {any} participant */
function participantIds(participant) {
  const result = new Set();
  const members = Array.isArray(participant?.team?.members)
    ? participant.team.members
    : [];
  for (const member of members) {
    const id = numericId(member && member.character?.battlenetId);
    if (id) result.add(id);
  }
  return result;
}

/** @param {any} participant */
function participantName(participant) {
  const members = Array.isArray(participant?.team?.members)
    ? participant.team.members
    : [];
  const character = members[0] && members[0].character;
  const tag = cleanName(character && character.tag);
  if (tag) return tag;
  const name = cleanName(character && character.name);
  return name ? name.replace(/#\d+$/, "") : null;
}

/** @param {unknown} value */
function battlenetIdFromToon(value) {
  const toon = normaliseToon(value);
  if (!toon) return null;
  return toon.slice(toon.lastIndexOf("-") + 1);
}

/** @param {unknown} value */
function normaliseToon(value) {
  if (typeof value !== "string") return null;
  const toon = value.trim();
  return /^\d+-S2-\d+-\d+$/i.test(toon) ? toon : null;
}

/** @param {unknown} value */
function numericId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/** @param {unknown} value */
function cleanGameId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value */
function cleanName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value */
function parseDateMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

/** @param {unknown} value */
function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** @param {number} durationSec */
function durationTolerance(durationSec) {
  return Math.min(120, Math.max(30, Math.round(durationSec * 0.08)));
}

/** @param {unknown} value */
function normaliseMapName(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\ble\b$/i, "")
    .replace(/[^a-z0-9]+/g, "") || null;
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} limit
 * @param {(value: T) => Promise<void>} worker
 */
async function mapWithConcurrency(values, limit, worker) {
  let next = 0;
  const count = Math.min(limit, values.length);
  const workers = Array.from({ length: count }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await worker(values[index]);
    }
  });
  await Promise.all(workers);
}

module.exports = {
  PulseMatchVodsService,
  // Small pure helpers are exported to make URL/match safety auditable in
  // isolation without coupling tests to the private cache implementation.
  findPulseMatch,
  linksForMatch,
  parseTwitchVod,
};
