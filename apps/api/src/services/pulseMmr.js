"use strict";

// SC2Pulse-backed current MMR for the session widget.
//
// The agent populates `myMmr` on each game record when sc2reader
// exposes a real rating, but a sizable cohort of replays (older Battle.net
// builds, mods, custom games) ship with no rating at all. The session
// widget's stored tiers reach back through 14 days and then any-time-ever
// for a game-time myMmr, but those values cannot describe the rating after
// the just-finished match. This service resolves the streamer's CURRENT 1v1
// ladder rating directly from sc2pulse.nephest.com using their saved
// `pulseId`. Stored MMR remains the fail-soft fallback on a Pulse miss.
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
// Per-race breakdown TTL. Much longer than the overlay's single-MMR
// cache: a ladder rating barely moves within an hour, opponent profiles
// are opened far more often than that, and each miss costs an SC2Pulse
// round-trip we'd rather not spend (shared server IP across all users).
const RACE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// BattleTag resolution TTL. A BattleTag effectively never changes
// (Blizzard charges for renames), so we hold both hits AND misses for
// a day — the miss caching is what bounds the retry cost when a
// profile's pulse id simply doesn't resolve on SC2Pulse.
const BTAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** @type {Record<number, string>} */
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
 *   revealedName?: string | null,
 *   league?: string | null,
 *   tier?: number | null,
 * }} PulseMmrEntry
 */

