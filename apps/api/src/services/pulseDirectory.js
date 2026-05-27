"use strict";

/**
 * PulseDirectoryService — the global, cross-user SC2Pulse cache.
 *
 * The platform's per-user ``opponents`` rows are private: each user
 * has their own row for the same real opponent, and historically each
 * user re-pulled that opponent's data from sc2pulse.nephest.com from
 * scratch (resolve the toon handle → canonical character id, then
 * fetch current MMR + per-race breakdown). That's wasted work — the
 * SC2Pulse data is public and identical for everyone.
 *
 * This service owns ONE shared collection (``pulse_accounts``), keyed
 * by toon handle, that records the result of every successful SC2Pulse
 * pull so the next user who runs into the same opponent reuses it
 * instead of hitting SC2Pulse again. Two kinds of data live here, with
 * different volatilities:
 *
 *   * Resolution (``pulseCharacterId``): the toon → canonical character
 *     id mapping. Effectively immutable inside a season, so it's
 *     cached long-term (``RESOLUTION_TTL_MS``). This is the heaviest
 *     part of a "full pull" — several SC2Pulse search round-trips per
 *     opponent — and the biggest win from sharing.
 *   * Live ladder data (``mmr`` / ``region`` / ``leagueId`` /
 *     ``races``): a 1v1 rating barely moves within an hour, so it's
 *     cached for ``MMR_TTL_MS`` and refreshed by whichever user's
 *     lookup next finds it stale.
 *
 * Every method is best-effort and fail-soft: a Mongo hiccup degrades
 * to "cache miss" (callers fall back to a live SC2Pulse pull) rather
 * than throwing into an ingest path. Callers that supply ``null`` for
 * the dependency (unit tests that don't exercise sharing) keep
 * working untouched.
 *
 * No mock data, no synthetic ids: a row only exists once a real
 * SC2Pulse pull produced it.
 */

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

// Positive resolution TTL. The toon → characterId mapping is stable
// inside a season; mirrors the cloud resolver's own 24 h positive
// cache so the shared layer doesn't serve a more-stale value than the
// in-process one.
const RESOLUTION_TTL_MS = 24 * 60 * 60 * 1000;
// Live ladder data TTL. Matches PulseMmrService's per-race cache — a
// ladder rating barely moves within an hour and opponent profiles are
// opened far more often than that.
const MMR_TTL_MS = 60 * 60 * 1000;

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * @typedef {{
 *   race: string,
 *   mmr: number,
 *   games: number,
 *   league: string | null,
 *   region: string | null,
 * }} RaceRow
 */

