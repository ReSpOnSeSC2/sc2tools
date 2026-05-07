"use strict";

// SC2Pulse-backed MMR fallback for the session widget.
//
// The agent populates `myMmr` on each game record when sc2reader
// exposes a real rating, but a sizable cohort of replays (older Battle.net
// builds, mods, custom games) ship with no rating at all. The session
// widget's Tier-1/Tier-2 fallbacks already reach back through 14 days
// and then any-time-ever for a stored myMmr; this service is the
// Tier-3 fallback that resolves the streamer's CURRENT 1v1 ladder
// rating directly from sc2pulse.nephest.com using their saved
// `pulseId`. It exists so streamers whose ranked replays were
// uploaded before MMR extraction landed still see "EU 5343" on the
// overlay instead of "EU —".
//
// The endpoint we hit (`/group/team`) returns every team carrying any
// of the supplied character ids in the active season. We pick the most
// recently played 1v1 team across all regions — the same heuristic the
// legacy stream-overlay-backend used — so a multi-region user's
// session widget tracks whichever ladder they're currently grinding.
//
// Cached in-process for CACHE_TTL_MS to keep us under SC2Pulse's
// soft-rate-limit. A read failure leaves the cache slot stale instead
// of nuking it: cached values keep getting served until either a
// fresh fetch succeeds or the TTL elapses.

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const PULSE_QUEUE = "LOTV_1V1";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const REGION_CODE_TO_LABEL = {
  1: "NA",
  2: "EU",
  3: "KR",
  5: "CN",
};

/**
 * @typedef {{
 *   mmr: number,
 *   region: string | null,
 *   fetchedAt: number,
 * }} PulseMmrEntry
 */

