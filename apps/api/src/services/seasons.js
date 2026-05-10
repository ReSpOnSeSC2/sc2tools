"use strict";

// SC2 ladder season catalog. Pulls authoritative season boundaries
// from SC2Pulse (https://sc2pulse.nephest.com/sc2/api/season/list/all)
// and serves them to the analyzer SPA so the date-range picker can
// filter by real season boundaries instead of approximating from
// quarterly date math.
//
// The catalog is cached in-process for CACHE_TTL_MS so we don't hit
// SC2Pulse on every request, with a stale-while-error policy: if a
// refresh fails we keep serving the previous payload.

const PULSE_API_ROOT = "https://sc2pulse.nephest.com/sc2/api";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT_MS = 8000;

// Current 1v1 ladder map pool. SC2Pulse does not expose the active pool
// per season; Blizzard rotates it on a multi-month cadence and we mirror
// the latest Battle.net 1v1 ranked set here. Treated as the catalog of
// names Bingo: Ladder Edition is allowed to draw map-bound objectives
// from. Update as the pool rotates — single additive surface so callers
// don't have to special-case "no pool".
const CURRENT_LADDER_MAP_POOL = Object.freeze([
  "Equilibrium",
  "Goldenaura",
  "Hard Lead",
  "Oceanborn",
  "Site Delta",
  "El Dorado",
  "Whispers of Gold",
  "Pylon Overgrowth",
  "Frostline",
]);

class SeasonsService {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    /** @type {{ items: SeasonEntry[], fetchedAt: number } | null} */
    this._cache = null;
  }

  /**
   * Return the current season catalog. Cached for 6 hours; transparent
   * about which seasons we have. Each entry is one season per region —
   * the SPA reduces by `number` to display "Season N" boundaries.
   *
   * @returns {Promise<{items: SeasonEntry[], current: number | null, source: 'pulse' | 'fallback', fetchedAt: number | null}>}
   */
  async list() {
    const now = this.now();
    if (
      this._cache
      && now - this._cache.fetchedAt < CACHE_TTL_MS
      && this._cache.items.length > 0
    ) {
      return this._respond(this._cache.items, this._cache.fetchedAt, "pulse");
    }
    const items = await this._fetchFromPulse();
    if (items && items.length > 0) {
      this._cache = { items, fetchedAt: now };
      return this._respond(items, now, "pulse");
    }
    if (this._cache && this._cache.items.length > 0) {
      // Stale-while-error: serve previous payload.
      return this._respond(this._cache.items, this._cache.fetchedAt, "pulse");
    }
    return {
      items: [],
      current: null,
      source: "fallback",
      fetchedAt: null,
      mapPool: CURRENT_LADDER_MAP_POOL.slice(),
    };
  }

  _respond(items, fetchedAt, source) {
    const current = items.reduce(
      (best, s) => (best == null || s.battlenetId > best ? s.battlenetId : best),
      /** @type {number | null} */ (null),
    );
    // Roll up by season number across regions for the SPA. Each
    // distinct `number` is one logical season; pick the earliest start
    // and latest end across all regions for that number.
    return {
      items,
      current,
      source,
      fetchedAt,
      mapPool: CURRENT_LADDER_MAP_POOL.slice(),
    };
  }

  async _fetchFromPulse() {
    if (!this.fetchImpl) return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await this.fetchImpl(`${PULSE_API_ROOT}/season/list/all`, {
        signal: controller ? controller.signal : undefined,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const raw = await res.json();
      if (!Array.isArray(raw)) return null;
      return raw.map(normalizeSeason).filter((s) => s !== null);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** @typedef {{
 *   battlenetId: number,
 *   region: string,
 *   year: number | null,
 *   number: number | null,
 *   start: string | null,
 *   end: string | null,
 * }} SeasonEntry */

/** @returns {SeasonEntry | null} */
function normalizeSeason(raw) {
  if (!raw || typeof raw !== "object") return null;
  const battlenetId = Number(raw.battlenetId);
  if (!Number.isFinite(battlenetId)) return null;
  const region = typeof raw.region === "string" ? raw.region : "";
  const start = typeof raw.start === "string" ? raw.start : null;
  const end = typeof raw.end === "string" ? raw.end : null;
  return {
    battlenetId,
    region,
    year: typeof raw.year === "number" ? raw.year : null,
    number: typeof raw.number === "number" ? raw.number : null,
    start,
    end,
  };
}

module.exports = { SeasonsService };
