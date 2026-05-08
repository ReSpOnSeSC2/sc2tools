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
 * Cache entry shape. The team-scan path stores ``mmr`` + ``region``;
 * the toon→characterId mapping path also stashes ``characterId`` so a
 * follow-up call can skip the /character/search round-trip.
 *
 * @typedef {{
 *   mmr: number,
 *   region: string | null,
 *   fetchedAt: number,
 *   characterId?: string,
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
    if (!id) {
      // Permissive fallback: a streamer who pasted their raw toon
      // handle (``"2-S2-1-267727"``) into Settings → Profile → Pulse ID
      // shouldn't see "EU —" forever. Treat it as a toon handle and run
      // the SC2Pulse character search before giving up.
      const handle = normaliseToonHandle(pulseId);
      if (handle) return this.getCurrentMmrByToon(handle);
      return null;
    }
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
   * Resolve current 1v1 MMR for a streamer who hasn't given us a
   * canonical SC2Pulse character id, only their raw sc2reader
   * ``toon_handle`` (e.g. ``"2-S2-1-267727"`` — region-season-realm-id).
   *
   * Two-step round-trip: SC2Pulse ``/character/search`` accepts the
   * legacy battlenet account url that the toon handle decodes into
   * (``starcraft2.blizzard.com/profile/<region>/<realm>/<id>``), and
   * returns the canonical numeric character id. We then forward that
   * to ``getCurrentMmr`` so the existing cache + per-region team scan
   * applies. The intermediate handle→id mapping is cached separately
   * so a re-resolve only costs the team scan, not another search.
   *
   * Returns null when:
   *   - The handle isn't shaped like ``<region>-S<season>-<realm>-<id>``
   *     so we can't build the search URL.
   *   - SC2Pulse doesn't recognise the account.
   *   - The character has no team in the active season for any region.
   *
   * @param {string|null|undefined} toonHandle
   * @returns {Promise<{mmr: number, region: string|null}|null>}
   */
  async getCurrentMmrByToon(toonHandle) {
    const handle = normaliseToonHandle(toonHandle);
    if (!handle) return null;
    const cacheKey = `toon:${handle}`;
    const now = this.now();
    const mappedId = this._cache.get(cacheKey);
    if (mappedId && typeof mappedId.characterId === "string") {
      // Cached toon→id mapping is still valid. Recurse into the numeric
      // path so the same TTL-aware cache + stale-while-error semantics
      // apply for the team scan.
      const fresh = await this.getCurrentMmr(mappedId.characterId);
      if (fresh) return fresh;
    }
    const characterId = await this._resolveCharacterIdFromToon(handle);
    if (!characterId) return null;
    // Persist the toon→id mapping so we don't re-hit /character/search
    // on every session-widget tick. The numeric MMR cache has its own
    // entry under ``characterId`` keyed by ``id``; this entry only
    // memoises the cheap mapping side.
    this._cache.set(cacheKey, {
      characterId,
      mmr: 0,
      region: null,
      fetchedAt: now,
    });
    return this.getCurrentMmr(characterId);
  }

  /**
   * @private
   * @param {string} handle  e.g. ``"2-S2-1-267727"``
   * @returns {Promise<string|null>} canonical SC2Pulse character id
   *
   * SC2Pulse's ``/character/search`` accepts the ``term`` parameter in
   * several shapes — name, BattleTag, ``[clan]`` tag, ``starcraft2.com``
   * profile URL, ``starcraft2.blizzard.com`` profile URL, raw toon
   * handle, or a numeric character id (per the published docs at
   * sc2pulse.nephest.com/sc2/?type=blog&blog-id=1). Earlier versions of
   * this resolver only tried the ``starcraft2.blizzard.com`` URL form
   * and gave up if SC2Pulse's regex didn't match — which silently broke
   * the session widget's MMR for streamers whose only signal was a
   * ``myToonHandle`` on a recent game. Try the cheapest form first
   * (the toon handle itself, which SC2Pulse accepts directly) and fall
   * through to the URL forms only if the bare handle misses, so a
   * regex tweak on either side of the API doesn't strand us again.
   *
   * The response is also defensive — SC2Pulse historically returned
   * either ``[{character: {id}}]`` (shallow) or
   * ``[{members: [{character: {id}}]}]`` (team-shaped). Accept either
   * because both have appeared in production payloads.
   */
  async _resolveCharacterIdFromToon(handle) {
    const parsed = parseToonHandle(handle);
    if (!parsed) return null;
    const candidates = [
      // Bare toon handle. SC2Pulse's TOON_HANDLE term type matches this
      // directly with no URL gymnastics. Cheapest happy path.
      handle,
      // starcraft2.com profile URL — Blizzard's current canonical
      // profile host as of the SC2 web rebrand.
      `https://starcraft2.com/en-us/profile/` +
        `${parsed.region}/${parsed.realm}/${parsed.id}`,
      // starcraft2.blizzard.com profile URL — the legacy form, still
      // documented as accepted by SC2Pulse. Kept as the last fallback
      // so a streamer whose only entry in the SC2Pulse cache happens
      // to be the legacy URL still resolves.
      `https://starcraft2.blizzard.com/en-us/profile/` +
        `${parsed.region}/${parsed.realm}/${parsed.id}`,
    ];
    for (const term of candidates) {
      const id = await this._searchCharacterIdByTerm(term);
      if (id) return id;
    }
    return null;
  }

  /**
   * @private
   * @param {string} term — exactly one ``term`` value to feed SC2Pulse.
   * @returns {Promise<string|null>} canonical character id, or null on
   *   miss / network failure / unparseable response.
   */
  async _searchCharacterIdByTerm(term) {
    const url =
      `${PULSE_API_ROOT}/character/search` +
      `?term=${encodeURIComponent(term)}`;
    const hits = await this._getJson(url);
    if (!Array.isArray(hits)) return null;
    for (const hit of hits) {
      const id = extractCharacterId(hit);
      if (id) return id;
    }
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
 * like "2-S2-1-267727" go through ``getCurrentMmrByToon`` instead — the
 * caller fans out automatically when this returns null.
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
 * Trim and shape-check a sc2reader toon handle. Returns the canonical
 * lowercased form (``"<region>-S<season>-<realm>-<id>"``) when the
 * shape matches, null otherwise.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normaliseToonHandle(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[1-9]-S\d+-\d+-\d+$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Pluck the canonical SC2Pulse character id out of a ``/character/search``
 * hit, regardless of which response shape SC2Pulse handed back. The
 * endpoint has historically returned either:
 *
 *   - ``{character: {id, battlenetId, ...}, ...}`` — flat
 *   - ``{members: [{character: {id, ...}}], ...}`` — team-shaped, when
 *     the term matched via the ranked-team index instead of the
 *     character-only index.
 *
 * We accept both so a future SC2Pulse refactor (or a search that
 * happens to land on the team index) doesn't blank the session widget.
 *
 * @param {unknown} hit
 * @returns {string|null}
 */
function extractCharacterId(hit) {
  if (!hit || typeof hit !== "object") return null;
  const obj = /** @type {any} */ (hit);
  const direct = pickIdFromCharacter(obj.character);
  if (direct) return direct;
  // ``members`` (plural array) is the canonical team-shape response.
  if (Array.isArray(obj.members)) {
    for (const m of obj.members) {
      if (!m || typeof m !== "object") continue;
      const id = pickIdFromCharacter(m.character);
      if (id) return id;
    }
  }
  // ``member`` (singular object) has appeared in some Pulse responses
  // and is exercised by an existing pulseMmr.test.js fixture; keep it
  // for backwards compatibility so a Pulse fork or older deployment
  // still resolves.
  if (obj.member && typeof obj.member === "object") {
    const id = pickIdFromCharacter(obj.member.character);
    if (id) return id;
  }
  return null;
}

/**
 * Read either ``character.id`` (SC2Pulse internal) or
 * ``character.battlenetId`` (Blizzard-side bnid). The internal id is
 * what every other SC2Pulse endpoint keys off, so prefer it; fall back
 * to battlenetId only when the search response truncated ``id`` (rare
 * but observed in older Pulse builds).
 *
 * @param {unknown} character
 * @returns {string|null}
 */
function pickIdFromCharacter(character) {
  if (!character || typeof character !== "object") return null;
  const ch = /** @type {any} */ (character);
  for (const key of ["id", "battlenetId"]) {
    const raw = ch[key];
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (/^[0-9]{1,12}$/.test(s)) return s;
  }
  return null;
}

/**
 * Decompose a toon handle into the parts SC2Pulse's ``/character/search``
 * needs to identify a battle.net account. Returns null when the shape
 * doesn't match — callers must already have run ``normaliseToonHandle``.
 *
 * @param {string} handle
 * @returns {{region: string, realm: string, id: string}|null}
 */
function parseToonHandle(handle) {
  // Shape: ``<region>-S<season>-<realm>-<id>``. We only need the
  // region byte, the realm, and the bnid — season is irrelevant to
  // the legacy profile URL.
  const m = /^([1-9])-S\d+-(\d+)-(\d+)$/.exec(handle);
  if (!m) return null;
  return { region: m[1], realm: m[2], id: m[3] };
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