class PulseMmrService {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   cacheTtlMs?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" ? opts.cacheTtlMs : CACHE_TTL_MS;
    /** @type {Map<string, PulseMmrEntry>} */
    this._cache = new Map();
    /** @type {Map<string, number>} */
    this._seasonCache = new Map();
  }

  /**
   * Resolve the current 1v1 ladder MMR for a SC2Pulse character id.
   *
   * Returns null when:
   *   - `pulseId` isn't a numeric SC2Pulse character id (e.g. the user
   *     has only set a raw toon handle like "1-S2-1-267727" — those
   *     can't be queried directly without a separate lookup).
   *   - The character has no team in the active season for any region.
   *   - The remote request fails or times out and no cache entry is
   *     available.
   *
   * @param {string|null|undefined} pulseId
   * @returns {Promise<{mmr: number, region: string|null}|null>}
   */
  async getCurrentMmr(pulseId) {
    const id = normalisePulseId(pulseId);
    if (!id) return null;
    const cached = this._cache.get(id);
    const now = this.now();
    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      return { mmr: cached.mmr, region: cached.region };
    }
    const fetched = await this._fetchTeams(id);
    if (fetched) {
      const entry = { ...fetched, fetchedAt: now };
      this._cache.set(id, entry);
      return { mmr: entry.mmr, region: entry.region };
    }
    // Stale-while-error: a network blip shouldn't strip the streamer's
    // MMR off the overlay if we already had a value cached.
    if (cached) return { mmr: cached.mmr, region: cached.region };
    return null;
  }

  /**
   * @private
   * @param {string} pulseId
   * @returns {Promise<{mmr: number, region: string|null}|null>}
   */
  async _fetchTeams(pulseId) {
    if (!this.fetchImpl) return null;
    // Probe per-region — SC2Pulse's /group/team returns nothing without
    // a season id, and seasons are scoped per region. The legacy SPA
    // walked every region's current season; we do the same so the
    // session widget tracks whichever region the streamer is on now.
    const seasons = await this._currentSeasonsByRegion();
    if (seasons.size === 0) return null;
    /** @type {Array<{rating: number, lastPlayedMs: number, region: string|null}>} */
    const candidates = [];
    for (const [regionCode, seasonId] of seasons) {
      const url =
        `${PULSE_API_ROOT}/group/team` +
        `?season=${seasonId}` +
        `&queue=${PULSE_QUEUE}` +
        `&characterId=${encodeURIComponent(pulseId)}`;
      const teams = await this._getJson(url);
      if (!Array.isArray(teams)) continue;
      for (const team of teams) {
        const rating = Number(team && team.rating);
        if (!Number.isFinite(rating) || rating <= 0) continue;
        const lastPlayedMs = parseTimestamp(team.lastPlayed);
        const region = REGION_CODE_TO_LABEL[regionCode] || null;
        candidates.push({ rating, lastPlayedMs, region });
      }
    }
    if (candidates.length === 0) return null;
    // Pick the team played most recently; tie-break on highest rating
    // so a streamer who hasn't queued today still sees their peak.
    candidates.sort(
      (a, b) =>
        b.lastPlayedMs - a.lastPlayedMs || b.rating - a.rating,
    );
    const best = candidates[0];
    return { mmr: Math.round(best.rating), region: best.region };
  }

  /**
   * Map every region we recognise to its CURRENT season id. Cached for
   * the lifetime of the cache entry — seasons roll quarterly and a
   * stale id just means we miss the very latest matches for a few
   * minutes after a season change.
   *
   * @private
   * @returns {Promise<Map<number, number>>}
   */
  async _currentSeasonsByRegion() {
    const now = this.now();
    const cached = this._seasonCache.get("__fetchedAt__");
    if (cached && now - cached < this.cacheTtlMs && this._seasonCache.size > 1) {
      const out = new Map();
      for (const [k, v] of this._seasonCache) {
        if (typeof k === "number") out.set(k, v);
      }
      if (out.size > 0) return out;
    }
    const list = await this._getJson(`${PULSE_API_ROOT}/season/list/all`);
    /** @type {Map<number, number>} */
    const byRegion = new Map();
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const battlenetId = Number(entry.battlenetId);
        const regionCode = pulseRegionCode(entry.region);
        if (!Number.isFinite(battlenetId) || regionCode === null) continue;
        const existing = byRegion.get(regionCode);
        if (existing === undefined || battlenetId > existing) {
          byRegion.set(regionCode, battlenetId);
        }
      }
    }
    if (byRegion.size > 0) {
      this._seasonCache.clear();
      this._seasonCache.set("__fetchedAt__", now);
      for (const [k, v] of byRegion) this._seasonCache.set(k, v);
    }
    return byRegion;
  }

  /**
   * @private
   * @param {string} url
   * @returns {Promise<any|null>}
   */
  async _getJson(url) {
    if (!this.fetchImpl) return null;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
    try {
      const res = await this.fetchImpl(url, {
        signal: controller ? controller.signal : undefined,
        headers: { accept: "application/json" },
      });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Accept only purely-numeric SC2Pulse character ids. Raw toon handles
 * like "2-S2-1-267727" need a separate `/character/search` resolution
 * step that we don't run from the session-widget path; the user can
 * paste their pulse id into the profile panel to opt in.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalisePulseId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[0-9]{1,12}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Map SC2Pulse's region field to a numeric region code. The endpoint
 * returns the region as either an int (1, 2, 3, 5) or a label string
 * (``"US"``, ``"EU"``, ``"KR"``, ``"CN"``). Anything we don't know
 * returns null so the caller skips the entry.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function pulseRegionCode(raw) {
  if (typeof raw === "number") {
    return REGION_CODE_TO_LABEL[raw] ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const map = { US: 1, NA: 1, EU: 2, KR: 3, CN: 5 };
  const code = map[raw.toUpperCase()];
  return typeof code === "number" ? code : null;
}

/**
 * Parse SC2Pulse's `lastPlayed` timestamp (ISO 8601). Falls back to 0
 * so missing values sort last in the candidate ranking.
 *
 * @param {unknown} raw
 * @returns {number}
 */
function parseTimestamp(raw) {
  if (typeof raw !== "string" || !raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

module.exports = { PulseMmrService };
