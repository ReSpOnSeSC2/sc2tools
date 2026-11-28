"use strict";

/**
 * Public ladder VOD finder: recent ladder games with a Twitch VOD, found
 * through SC2Pulse's `/sc2/api/matches`.
 *
 * The finder ships behind a gate that starts off (G2: SC2Pulse has not agreed
 * to this use). With the gate off `search()` answers "unavailable" and nothing
 * reaches SC2Pulse. With it on, a search costs at most one SC2Pulse call
 * (ten games), calls leave at least a second apart, the same search inside the
 * cache time costs none, and a failed refresh serves the last answer for up to
 * an hour. Visitors never choose free text: `ladderVodSearch.js` accepts only
 * fixed choices.
 */

const { parseSearch, shapeMatch } = require("./ladderVodSearch");
const { buildMapMenu, plainMapName } = require("./ladderVodMaps");

const PULSE_MATCHES_URL = "https://sc2pulse.nephest.com/sc2/api/matches";
const USER_AGENT = "sc2tools.com ladder-vods (+https://sc2tools.com)";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_LIMIT_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_LEARNED_MAPS = 40;
/** The Twitch channel names are a nicety: past this the games are listed without them. */
const CHANNEL_DEADLINE_MS = 3000;
/** At most one SC2Pulse call a second, however many visitors search. */
const PACE_MS = 1100;
/** A search that would wait longer than this for its turn is refused, so an outage cannot build a queue. */
const MAX_WAIT_MS = 4 * PACE_MS;
/** Later pages (visitor-chosen cursors) may only take the next free slot, so they cannot fill the queue. */
const MAX_WAIT_PAGED_MS = PACE_MS;
const ENABLE_FLAG = "SC2TOOLS_LADDER_VODS_ENABLED";

/** @typedef {import("./ladderVodSearch").LadderVod} LadderVod */
/** @typedef {import("./ladderVodSearch").Search} Search */
/** @typedef {import("./ladderVodSearch").PulseMatch} PulseMatch */
/** @typedef {import("./twitchVideoChannels").ChannelResolver} ChannelResolver */
/** @typedef {import("./ladderVodMaps").MapChoice} MapChoice */
/**
 * One page of results as the route serves it. `channel` is the streamer's
 * Twitch login, or null when Twitch did not name it.
 *
 * @typedef {{
 *   results: Array<Omit<LadderVod, "videoId"> & { channel: string | null }>,
 *   next: string | null,
 *   fetchedAt: string,
 * }} LadderVodsPage
 */
/** @typedef {{ page: LadderVodsPage, at: number, paged: boolean }} CacheEntry */
/** @typedef {{ available: false } | ({ available: true, maps: Array<{ id: string, name: string }> } & LadderVodsPage)} LadderVodsAnswer */

