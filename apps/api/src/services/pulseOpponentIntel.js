"use strict";

/**
 * SC2Pulse "ladder context" for opponent dossiers.
 *
 * One upstream call — ``GET /character/{id}/common`` — returns
 * everything the dossier's ladder card needs: an MMR history series
 * (sparkline), current-season team (rating / league / tier / W-L /
 * global+region rank), pro-player identity with social links, and the
 * linked characters SC2Pulse has unified across regions/accounts.
 * Response shape verified live 2026-07-11.
 *
 * SC2Pulse is a free, single-maintainer community service, so this
 * client is deliberately gentle: 1 h in-process TTL cache with
 * stale-while-error, single-flight per character id (concurrent
 * profile views share one upstream request), a hard response-size
 * bound, and a descriptive User-Agent. Every failure path returns
 * ``null`` — the dossier renders without the card rather than 500ing.
 */

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 5000; // LRU bound — opponents are unbounded
const HISTORY_DEPTH_DAYS = 90;
const SPARKLINE_MAX_POINTS = 120;
const LOTV_1V1_QUEUE = 201;

const LEAGUE_LABELS = [
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Diamond",
  "Master",
  "Grandmaster",
];

class PulseOpponentIntelService {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   cacheTtlMs?: number,
   *   userAgent?: string,
   *   logger?: import('pino').Logger,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" ? opts.cacheTtlMs : CACHE_TTL_MS;
    this.userAgent =
      opts.userAgent || "sc2tools.com opponent-dossier (+https://sc2tools.com)";
    this.logger = opts.logger || null;
    /** @type {Map<string, {intel: object|null, fetchedAt: number}>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<object|null>>} */
    this._inflight = new Map();
  }

  /**
   * Ladder-context intel for one SC2Pulse character id. Returns null
   * when the id is invalid, upstream is down (and nothing is cached),
   * or the payload doesn't parse — never throws.
   *
   * @param {string|number} pulseCharacterId
   * @returns {Promise<object|null>}
   */
  async getIntel(pulseCharacterId) {
    const id = String(pulseCharacterId || "").trim();
    if (!/^\d+$/.test(id)) return null;

    const cached = this._cache.get(id);
    if (cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
      this._touch(id, cached);
      return cached.intel;
    }

    const inflight = this._inflight.get(id);
    if (inflight) return inflight;

    const promise = this._fetchIntel(id)
      .then((intel) => {
        if (intel !== null) {
          this._touch(id, { intel, fetchedAt: this.now() });
        } else if (!cached) {
          // Cache the miss too (shorter implicit lifetime via TTL) so
          // an unresolvable id doesn't hammer upstream on every view.
          this._touch(id, { intel: null, fetchedAt: this.now() });
        }
        // Stale-while-error: keep serving the old entry on failure.
        return intel !== null ? intel : cached ? cached.intel : null;
      })
      .finally(() => {
        this._inflight.delete(id);
      });
    this._inflight.set(id, promise);
    return promise;
  }

  /** @param {string} id @param {{intel: object|null, fetchedAt: number}} entry */
  _touch(id, entry) {
    // Map iteration order doubles as LRU order: delete+set moves the
    // entry to the back; evict from the front when over budget.
    this._cache.delete(id);
    this._cache.set(id, entry);
    while (this._cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this._cache.keys().next().value;
      if (oldest === undefined) break;
      this._cache.delete(oldest);
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async _fetchIntel(id) {
    const url =
      `${PULSE_API_ROOT}/character/${id}/common` +
      `?matchType=_1V1&mmrHistoryDepth=${HISTORY_DEPTH_DAYS}`;
    let payload;
    try {
      payload = await this._getJson(url);
    } catch (err) {
      if (this.logger) {
        this.logger.warn({ err: String(err), id }, "pulse_intel_fetch_failed");
      }
      return null;
    }
    if (!payload || typeof payload !== "object") return null;
    try {
      return buildIntel(id, /** @type {any} */ (payload));
    } catch (err) {
      if (this.logger) {
        this.logger.warn({ err: String(err), id }, "pulse_intel_parse_failed");
      }
      return null;
    }
  }

  /** @param {string} url */
  async _getJson(url) {
    if (!this.fetchImpl) throw new Error("fetch unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`pulse_http_${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Normalise the raw /common payload into the dossier card's shape.
 * Defensive throughout — SC2Pulse's shapes shift between releases, and
 * a missing section should drop that section, not the whole card.
 *
 * @param {string} id
 * @param {any} payload
 */
function buildIntel(id, payload) {
  const history = normaliseHistory(payload.history);
  const currentTeam = pickCurrentTeam(payload.teams);
  const self = pickSelfCharacter(id, payload.linkedDistinctCharacters);
  const pro = normalisePro(payload.proPlayer);
  const linked = normaliseLinked(id, payload.linkedDistinctCharacters);

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const leagueType = currentTeam
    ? currentTeam.leagueType
    : latest
      ? latest.leagueType
      : null;

  return {
    characterId: id,
    region: currentTeam ? currentTeam.region : self ? self.region : null,
    current: currentTeam,
    league:
      leagueType !== null && leagueType !== undefined
        ? {
            type: leagueType,
            label: LEAGUE_LABELS[leagueType] || `League ${leagueType}`,
            // tierType is 0-indexed; players say "Diamond 1".
            tier: currentTeam && typeof currentTeam.tier === "number"
              ? currentTeam.tier + 1
              : null,
          }
        : null,
    // "top X%" from the most precise rank we have. globalTeamCount is
    // the population of ranked 1v1 teams, so this reads as "top 4% of
    // ladder" — the framing every other game's tools use.
    percentile: computePercentile(currentTeam, latest),
    peakRating: self ? self.ratingMax : null,
    leagueMax:
      self && typeof self.leagueMax === "number"
        ? {
            type: self.leagueMax,
            label: LEAGUE_LABELS[self.leagueMax] || `League ${self.leagueMax}`,
          }
        : null,
    totalGamesPlayed: self ? self.totalGamesPlayed : null,
    ratingHistory: downsample(history, SPARKLINE_MAX_POINTS).map((p) => ({
      t: p.t,
      rating: p.rating,
    })),
    pro,
    linkedCharacters: linked,
    pulseProfileUrl: `https://sc2pulse.nephest.com/sc2/?type=character&id=${id}&m=1`,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The history section is column-oriented (parallel arrays). Zip the
 * columns we need into row objects, sorted by time.
 *
 * @param {any} h
 * @returns {Array<{t: string, rating: number, leagueType: number|null}>}
 */
function normaliseHistory(h) {
  if (!h || typeof h !== "object") return [];
  const ratings = Array.isArray(h.rating) ? h.rating : [];
  const times = Array.isArray(h.dateTime) ? h.dateTime : [];
  const leagues = Array.isArray(h.leagueType) ? h.leagueType : [];
  const globalRanks = Array.isArray(h.globalRank) ? h.globalRank : [];
  const globalCounts = Array.isArray(h.globalTeamCount) ? h.globalTeamCount : [];
  const n = Math.min(ratings.length, times.length);
  /** @type {Array<{t: string, rating: number, leagueType: number|null, globalRank: number|null, globalTeamCount: number|null}>} */
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const rating = Number(ratings[i]);
    const t = typeof times[i] === "string" ? times[i] : null;
    if (!Number.isFinite(rating) || rating <= 0 || !t) continue;
    rows.push({
      t,
      rating,
      leagueType: typeof leagues[i] === "number" ? leagues[i] : null,
      globalRank: typeof globalRanks[i] === "number" ? globalRanks[i] : null,
      globalTeamCount:
        typeof globalCounts[i] === "number" ? globalCounts[i] : null,
    });
  }
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return rows;
}

/**
 * Most recently played 1v1 team = the ladder they're actually on.
 *
 * @param {any} teams
 */
function pickCurrentTeam(teams) {
  if (!Array.isArray(teams)) return null;
  /** @type {any} */
  let best = null;
  for (const team of teams) {
    if (!team || typeof team !== "object") continue;
    const queue = team.league && team.league.queueType;
    if (queue !== LOTV_1V1_QUEUE) continue;
    const rating = Number(team.rating);
    if (!Number.isFinite(rating) || rating <= 0) continue;
    const lastPlayed = typeof team.lastPlayed === "string" ? team.lastPlayed : "";
    if (!best || lastPlayed > best._lastPlayed) {
      best = {
        rating,
        wins: Number(team.wins) || 0,
        losses: Number(team.losses) || 0,
        leagueType:
          team.league && typeof team.league.type === "number"
            ? team.league.type
            : null,
        tier: typeof team.tierType === "number" ? team.tierType : null,
        region: typeof team.region === "string" ? team.region : null,
        season: typeof team.season === "number" ? team.season : null,
        globalRank: typeof team.globalRank === "number" ? team.globalRank : null,
        lastPlayed: lastPlayed || null,
        _lastPlayed: lastPlayed,
      };
    }
  }
  if (best) delete best._lastPlayed;
  return best;
}

/**
 * "Top X%" of the ranked 1v1 ladder, 1 decimal. History rows carry
 * both rank and population, so prefer the newest one; fall back to the
 * team's rank paired with the history's population when needed.
 *
 * @param {any} currentTeam
 * @param {any} latestHistory
 * @returns {number|null}
 */
function computePercentile(currentTeam, latestHistory) {
  let rank = null;
  let population = null;
  if (
    latestHistory &&
    typeof latestHistory.globalRank === "number" &&
    typeof latestHistory.globalTeamCount === "number"
  ) {
    rank = latestHistory.globalRank;
    population = latestHistory.globalTeamCount;
  } else if (
    currentTeam &&
    typeof currentTeam.globalRank === "number" &&
    latestHistory &&
    typeof latestHistory.globalTeamCount === "number"
  ) {
    rank = currentTeam.globalRank;
    population = latestHistory.globalTeamCount;
  }
  if (!rank || !population || rank <= 0 || population <= 0) return null;
  return Math.max(0.1, Math.round((rank / population) * 1000) / 10);
}

/** @param {string} id @param {any} linked */
function pickSelfCharacter(id, linked) {
  if (!Array.isArray(linked)) return null;
  for (const entry of linked) {
    const ch = entry && entry.members && entry.members.character;
    if (ch && String(ch.id) === id) {
      return {
        region: typeof ch.region === "string" ? ch.region : null,
        ratingMax: Number(entry.ratingMax) || null,
        leagueMax: typeof entry.leagueMax === "number" ? entry.leagueMax : null,
        totalGamesPlayed: Number(entry.totalGamesPlayed) || null,
      };
    }
  }
  return null;
}

/** @param {string} id @param {any} linked */
function normaliseLinked(id, linked) {
  if (!Array.isArray(linked)) return [];
  /** @type {Array<object>} */
  const out = [];
  for (const entry of linked) {
    const ch = entry && entry.members && entry.members.character;
    if (!ch || String(ch.id) === id) continue;
    out.push({
      characterId: String(ch.id),
      name: typeof ch.name === "string" ? ch.name : null,
      region: typeof ch.region === "string" ? ch.region : null,
      ratingMax: Number(entry.ratingMax) || null,
      leagueMax: typeof entry.leagueMax === "number" ? entry.leagueMax : null,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** @param {any} proSection */
function normalisePro(proSection) {
  const pro = proSection && proSection.proPlayer;
  if (!pro || typeof pro !== "object" || !pro.nickname) return null;
  /** @type {Record<string, string>} */
  const links = {};
  const rawLinks = Array.isArray(proSection.links) ? proSection.links : [];
  for (const link of rawLinks) {
    if (link && typeof link.type === "string" && typeof link.url === "string") {
      links[link.type.toLowerCase()] = link.url;
    }
  }
  const team = proSection.proTeam;
  return {
    nickname: String(pro.nickname),
    name: typeof pro.name === "string" ? pro.name : null,
    country: typeof pro.country === "string" ? pro.country : null,
    earnings: Number(pro.earnings) || null,
    team:
      team && typeof team === "object" && team.name
        ? String(team.name)
        : null,
    links,
  };
}

/**
 * Even spacing keeps the sparkline shape; always keep the last point
 * (the current rating is the one glanceable number).
 *
 * @template T
 * @param {T[]} rows
 * @param {number} maxPoints
 * @returns {T[]}
 */
function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  /** @type {T[]} */
  const out = [];
  const step = (rows.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(rows[Math.round(i * step)]);
  }
  return out;
}

module.exports = { PulseOpponentIntelService, LEAGUE_LABELS };
