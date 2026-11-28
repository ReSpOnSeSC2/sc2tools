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

const PULSE_MATCHES_URL = "https://sc2pulse.nephest.com/sc2/api/matches";
const USER_AGENT = "sc2tools.com ladder-vods (+https://sc2tools.com)";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_LIMIT_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
/** At most one SC2Pulse call a second, however many visitors search. */
const PACE_MS = 1100;
/** A search that would wait longer than this for its turn is refused, so an outage cannot build a queue. */
const MAX_WAIT_MS = 4 * PACE_MS;
const ENABLE_FLAG = "SC2TOOLS_LADDER_VODS_ENABLED";

/** @typedef {import("./ladderVodSearch").LadderVod} LadderVod */
/** @typedef {import("./ladderVodSearch").Search} Search */
/** @typedef {import("./ladderVodSearch").PulseMatch} PulseMatch */
/** @typedef {import("./twitchVideoChannels").ChannelResolver} ChannelResolver */
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
/** @typedef {{ page: LadderVodsPage, at: number }} CacheEntry */
/** @typedef {{ available: false } | ({ available: true } & LadderVodsPage)} LadderVodsAnswer */

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
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   *   log?: { warn?: (fields: object, message: string) => void },
   * }} [options]
   */
  constructor({
    enabled = process.env[ENABLE_FLAG] === "1",
    fetchImpl = fetch,
    resolveChannels = async () => new Map(),
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    log,
  } = {}) {
    this.enabled = enabled;
    this.fetchImpl = fetchImpl;
    this.resolveChannels = resolveChannels;
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
    const search = parseSearch(input);
    if (!search) throw new LadderVodsError("invalid_search");
    const cached = this.cache.get(search.key);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return { available: true, ...cached.page };
    return { available: true, ...(await this.refresh(search, cached)) };
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
      .then(page => { this.remember(search.key, page); return page; })
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

  /** @param {string} key @param {LadderVodsPage} page */
  remember(key, page) {
    this.cache.delete(key);
    this.cache.set(key, { page, at: this.now() });
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(/** @type {string} */ (this.cache.keys().next().value));
  }

  /** @param {Search} search @returns {Promise<LadderVodsPage>} */
  async fetchPage(search) {
    await this.waitForTurn();
    const json = await this.callPulse(search.query);
    const rows = Array.isArray(json.result) ? json.result : [];
    const shaped = rows.flatMap(row => shapeMatch(row, search.matchup) ?? []);
    const channels = await this.channelsFor(shaped);
    const next = typeof json.navigation?.after === "string" && rows.length > 0 ? json.navigation.after : null;
    return {
      results: shaped.map(({ videoId, ...visible }) => ({ ...visible, channel: channels.get(videoId) ?? null })),
      next,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Reserves the next call slot; refuses when the wait would be long. */
  async waitForTurn() {
    const now = this.now();
    const slot = Math.max(now, this.nextCallAt);
    if (slot - now > MAX_WAIT_MS) throw new LadderVodsError("busy");
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
   * The channels are a nicety: when Twitch cannot name them the page still
   * lists the games, with a plain "Twitch VOD" link.
   *
   * @param {LadderVod[]} shaped @returns {Promise<Map<string, string>>}
   */
  async channelsFor(shaped) {
    try {
      return await this.resolveChannels(shaped.map(entry => entry.videoId));
    } catch (err) {
      this.log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "ladder vods channel lookup failed");
      return new Map();
    }
  }
}

module.exports = { LadderVodsService, LadderVodsError, CACHE_TTL_MS, STALE_LIMIT_MS, PACE_MS, ENABLE_FLAG };