class LadderVodsError extends Error {
  /** @param {"invalid_search" | "busy" | "unavailable"} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class LadderVodsService {
  /**
   * @param {{
   *   enabled?: boolean,
   *   fetchImpl?: typeof fetch,
   *   resolveChannels?: ChannelResolver,
   *   mapPool?: { get: () => Promise<{ maps: string[] }> } | null,
   *   channelDeadlineMs?: number,
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   *   log?: { warn?: (fields: object, message: string) => void },
   * }} [options]
   */
  constructor({
    enabled = process.env[ENABLE_FLAG] === "1",
    fetchImpl = fetch,
    resolveChannels = async () => new Map(),
    mapPool = null,
    channelDeadlineMs = CHANNEL_DEADLINE_MS,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    log,
  } = {}) {
    this.enabled = enabled;
    this.fetchImpl = fetchImpl;
    this.resolveChannels = resolveChannels;
    this.mapPool = mapPool;
    this.channelDeadlineMs = channelDeadlineMs;
    /** @type {Map<number, string>} maps the match feed showed, by SC2Pulse id */
    this.learnedMaps = new Map();
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<LadderVodsPage>>} */
    this.inflight = new Map();
    this.nextCallAt = 0;
  }

  /**
   * @param {Record<string, unknown>} input the visitor's query
   * @returns {Promise<LadderVodsAnswer>}
   * @throws {LadderVodsError} invalid_search, busy (too many searches waiting) or unavailable (SC2Pulse failed and nothing earlier is left)
   */
  async search(input) {
    if (!this.enabled) return { available: false };
    const maps = await this.mapMenu();
    const search = parseSearch(input, maps);
    if (!search) throw new LadderVodsError("invalid_search");
    const menu = maps.map(({ id, name }) => ({ id: String(id), name }));
    const cached = this.cache.get(search.key);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return { available: true, maps: menu, ...cached.page };
    return { available: true, maps: menu, ...(await this.refresh(search, cached)) };
  }

  /** Whether the gate is open; costs no call. */
  isOpen() {
    return this.enabled;
  }

  /** @returns {Promise<MapChoice[]>} the maps on offer: the live 1v1 pool among the maps SC2Pulse showed */
  async mapMenu() {
    /** @type {string[] | null} */
    let poolNames = null;
    try {
      poolNames = (await this.mapPool?.get())?.maps ?? null;
    } catch (err) {
      this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "ladder vods map pool unavailable");
    }
    return buildMapMenu(this.learnedMaps, poolNames);
  }

  /** @param {PulseMatch[]} rows remembers the maps the feed shows, so a new ladder map can be chosen once seen */
  learnMaps(rows) {
    for (const row of rows) {
      const { id, name } = /** @type {{ id?: unknown, name?: unknown }} */ (row?.map ?? {});
      if (Number.isInteger(id) && typeof name === "string" && name && this.learnedMaps.size < MAX_LEARNED_MAPS) {
        this.learnedMaps.set(/** @type {number} */ (id), plainMapName(name));
      }
    }
  }

  /**
   * Concurrent callers of one search share one call. A failure serves the last
   * answer while it is under an hour old.
   *
   * @param {Search} search @param {CacheEntry | undefined} previous
   * @returns {Promise<LadderVodsPage>}
   */
  refresh(search, previous) {
    const running = this.inflight.get(search.key);
    if (running) return running;
    const work = this.fetchPage(search)
      .then(page => { this.remember(search, page); return page; })
      .catch(err => {
        if (!(err instanceof LadderVodsError)) {
          this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "ladder vods fetch failed");
        }
        if (previous && this.now() - previous.at < STALE_LIMIT_MS) return previous.page;
        throw err instanceof LadderVodsError ? err : new LadderVodsError("unavailable");
      })
      .finally(() => this.inflight.delete(search.key));
    this.inflight.set(search.key, work);
    return work;
  }

  /** @param {Search} search @param {LadderVodsPage} page */
  remember({ key, paged }, page) {
    this.cache.delete(key);
    this.cache.set(key, { page, at: this.now(), paged });
    while (this.cache.size > MAX_CACHE_ENTRIES) this.evictOne();
  }

  /** Later pages go first, so visitor-chosen cursors cannot push out the popular first pages. */
  evictOne() {
    for (const [key, entry] of this.cache) {
      if (entry.paged) {
        this.cache.delete(key);
        return;
      }
    }
    this.cache.delete(/** @type {string} */ (this.cache.keys().next().value));
  }

  /** @param {Search} search @returns {Promise<LadderVodsPage>} */
  async fetchPage(search) {
    await this.waitForTurn(search.paged ? MAX_WAIT_PAGED_MS : MAX_WAIT_MS);
    const json = await this.callPulse(search.query);
    const rows = Array.isArray(json.result) ? json.result : [];
    this.learnMaps(rows);
    const shaped = rows.flatMap(row => shapeMatch(row, search.matchup, search.ratingBand) ?? []);
    const channels = await this.channelsFor(shaped);
    const next = typeof json.navigation?.after === "string" && rows.length > 0 ? json.navigation.after : null;
    return {
      results: shaped.map(({ videoId, ...visible }) => ({ ...visible, channel: channels.get(videoId) ?? null })),
      next,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Reserves the next call slot; refuses when the wait would pass `maxWaitMs`. @param {number} maxWaitMs */
  async waitForTurn(maxWaitMs) {
    const now = this.now();
    const slot = Math.max(now, this.nextCallAt);
    if (slot - now > maxWaitMs) throw new LadderVodsError("busy");
    this.nextCallAt = slot + PACE_MS;
    if (slot > now) await this.sleep(slot - now);
  }

  /**
   * @param {URLSearchParams} query
   * @returns {Promise<{ result?: PulseMatch[], navigation?: { after?: string | null } }>}
   */
  async callPulse(query) {
    const response = await this.fetchImpl(`${PULSE_MATCHES_URL}?${query}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`pulse_http_${response.status}`);
    return response.json();
  }

  /**
   * The channels are a nicety: when Twitch cannot name them in time the page
   * still lists the games, with a plain "Watch the VOD" link.
   *
   * @param {LadderVod[]} shaped @returns {Promise<Map<string, string>>}
   */
  async channelsFor(shaped) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<never>} */
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("channel lookup deadline exceeded")), this.channelDeadlineMs);
    });
    try {
      return await Promise.race([this.resolveChannels(shaped.map(entry => entry.videoId)), deadline]);
    } catch (err) {
      this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "ladder vods channel lookup failed");
      return new Map();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { LadderVodsService, LadderVodsError, CACHE_TTL_MS, STALE_LIMIT_MS, PACE_MS, MAX_CACHE_ENTRIES, ENABLE_FLAG };