class PulseMmrService {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   cacheTtlMs?: number,
   *   raceCacheTtlMs?: number,
   *   btagCacheTtlMs?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" ? opts.cacheTtlMs : CACHE_TTL_MS;
    this.raceCacheTtlMs =
      typeof opts.raceCacheTtlMs === "number"
        ? opts.raceCacheTtlMs
        : RACE_CACHE_TTL_MS;
    this.btagCacheTtlMs =
      typeof opts.btagCacheTtlMs === "number"
        ? opts.btagCacheTtlMs
        : BTAG_CACHE_TTL_MS;
    /** @type {Map<string, PulseMmrEntry>} */
    this._cache = new Map();
    /**
     * Current-season ids keyed by numeric region code, plus one
     * ``"__fetchedAt__"`` bookkeeping entry timestamping the last
     * refresh — see ``_currentSeasonsByRegion``.
     * @type {Map<string|number, number>}
     */
    this._seasonCache = new Map();
    /**
     * Per-race breakdown cache, keyed like the ``any:`` MMR cache.
     * Separate map because the payload shape differs (an array of
     * per-race rows, not a single mmr/region pair).
     * @type {Map<string, {races: Array<{race: string, mmr: number, games: number, league: string|null, region: string|null}>, fetchedAt: number}>}
     */
    this._raceCache = new Map();
    /**
     * BattleTag cache, keyed by the RAW profile identifier (numeric id
     * or toon handle, as stored in ``users.pulseIds``). Caches misses
     * too (``battleTag: null``) so an unresolvable id doesn't cost an
     * SC2Pulse round-trip on every profile read.
     * @type {Map<string, {battleTag: string|null, fetchedAt: number}>}
     */
    this._btagCache = new Map();
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
   * @returns {Promise<{mmr: number, region: string|null, characterId: string|null, revealedName: string|null, league: string|null, tier: number|null}|null>}
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
      return {
        mmr: cached.mmr,
        region: cached.region,
        characterId: id,
        revealedName: cached.revealedName ?? null,
        league: cached.league ?? null,
        tier: cached.tier ?? null,
      };
    }
    const fetched = await this._fetchTeams(id);
    if (fetched) {
      const entry = { ...fetched, fetchedAt: now };
      this._cache.set(id, entry);
      return {
        mmr: entry.mmr,
        region: entry.region,
        characterId: id,
        revealedName: entry.revealedName ?? null,
        league: entry.league ?? null,
        tier: entry.tier ?? null,
      };
    }
    // Stale-while-error: a network blip shouldn't strip the streamer's
    // MMR off the overlay if we already had a value cached.
    if (cached) {
      return {
        mmr: cached.mmr,
        region: cached.region,
        characterId: id,
        revealedName: cached.revealedName ?? null,
        league: cached.league ?? null,
        tier: cached.tier ?? null,
      };
    }
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
   * @returns {Promise<{mmr: number, region: string|null, characterId: string|null, revealedName: string|null}|null>}
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
   * Resolve current 1v1 MMR across an arbitrary list of pulse identifiers
   * (mixed numeric SC2Pulse character ids and raw sc2reader toon handles).
   * The list is what the streamer's profile stores under ``users.pulseIds``
   * — multi-region accounts and historical toons all live in there, and
   * the session widget needs to pick whichever team SC2Pulse says was
   * played most recently across the union, not just the first id.
   *
   * Toon handles are resolved to numeric character ids via
   * ``/character/search`` (cached). Numeric ids pass through as-is.
   * The deduped numeric set is then fed to ``/group/team`` ONCE per
   * region (SC2Pulse accepts repeated ``characterId`` query params), so
   * adding a tenth pulse id to a profile costs zero extra round-trips
   * — the fan-out is bounded by the number of regions, not the size of
   * the id list.
   *
   * When ``opts.preferredRegion`` is supplied, candidates from that
   * region win over candidates from any other region, regardless of
   * SC2Pulse's ``lastPlayed`` ordering. This stops a multi-region
   * profile from pinning to a stale-but-recently-touched team in the
   * wrong region: the streamer's most recent game tells us where they
   * actually played, and SC2Pulse's idea of "most recent" can lag or
   * point at an account the streamer no longer recognises. Within the
   * preferred region the same lastPlayed-then-rating sort applies.
   * Falls back to the unfiltered global sort when no candidate exists
   * in the preferred region.
   *
   * Returns ``null`` when:
   *   - The list is empty or every entry failed to normalise.
   *   - SC2Pulse returned no teams in any region for any id.
   *   - The remote request failed and there's no usable cache entry.
   *
   * ``opts.forceRefresh`` bypasses a still-live MMR cache entry. The
   * post-game session fan-out uses it once after a newly-finished replay
   * lands; otherwise the widget can keep showing the pre-game rating for
   * the full five-minute cache TTL. A failed forced fetch still falls
   * back to the cached value (stale-while-error).
   *
   * @param {Array<string|null|undefined>|null|undefined} ids
   * @param {{preferredRegion?: string, forceRefresh?: boolean}} [opts]
   * @returns {Promise<{mmr: number, region: string|null, revealedName: string|null, league: string|null, tier: number|null}|null>}
   */
  async getCurrentMmrForAny(ids, opts = {}) {
    if (!Array.isArray(ids) || ids.length === 0) return null;
    // Reuse the toon→characterId memoisation so a 3-id profile doesn't
    // spend three /character/search calls every overlay refresh once
    // the mapping has been resolved once.
    const numericIds = await this._normaliseToNumericIds(ids);
    if (numericIds.length === 0) return null;
    const preferredRegion =
      typeof opts.preferredRegion === "string" && opts.preferredRegion
        ? opts.preferredRegion.toUpperCase()
        : null;
    // Cache the joint lookup under a key that's order-insensitive so the
    // same profile resolves the same cache slot regardless of how the
    // user reordered their chips in Settings. The preferred-region
    // hint is part of the key — switching regions mid-day should pick
    // up a fresh pick without waiting on the 5-minute TTL.
    const cacheKey =
      "any:" +
      numericIds.slice().sort().join(",") +
      (preferredRegion ? `:pref=${preferredRegion}` : "");
    const now = this.now();
    const cached = this._cache.get(cacheKey);
    if (
      !opts.forceRefresh &&
      cached &&
      now - cached.fetchedAt < this.cacheTtlMs
    ) {
      return {
        mmr: cached.mmr,
        region: cached.region,
        revealedName: cached.revealedName ?? null,
        league: cached.league ?? null,
        tier: cached.tier ?? null,
      };
    }
    const fetched = await this._fetchTeams(numericIds, { preferredRegion });
    if (fetched) {
      this._cache.set(cacheKey, { ...fetched, fetchedAt: now });
      return fetched;
    }
    // Stale-while-error: same contract as the single-id path. A network
    // blip shouldn't strip a previously-good MMR off the overlay.
    if (cached) {
      return {
        mmr: cached.mmr,
        region: cached.region,
        revealedName: cached.revealedName ?? null,
        league: cached.league ?? null,
        tier: cached.tier ?? null,
      };
    }
    return null;
  }

  /**
   * Resolve toon → characterId, memoising the mapping. Idempotent wrapper
   * around ``_resolveCharacterIdFromToon`` so the multi-id path can call
   * it for each toon entry without paying repeated /character/search
   * round-trips on subsequent overlay ticks.
   *
   * @private
   * @param {string} handle
   * @returns {Promise<string|null>}
   */
  async _resolveCharacterIdFromToonCached(handle) {
    const cacheKey = `toon:${handle}`;
    const mapped = this._cache.get(cacheKey);
    if (mapped && typeof mapped.characterId === "string") {
      return mapped.characterId;
    }
    const characterId = await this._resolveCharacterIdFromToon(handle);
    if (!characterId) return null;
    this._cache.set(cacheKey, {
      characterId,
      mmr: 0,
      region: null,
      fetchedAt: this.now(),
    });
    return characterId;
  }

  /**
   * @private
   * @param {string|string[]} pulseIdOrIds
   * @param {{preferredRegion?: string|null}} [opts]
   * @returns {Promise<{mmr: number, region: string|null, revealedName: string|null, league: string|null, tier: number|null}|null>}
   */
  async _fetchTeams(pulseIdOrIds, opts = {}) {
    const ids = Array.isArray(pulseIdOrIds) ? pulseIdOrIds : [pulseIdOrIds];
    const candidates = await this._collectTeamCandidates(ids);
    if (candidates.length === 0) return null;
    // Region preference: if the caller pinned a region (from the
    // streamer's most recent game), candidates from that region win
    // over everything else. The user's last-played region is the
    // strongest signal of "where they're currently grinding"; SC2Pulse's
    // ``lastPlayed`` field can lag or point at a stale-but-touched
    // account on a different ladder. Falls through to the global sort
    // only when no team exists in the preferred region.
    const preferredRegion =
      typeof opts.preferredRegion === "string" && opts.preferredRegion
        ? opts.preferredRegion.toUpperCase()
        : null;
    if (preferredRegion) {
      const preferred = candidates.filter((c) => c.region === preferredRegion);
      if (preferred.length > 0) {
        preferred.sort(
          (a, b) =>
            b.lastPlayedMs - a.lastPlayedMs || b.rating - a.rating,
        );
        const best = preferred[0];
        return {
          mmr: Math.round(best.rating),
          region: best.region,
          revealedName: pickRevealedName(preferred),
          league: best.league ?? null,
          tier: best.tier ?? null,
        };
      }
    }
    // Pick the team played most recently; tie-break on highest rating
    // so a streamer who hasn't queued today still sees their peak.
    candidates.sort(
      (a, b) =>
        b.lastPlayedMs - a.lastPlayedMs || b.rating - a.rating,
    );
    const best = candidates[0];
    return {
      mmr: Math.round(best.rating),
      region: best.region,
      revealedName: pickRevealedName(candidates),
      league: best.league ?? null,
      tier: best.tier ?? null,
    };
  }

  /**
   * Fetch every 1v1 team carrying any of ``ids`` across all regions'
   * current seasons and return the raw candidate rows (rating, region,
   * race, games, league, lastPlayed). Shared by ``_fetchTeams`` (which
   * collapses to a single most-recent pick) and ``getRaceBreakdown``
   * (which groups by race). No collapsing / sorting here — callers
   * apply their own policy.
   *
   * @private
   * @param {string[]} ids numeric SC2Pulse character ids
   * @param {{onlyRegion?: string|null, throwOnError?: boolean}} [opts] when ``onlyRegion`` maps
   *   to a known SC2Pulse region, query ONLY that region's current
   *   season. A characterId belongs to exactly one region, so when the
   *   caller knows the opponent's region this is one HTTP call instead
   *   of one per region. Ignored (all regions) when the hint is absent
   *   or unrecognised.
   * @returns {Promise<Array<{
   *   rating: number, lastPlayedMs: number, region: string|null,
   *   race: string|null, games: number, league: string|null,
   *   tier: number|null, revealedName: string|null,
   * }>>}
   */
  async _collectTeamCandidates(ids, opts = {}) {
    if (!this.fetchImpl) {
      if (opts.throwOnError) throw new Error("SC2Pulse fetch unavailable");
      return [];
    }
    if (!Array.isArray(ids) || ids.length === 0) return [];
    // Probe per-region — SC2Pulse's /group/team returns nothing without
    // a season id, and seasons are scoped per region. The legacy SPA
    // walked every region's current season; we do the same so the
    // session widget tracks whichever region the streamer is on now.
    const seasons = await this._currentSeasonsByRegion({
      throwOnError: opts.throwOnError === true,
    });
    if (seasons.size === 0) return [];
    /** @type {Array<{rating: number, lastPlayedMs: number, region: string|null, race: string|null, games: number, league: string|null, tier: number|null, revealedName: string|null}>} */
    const candidates = [];
    // SC2Pulse's /group/team accepts repeated ``characterId`` query
    // params and returns the union — one HTTP call carries every id in
    // the profile, so multi-id profiles don't multiply the round-trip.
    const idsParam = ids
      .map((id) => `characterId=${encodeURIComponent(id)}`)
      .join("&");
    // Region scoping: a characterId lives in exactly one region, so when
    // the caller knows it (the opponent deep-dive does, from the toon
    // handle) we restrict to that region's current season — one call
    // rather than four. An unknown / non-SC2Pulse region (e.g. "SEA")
    // falls back to all regions.
    const onlyRegionCode = pulseRegionCode(opts && opts.onlyRegion);
    let scoped = [...seasons.entries()];
    if (onlyRegionCode !== null) {
      const restricted = scoped.filter(([rc]) => rc === onlyRegionCode);
      if (restricted.length > 0) scoped = restricted;
    }
    // Dedupe the query by season id. SC2Pulse season battlenetIds are
    // NOT unique across regions — NA's season 67, EU's 67 and KR's 67
    // all share ``battlenetId=67``, and a single ``season=67`` query
    // returns every region's season-67 teams for the supplied ids. So
    // we query each DISTINCT season once (3 NA/EU/KR + 1 CN collapses
    // from 4 calls to 2) and decide validity per team below.
    const distinctSeasons = [...new Set(scoped.map(([, sid]) => sid))];
    // For labelling teams that don't carry their own region (only test
    // fixtures in practice — real Pulse rows always do): a season that
    // maps to exactly one region can borrow that region's label.
    /** @type {Map<number, number[]>} */
    const seasonToRegions = new Map();
    for (const [rc, sid] of seasons) {
      const list = seasonToRegions.get(sid);
      if (list) list.push(rc);
      else seasonToRegions.set(sid, [rc]);
    }
    /** @type {Set<string|number>} */
    const seenTeamIds = new Set();
    for (const seasonId of distinctSeasons) {
      const url =
        `${PULSE_API_ROOT}/group/team` +
        `?season=${seasonId}` +
        `&queue=${PULSE_QUEUE}` +
        `&${idsParam}`;
      const teams = await this._getJson(url, {
        throwOnError: opts.throwOnError === true,
      });
      if (!Array.isArray(teams)) {
        if (opts.throwOnError) throw new Error("SC2Pulse team response malformed");
        continue;
      }
      for (const team of teams) {
        const rating = Number(team && team.rating);
        if (!Number.isFinite(rating) || rating <= 0) continue;
        // A team is valid iff the region it belongs to has THIS season
        // as its CURRENT season. This both (a) rejects cross-region /
        // cross-season contamination — CN's current season number (54)
        // equals an ancient NA/EU/KR season, so a ``season=54`` query
        // returns those regions' years-old teams, which the per-race
        // breakdown would otherwise surface as a long-retired peak (a
        // 5920 Protoss over the live 5584) — and (b) lets the NA/EU/KR
        // season-67 collision collapse into one query while still
        // keeping each region's real team. When the caller scoped to
        // one region we additionally drop other regions' teams.
        const teamRegionCode = pulseRegionCode(team && team.region);
        if (teamRegionCode !== null) {
          if (seasons.get(teamRegionCode) !== seasonId) continue;
          if (onlyRegionCode !== null && teamRegionCode !== onlyRegionCode) {
            continue;
          }
        }
        const teamId = team && (team.id != null ? team.id : null);
        if (teamId != null) {
          if (seenTeamIds.has(teamId)) continue;
          seenTeamIds.add(teamId);
        }
        const lastPlayedMs = parseTimestamp(team.lastPlayed);
        // Region from the team itself (real Pulse rows always carry it).
        // Fallback only for region-less fixtures: the scoped region, or
        // the lone region owning this season.
        const regionsForSeason = seasonToRegions.get(seasonId) || [];
        const fallbackRegionCode =
          onlyRegionCode !== null
            ? onlyRegionCode
            : regionsForSeason.length === 1
              ? regionsForSeason[0]
              : null;
        const region =
          pulseRegionLabel(team && team.region)
          || (fallbackRegionCode !== null
            ? REGION_CODE_TO_LABEL[fallbackRegionCode]
            : null)
          || null;
        const { race, games } = teamRaceAndGames(team);
        candidates.push({
          rating,
          lastPlayedMs,
          region,
          race,
          games,
          league: teamLeagueLabel(team),
          tier: teamTierNumber(team),
          revealedName: teamProNickname(team),
        });
      }
    }
    return candidates;
  }

  /**
   * Per-race 1v1 MMR breakdown for an opponent (mixed numeric ids +
   * toon handles, resolved like ``getCurrentMmrForAny``). Returns one
   * row per race the character has a current-season 1v1 team for,
   * sorted by MMR descending. This is the data the opponent profile
   * renders so a Protoss main who off-races Zerg shows BOTH ratings
   * instead of collapsing to whichever they queued most recently.
   *
   * Cached keyed on the resolved id set (+ region hint); serves stale
   * on a Pulse error so a blip doesn't blank the table. Uses a longer
   * TTL than the overlay's single-MMR cache — a ladder rating barely
   * moves within an hour, and the deep-dive is opened far more often
   * than a streamer's own rating changes.
   *
   * @param {string[]} ids
   * @param {{preferredRegion?: string|null, throwOnError?: boolean}} [opts] when set, query only
   *   that region's current season (the opponent's characterId lives in
   *   exactly one region) — one SC2Pulse call instead of one per region.
   * @returns {Promise<Array<{
   *   race: string, mmr: number, games: number,
   *   league: string|null, region: string|null,
   * }>>}
   */
  async getRaceBreakdown(ids, opts = {}) {
    const numericIds = await this._normaliseToNumericIds(ids);
    if (numericIds.length === 0) return [];
    const preferredRegion =
      typeof opts.preferredRegion === "string" && opts.preferredRegion
        ? opts.preferredRegion.toUpperCase()
        : null;
    const cacheKey =
      "races:" +
      numericIds.slice().sort().join(",") +
      (preferredRegion ? `:${preferredRegion}` : "");
    const now = this.now();
    const cached = this._raceCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this.raceCacheTtlMs) {
      return cached.races;
    }
    const candidates = await this._collectTeamCandidates(numericIds, {
      onlyRegion: preferredRegion,
      throwOnError: opts.throwOnError === true,
    });
    if (candidates.length === 0) {
      // Stale-while-error: keep the last good breakdown on a miss.
      if (cached) return cached.races;
      return [];
    }
    // Group by race; keep the highest-rated team per race (a character
    // can carry the same race across regions — surface their best).
    /** @type {Map<string, {race: string, mmr: number, games: number, league: string|null, region: string|null}>} */
    const byRace = new Map();
    for (const c of candidates) {
      if (!c.race) continue;
      const existing = byRace.get(c.race);
      if (!existing || c.rating > existing.mmr) {
        byRace.set(c.race, {
          race: c.race,
          mmr: Math.round(c.rating),
          games: c.games,
          league: c.league,
          region: c.region,
        });
      }
    }
    const races = Array.from(byRace.values()).sort((a, b) => b.mmr - a.mmr);
    this._raceCache.set(cacheKey, { races, fetchedAt: now });
    return races;
  }

  /**
   * Resolve the Battle.net BattleTag(s) behind a list of pulse
   * identifiers (mixed numeric SC2Pulse character ids and raw toon
   * handles — the exact shape of ``users.pulseIds``).
   *
   * SC2Pulse's ``/character/search`` response carries the owning
   * account's BattleTag (``members.account.battleTag``) — data this
   * service was already fetching for MMR lookups and throwing away.
   * Replays never contain the ``#discriminator``, so this is the ONLY
   * automated source for a real BattleTag short of Battle.net OAuth.
   *
   * One user can legitimately own several BattleTags: each Battle.net
   * ACCOUNT has exactly one, but a profile with multiple pulse ids
   * (multi-region streamers, smurf accounts) can span multiple
   * accounts. We therefore resolve per-id and return the deduped list
   * in input order — the caller decides which one is "primary".
   *
   * Best-effort throughout: an id that doesn't resolve (Pulse miss,
   * network failure, fake/anonymised account) is simply skipped, and
   * both hits and misses are cached for ``btagCacheTtlMs`` so repeated
   * profile reads don't hammer SC2Pulse.
   *
   * @param {Array<string|null|undefined>|string|null|undefined} ids
   * @returns {Promise<string[]>} deduped BattleTags, e.g. ["ReSpOnSe#1872"]
   */
  async getBattleTags(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      let tag = null;
      try {
        tag = await this._resolveBattleTagForId(raw.trim());
      } catch {
        tag = null;
      }
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
    return out;
  }

  /**
   * TTL-cached single-id BattleTag resolution. Caches misses as well —
   * see ``_btagCache``.
   *
   * @private
   * @param {string} id trimmed pulse identifier
   * @returns {Promise<string|null>}
   */
  async _resolveBattleTagForId(id) {
    const now = this.now();
    const cached = this._btagCache.get(id);
    if (cached && now - cached.fetchedAt < this.btagCacheTtlMs) {
      return cached.battleTag;
    }
    const fresh = await this._lookupBattleTag(id);
    // Stale-while-error on hits: only overwrite a previously-good tag
    // with null when there was no prior value (a genuine first miss).
    if (fresh || !cached || !cached.battleTag) {
      this._btagCache.set(id, { battleTag: fresh, fetchedAt: now });
      return fresh;
    }
    return cached.battleTag;
  }

  /**
   * Uncached BattleTag lookup for one identifier.
   *
   * Numeric SC2Pulse character ids need a two-step: ``/character/search``
   * does NOT match a bare numeric id (verified against the live API —
   * the docs' "numeric id" term type doesn't hit), but ``/character/{id}``
   * returns the character's region/realm/battlenetId, from which we
   * build the profile-URL search term that DOES match. Toon handles
   * decompose directly into the same URL forms (mirroring
   * ``_resolveCharacterIdFromToon``).
   *
   * @private
   * @param {string} id
   * @returns {Promise<string|null>}
   */
  async _lookupBattleTag(id) {
    const numeric = normalisePulseId(id);
    if (numeric) {
      const res = await this._getJson(`${PULSE_API_ROOT}/character/${numeric}`);
      const row = Array.isArray(res) ? res[0] : res;
      if (!row || typeof row !== "object") return null;
      const regionCode = pulseRegionCode(/** @type {any} */ (row).region);
      const realm = Number(/** @type {any} */ (row).realm);
      const bnid = Number(/** @type {any} */ (row).battlenetId);
      if (regionCode === null || !Number.isFinite(realm) || !Number.isFinite(bnid)) {
        return null;
      }
      return this._searchBattleTagByTerms(
        profileUrlTerms(String(regionCode), String(realm), String(bnid)),
      );
    }
    const handle = normaliseToonHandle(id);
    if (!handle) return null;
    const parsed = parseToonHandle(handle);
    if (!parsed) return null;
    // Bare handle first (cheapest when SC2Pulse's TOON_HANDLE matcher
    // recognises it), then the URL forms — same fallback ladder as the
    // character-id resolver.
    return this._searchBattleTagByTerms([
      handle,
      ...profileUrlTerms(parsed.region, parsed.realm, parsed.id),
    ]);
  }

  /**
   * Run ``/character/search`` over each term until a hit carries a
   * usable ``account.battleTag``.
   *
   * @private
   * @param {string[]} terms
   * @returns {Promise<string|null>}
   */
  async _searchBattleTagByTerms(terms) {
    for (const term of terms) {
      const url =
        `${PULSE_API_ROOT}/character/search` +
        `?term=${encodeURIComponent(term)}`;
      const hits = await this._getJson(url);
      if (!Array.isArray(hits)) continue;
      for (const hit of hits) {
        const tag = extractBattleTag(hit);
        if (tag) return tag;
      }
    }
    return null;
  }

  /**
   * Normalise a mixed list of SC2Pulse character ids + raw toon handles
   * into a deduped list of numeric character ids (resolving toons via
   * the cached ``/character/search`` mapping). Shared by
   * ``getCurrentMmrForAny`` and ``getRaceBreakdown``.
   *
   * @private
   * @param {Array<string|null|undefined>|string} ids
   * @returns {Promise<string[]>}
   */
  async _normaliseToNumericIds(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    /** @type {string[]} */
    const numericIds = [];
    const seen = new Set();
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const numeric = normalisePulseId(raw);
      if (numeric) {
        if (!seen.has(numeric)) {
          seen.add(numeric);
          numericIds.push(numeric);
        }
        continue;
      }
      const toon = normaliseToonHandle(raw);
      if (!toon) continue;
      const resolved = await this._resolveCharacterIdFromToonCached(toon);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        numericIds.push(resolved);
      }
    }
    return numericIds;
  }

  /**
   * Map every region we recognise to its CURRENT season id. Cached for
   * the lifetime of the cache entry — seasons roll quarterly and a
   * stale id just means we miss the very latest matches for a few
   * minutes after a season change.
   *
   * @private
   * @param {{throwOnError?: boolean}} [opts]
   * @returns {Promise<Map<number, number>>}
   */
  async _currentSeasonsByRegion(opts = {}) {
    const now = this.now();
    const cached = this._seasonCache.get("__fetchedAt__");
    if (cached && now - cached < this.cacheTtlMs && this._seasonCache.size > 1) {
      const out = new Map();
      for (const [k, v] of this._seasonCache) {
        if (typeof k === "number") out.set(k, v);
      }
      if (out.size > 0) return out;
    }
    const list = await this._getJson(`${PULSE_API_ROOT}/season/list/all`, opts);
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
    } else if (opts.throwOnError) {
      throw new Error("SC2Pulse season response unavailable");
    }
    return byRegion;
  }

  /**
   * @private
   * @param {string} url
   * @param {{throwOnError?: boolean}} [opts]
   * @returns {Promise<any|null>}
   */
  async _getJson(url, opts = {}) {
    if (!this.fetchImpl) {
      if (opts.throwOnError) throw new Error("SC2Pulse fetch unavailable");
      return null;
    }
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
      if (!res || !res.ok) {
        if (opts.throwOnError) {
          const status = res && typeof res.status === "number" ? res.status : "unknown";
          throw new Error(`SC2Pulse request failed (${status})`);
        }
        return null;
      }
      return await res.json();
    } catch (err) {
      if (opts.throwOnError) throw err;
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
 *   - ``{members: {character: {id, ...}}, ...}`` — the modern
 *     ``/character/search`` shape: a ``LadderDistinctCharacter`` whose
 *     ``members`` is a SINGULAR object (not an array). This is what the
 *     live endpoint returns for a profile-URL term, so without handling
 *     it the toon→id resolution (``getCurrentMmrByToon`` / a raw toon
 *     handle fed to ``getRaceBreakdown``) silently returned null and an
 *     opponent's MMR only landed later via the cloud resolver's
 *     separate ``/character/search/advanced`` path.
 *
 * We accept every shape so a SC2Pulse refactor (or a search that
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
  } else if (obj.members && typeof obj.members === "object") {
    // ``members`` (singular object) — the modern /character/search
    // ``LadderDistinctCharacter`` carries the character one level down
    // under ``members.character``.
    const id = pickIdFromCharacter(obj.members.character);
    if (id) return id;
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
 * The two Blizzard profile-URL spellings SC2Pulse's search accepts,
 * current host first. Shared by the toon-handle and numeric-id
 * BattleTag resolvers.
 *
 * @param {string} region numeric region byte ("1".."5")
 * @param {string} realm
 * @param {string} id Blizzard battlenetId
 * @returns {string[]}
 */
function profileUrlTerms(region, realm, id) {
  return [
    `https://starcraft2.com/en-us/profile/${region}/${realm}/${id}`,
    `https://starcraft2.blizzard.com/en-us/profile/${region}/${realm}/${id}`,
  ];
}

/**
 * Pluck ``account.battleTag`` out of a ``/character/search`` hit,
 * accepting the same response shapes as ``extractCharacterId`` (flat,
 * members-array, members-object, member-object).
 *
 * Two rejects beyond shape checks:
 *   - SC2Pulse synthesises placeholder tags shaped like ``f#123456``
 *     for accounts it couldn't resolve a real BattleTag for ("fake"
 *     accounts in Pulse parlance). Backfilling one of those into a
 *     user's profile would be worse than leaving the field empty.
 *   - Anything without a ``#`` or longer than the profile schema's
 *     80-char cap — never persist a value the PUT validator would
 *     reject if the user re-saved Settings.
 *
 * @param {unknown} hit
 * @returns {string|null}
 */
function extractBattleTag(hit) {
  if (!hit || typeof hit !== "object") return null;
  const obj = /** @type {any} */ (hit);
  /** @type {any[]} */
  const accounts = [];
  if (obj.account) accounts.push(obj.account);
  if (Array.isArray(obj.members)) {
    for (const m of obj.members) {
      if (m && typeof m === "object") accounts.push(m.account);
    }
  } else if (obj.members && typeof obj.members === "object") {
    accounts.push(obj.members.account);
  }
  if (obj.member && typeof obj.member === "object") {
    accounts.push(obj.member.account);
  }
  for (const account of accounts) {
    if (!account || typeof account !== "object") continue;
    const raw = account.battleTag;
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag.includes("#") || tag.startsWith("#") || tag.length > 80) continue;
    if (/^f#\d+$/i.test(tag)) continue; // SC2Pulse placeholder
    return tag;
  }
  return null;
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
  /** @type {Record<string, number>} */
  const map = { US: 1, NA: 1, EU: 2, KR: 3, CN: 5 };
  const code = map[raw.toUpperCase()];
  return typeof code === "number" ? code : null;
}

/**
 * SC2Pulse team objects carry their own region (either a numeric
 * code matching Blizzard's 1/2/3/5 scheme, or a label like
 * ``"US"`` / ``"EU"`` / ``"KR"`` / ``"CN"``). This helper normalises
 * either shape into the analyzer's canonical label set
 * (``"NA"`` / ``"EU"`` / ``"KR"`` / ``"CN"`` / ``"SEA"``).
 *
 * Reading the team's OWN region (instead of the loop's regionCode
 * in ``_fetchTeams``) is what fixes the pre-2026-05 bug where the
 * dashboard tagged an NA 5459 and an EU 5172 both as "KR" — Pulse's
 * /group/team filter is by ``battlenetId`` which collides across
 * regions, so each region query returned teams from other regions
 * too. The loop variable was the WRONG label every time the queried
 * region didn't actually own the team.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function pulseRegionLabel(raw) {
  const code = pulseRegionCode(raw);
  if (code === null) return null;
  return REGION_CODE_TO_LABEL[code] || null;
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

// SC2Pulse encodes league as an integer 0..6 (Bronze..Grandmaster),
// sometimes bare and sometimes wrapped as ``{ type: <int> }``.
const LEAGUE_LABELS = [
  "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster",
];

/**
 * Human league label for a SC2Pulse team, or null when absent /
 * out-of-range. Accepts the bare-int, ``{type}``-object, and numeric-
 * string shapes Pulse has emitted across versions.
 *
 * @param {any} team
 * @returns {string|null}
 */
function teamLeagueLabel(team) {
  const raw = team && team.league;
  let n = null;
  if (typeof raw === "number") n = raw;
  else if (raw && typeof raw === "object" && typeof raw.type === "number") {
    n = raw.type;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null || n < 0 || n >= LEAGUE_LABELS.length) return null;
  return LEAGUE_LABELS[n];
}

/**
 * 1-based ladder tier for a SC2Pulse team, or null when absent /
 * out-of-range. SC2Pulse's ``tierType`` is 0-indexed (0..2) while
 * players say "Master 1" — same +1 convention as pulseOpponentIntel.
 * Grandmaster has no tiers on Blizzard's ladder (it's a single top-N
 * bucket), so GM teams return null rather than a misleading
 * "Grandmaster 1".
 *
 * @param {any} team
 * @returns {number|null}
 */
function teamTierNumber(team) {
  if (teamLeagueLabel(team) === "Grandmaster") return null;
  const raw = team && team.tierType;
  let n = null;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null || !Number.isInteger(n) || n < 0 || n > 2) return null;
  return n + 1;
}

// 1v1 LotV teams are race-specific; the member carries per-race game
// counts and exactly one is non-trivial for that team's race. argmax
// gives the team's race + its game count (matches nephest's per-race
// "Games" column). Mirrors the agent's ``_candidate_top_race``.
const RACE_COUNT_FIELDS = [
  ["Protoss", "protossGamesPlayed"],
  ["Terran", "terranGamesPlayed"],
  ["Zerg", "zergGamesPlayed"],
  ["Random", "randomGamesPlayed"],
];

/**
 * Resolve a SC2Pulse 1v1 team's race + game count from its member's
 * per-race counters. Handles the ``members: [..]`` (modern) and
 * ``members: {..}`` (legacy) shapes.
 *
 * @param {any} team
 * @returns {{race: string|null, games: number}}
 */
function teamRaceAndGames(team) {
  const members = team && team.members;
  let m = null;
  if (Array.isArray(members) && members.length) m = members[0];
  else if (members && typeof members === "object") m = members;
  if (!m || typeof m !== "object") return { race: null, games: 0 };
  let bestRace = null;
  let bestGames = -1;
  for (const [race, field] of RACE_COUNT_FIELDS) {
    const n = Number(m[field]);
    if (Number.isFinite(n) && n > bestGames) {
      bestGames = n;
      bestRace = race;
    }
  }
  return { race: bestRace, games: bestGames > 0 ? bestGames : 0 };
}

/**
 * Pull the SC2Pulse "revealed" name off a team's member. When a barcode
 * (or any anonymised account) is linked to a known pro/main on
 * sc2pulse.nephest.com, the ``LadderTeamMember`` carries a
 * ``proNickname`` — the human-readable identity SC2Pulse shows behind
 * the bars (e.g. "THERIDDLER"). Replays never carry this; it's a pure
 * SC2Pulse community-curated overlay, so this is the only automated
 * source for it. Handles the ``members: [..]`` (modern) and
 * ``members: {..}`` (legacy) shapes, same as ``teamRaceAndGames``.
 *
 * @param {any} team
 * @returns {string|null} sanitised pro nickname, or null when absent.
 */
function teamProNickname(team) {
  const members = team && team.members;
  let m = null;
  if (Array.isArray(members) && members.length) m = members[0];
  else if (members && typeof members === "object") m = members;
  if (!m || typeof m !== "object") return null;
  const raw = m.proNickname;
  if (typeof raw !== "string") return null;
  const tag = raw.trim();
  // Cap length defensively so a malformed payload can't bloat the
  // opponents row / overlay payload. 80 mirrors the BattleTag cap.
  if (!tag || tag.length > 80) return null;
  return tag;
}

/**
 * First non-null ``revealedName`` across a candidate list. The pro
 * nickname is character-bound, so any team carrying it identifies the
 * same revealed player regardless of which team we ultimately pick for
 * MMR — surface it even when the highest-MMR / most-recent team's
 * member happened to omit it.
 *
 * @param {Array<{revealedName?: string|null}>} candidates
 * @returns {string|null}
 */
function pickRevealedName(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const c of candidates) {
    if (c && typeof c.revealedName === "string" && c.revealedName) {
      return c.revealedName;
    }
  }
  return null;
}

module.exports = { PulseMmrService };