class PulseDirectoryService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   now?: () => number,
   *   logger?: { warn: Function, info: Function, debug: Function },
   *   resolutionTtlMs?: number,
   *   mmrTtlMs?: number,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db || !db.pulseAccounts) {
      throw new Error("PulseDirectoryService: db.pulseAccounts required");
    }
    /** @type {import('mongodb').Collection} */
    this.col = db.pulseAccounts;
    this.now = opts.now || (() => Date.now());
    this.logger = opts.logger || NOOP_LOGGER;
    this.resolutionTtlMs =
      typeof opts.resolutionTtlMs === "number" && opts.resolutionTtlMs > 0
        ? opts.resolutionTtlMs
        : RESOLUTION_TTL_MS;
    this.mmrTtlMs =
      typeof opts.mmrTtlMs === "number" && opts.mmrTtlMs > 0
        ? opts.mmrTtlMs
        : MMR_TTL_MS;
  }

  /**
   * Return a fresh, POSITIVE toon → characterId resolution if one is
   * cached within the resolution TTL, else null. Negative results
   * (rows that were attempted but never resolved an id) are NOT served
   * — the in-process resolver owns negative caching so a player who
   * appears on SC2Pulse minutes after their first game still gets
   * retried instead of being blackholed by the shared layer.
   *
   * @param {string|null|undefined} toonHandle
   * @returns {Promise<string|null>}
   */
  async getFreshResolution(toonHandle) {
    const toon = normaliseToon(toonHandle);
    if (!toon) return null;
    try {
      const row = await this.col.findOne(
        { toonHandle: toon },
        { projection: { _id: 0, pulseCharacterId: 1, resolvedAt: 1 } },
      );
      if (!row) return null;
      const cid =
        typeof row.pulseCharacterId === "string" && row.pulseCharacterId
          ? row.pulseCharacterId
          : null;
      if (!cid) return null;
      const resolvedAt =
        row.resolvedAt instanceof Date ? row.resolvedAt.getTime() : null;
      if (resolvedAt === null) return null;
      if (this.now() - resolvedAt >= this.resolutionTtlMs) return null;
      return cid;
    } catch (err) {
      this.logger.warn({ err, toonHandle: toon }, "pulse_directory_resolution_read_failed");
      return null;
    }
  }

  /**
   * Write-through a successful toon → characterId resolution so the
   * next user who runs into this opponent skips the SC2Pulse search.
   * Stamps ``resolvedAt`` only when a non-empty id is supplied;
   * ``displayNameSample`` is refreshed opportunistically because the
   * resolver needs a name term and a fresher one improves the next
   * miss's recovery odds.
   *
   * @param {{
   *   toonHandle: string,
   *   pulseCharacterId: string,
   *   displayName?: string | null,
   *   region?: string | null,
   * }} args
   * @returns {Promise<boolean>} true when a write landed
   */
  async recordResolution(args) {
    const toon = normaliseToon(args && args.toonHandle);
    const cid =
      args && typeof args.pulseCharacterId === "string" && args.pulseCharacterId
        ? args.pulseCharacterId
        : null;
    if (!toon || !cid) return false;
    const now = new Date(this.now());
    /** @type {Record<string, any>} */
    const set = {
      pulseCharacterId: cid,
      resolvedAt: now,
      resolveAttemptedAt: now,
      updatedAt: now,
    };
    const name = cleanName(args.displayName);
    if (name) set.displayNameSample = name;
    const region = cleanRegion(args.region);
    if (region) set.region = region;
    return this._upsert(toon, set);
  }

  /**
   * Return fresh live ladder data (collapsed MMR + per-race breakdown)
   * for an opponent if cached within the MMR TTL, else null. Looks up
   * by toon handle first (the natural key); falls back to the sparse
   * ``pulseCharacterId`` index when only the numeric id is known.
   *
   * @param {{ toonHandle?: string|null, pulseCharacterId?: string|null }} args
   * @returns {Promise<{
   *   mmr: number | null,
   *   region: string | null,
   *   leagueId: number | null,
   *   races: RaceRow[],
   *   fetchedAt: number,
   * } | null>}
   */
  async getFreshMmr(args) {
    const filter = this._identityFilter(args);
    if (!filter) return null;
    try {
      const row = await this.col.findOne(filter, {
        projection: {
          _id: 0,
          mmr: 1,
          region: 1,
          leagueId: 1,
          races: 1,
          mmrFetchedAt: 1,
        },
      });
      if (!row) return null;
      const fetchedAt =
        row.mmrFetchedAt instanceof Date ? row.mmrFetchedAt.getTime() : null;
      if (fetchedAt === null) return null;
      if (this.now() - fetchedAt >= this.mmrTtlMs) return null;
      return {
        mmr: typeof row.mmr === "number" ? row.mmr : null,
        region: typeof row.region === "string" ? row.region : null,
        leagueId: typeof row.leagueId === "number" ? row.leagueId : null,
        races: Array.isArray(row.races) ? row.races : [],
        fetchedAt,
      };
    } catch (err) {
      this.logger.warn({ err }, "pulse_directory_mmr_read_failed");
      return null;
    }
  }

  /**
   * Write-through live ladder data after a real SC2Pulse pull. At
   * least one of ``mmr`` or a non-empty ``races`` array must be
   * present; otherwise there's nothing worth caching and the call is a
   * no-op. Keyed by toon handle when available (so the row coincides
   * with the resolution row), else by a synthetic character-id key.
   *
   * @param {{
   *   toonHandle?: string | null,
   *   pulseCharacterId?: string | null,
   *   mmr?: number | null,
   *   region?: string | null,
   *   leagueId?: number | null,
   *   races?: RaceRow[] | null,
   * }} args
   * @returns {Promise<boolean>}
   */
  async recordMmr(args) {
    const toon = normaliseToon(args && args.toonHandle);
    const cid =
      args && typeof args.pulseCharacterId === "string" && args.pulseCharacterId
        ? args.pulseCharacterId
        : null;
    if (!toon && !cid) return false;
    const mmr =
      args && typeof args.mmr === "number" && Number.isFinite(args.mmr) && args.mmr > 0
        ? Math.round(args.mmr)
        : null;
    const races = sanitizeRaces(args && args.races);
    if (mmr === null && races.length === 0) return false;
    const now = new Date(this.now());
    /** @type {Record<string, any>} */
    const set = { mmrFetchedAt: now, updatedAt: now };
    if (mmr !== null) set.mmr = mmr;
    if (races.length > 0) set.races = races;
    if (cid) set.pulseCharacterId = cid;
    const region = cleanRegion(args.region) || (races[0] ? races[0].region : null);
    if (region) set.region = region;
    if (args && typeof args.leagueId === "number") set.leagueId = args.leagueId;
    // Prefer the toon handle as the document key so resolution and MMR
    // collapse onto a single row; fall back to a character-id key for
    // the rare toon-less path.
    const key = toon
      ? { toonHandle: toon }
      : { toonHandle: `cid:${cid}` };
    return this._upsert(key.toonHandle, set);
  }

  /**
   * Operational counters for the admin Global tab. Read-only, cheap
   * (count + countDocuments on indexed fields).
   *
   * @returns {Promise<{
   *   total: number,
   *   resolved: number,
   *   mmrCached: number,
   * }>}
   */
  async stats() {
    try {
      const [total, resolved, mmrCached] = await Promise.all([
        this.col.estimatedDocumentCount(),
        this.col.countDocuments({
          pulseCharacterId: { $type: "string", $ne: "" },
        }),
        this.col.countDocuments({ mmr: { $type: "number" } }),
      ]);
      return {
        total: Number(total) || 0,
        resolved: Number(resolved) || 0,
        mmrCached: Number(mmrCached) || 0,
      };
    } catch (err) {
      this.logger.warn({ err }, "pulse_directory_stats_failed");
      return { total: 0, resolved: 0, mmrCached: 0 };
    }
  }

  /**
   * @private
   * @param {string} toonHandle
   * @param {Record<string, any>} set
   * @returns {Promise<boolean>}
   */
  async _upsert(toonHandle, set) {
    try {
      const onInsert = stampVersion({ toonHandle }, COLLECTIONS.PULSE_ACCOUNTS);
      await this.col.updateOne(
        { toonHandle },
        { $setOnInsert: onInsert, $set: set },
        { upsert: true },
      );
      return true;
    } catch (err) {
      this.logger.warn({ err, toonHandle }, "pulse_directory_write_failed");
      return false;
    }
  }

  /**
   * @private
   * @param {{ toonHandle?: string|null, pulseCharacterId?: string|null }} args
   * @returns {Record<string, any> | null}
   */
  _identityFilter(args) {
    const toon = normaliseToon(args && args.toonHandle);
    if (toon) return { toonHandle: toon };
    const cid =
      args && typeof args.pulseCharacterId === "string" && args.pulseCharacterId
        ? args.pulseCharacterId
        : null;
    if (cid) return { pulseCharacterId: cid };
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normaliseToon(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function cleanRegion(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Defensive copy + shape-check of a per-race breakdown array. Drops
 * rows that don't carry a finite positive MMR so a malformed SC2Pulse
 * payload can't poison the shared cache.
 *
 * @param {unknown} raw
 * @returns {RaceRow[]}
 */
function sanitizeRaces(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {RaceRow[]} */
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = /** @type {any} */ (r);
    const mmr = Number(row.mmr);
    if (!Number.isFinite(mmr) || mmr <= 0) continue;
    if (typeof row.race !== "string" || !row.race) continue;
    out.push({
      race: row.race,
      mmr: Math.round(mmr),
      games: Number.isFinite(Number(row.games)) ? Number(row.games) : 0,
      league: typeof row.league === "string" ? row.league : null,
      region: typeof row.region === "string" ? row.region : null,
    });
  }
  return out;
}

module.exports = {
  PulseDirectoryService,
  __internal: { sanitizeRaces, normaliseToon, RESOLUTION_TTL_MS, MMR_TTL_MS },
};
