"use strict";

/**
 * Live StarCraft II streams, cached for about a minute.
 *
 * `list()` is the one read other server code uses (the public route, and the
 * raid finder built on it). Concurrent callers share one provider fetch, an
 * expired list is served at once while the refresh runs behind it, a platform
 * that fails keeps its last good list for a few minutes and is reported as
 * `stale`, and a platform without credentials is `off`.
 */

const { PlatformOauthError } = require("./platformOauthHttp");
const { getTwitchAppToken } = require("./platformOauthClients");
const {
  fetchTwitchStreams,
  findKickCategoryId,
  fetchKickStreams,
  getKickAppToken,
} = require("./liveStreamProviders");

const CACHE_TTL_MS = 60 * 1000;
const STALE_LIMIT_MS = 10 * 60 * 1000;
/**
 * One platform's share of a refresh. The provider calls time out at 12 s, and
 * the page gives up at 10 s, so a hanging platform is cut off sooner and the
 * other platform's list still reaches the visitor.
 */
const PLATFORM_DEADLINE_MS = 8 * 1000;
/** Provider app tokens last days or longer; an hour bounds a revoked one. */
const TOKEN_TTL_MS = 60 * 60 * 1000;
const PLATFORMS = /** @type {const} */ (["twitch", "kick"]);

/** @typedef {import('./liveStreamProviders').LiveStream} LiveStream */
/** @typedef {import('./liveStreamProviders').ProviderCredentials} ProviderCredentials */
/** @typedef {Record<string, string>} ProviderSettings */
/** @typedef {"ok" | "stale" | "error" | "off"} PlatformStatus */
/**
 * @typedef {{
 *   streams: LiveStream[],
 *   platforms: Record<"twitch" | "kick", PlatformStatus>,
 *   fetchedAt: string,
 * }} LiveStreamsSnapshot
 */
/**
 * The provider blocks of the platform integrations config (null or missing
 * when the operator has not set that provider up).
 *
 * @typedef {{
 *   twitch?: ProviderSettings | null,
 *   kick?: ProviderSettings | null,
 * }} LiveStreamsConfig
 */
/** @typedef {{ streams: LiveStream[], at: number }} PlatformResult */

/** @param {ProviderSettings | null | undefined} provider @returns {ProviderCredentials | null} */
function credentialsOf(provider) {
  const { clientId, clientSecret, redirectUri } = provider || {};
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri: redirectUri || "" } : null;
}

class LiveStreamsService {
  /**
   * @param {{
   *   config?: LiveStreamsConfig | null,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   platformDeadlineMs?: number,
   *   log?: { warn?: (fields: object, message: string) => void },
   * }} [options]
   */
  constructor({ config, fetchImpl = fetch, now = Date.now, platformDeadlineMs = PLATFORM_DEADLINE_MS, log } = {}) {
    this.config = config || {};
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.platformDeadlineMs = platformDeadlineMs;
    this.log = log;
    /** @type {LiveStreamsSnapshot | null} */
    this.snapshot = null;
    this.snapshotAt = 0;
    /** @type {Promise<LiveStreamsSnapshot> | null} */
    this.pending = null;
    /** @type {Partial<Record<"twitch" | "kick", PlatformResult>>} */
    this.lastGood = {};
    /** @type {Partial<Record<"twitch" | "kick", { token: string, at: number }>>} */
    this.tokens = {};
    /** @type {number | null} */
    this.kickCategoryId = null;
  }

  /**
   * A fresh list is returned as is. An expired list that is still inside the
   * stale window is returned at once and refreshed behind the caller, so a
   * slow provider never turns a usable list into a wait.
   *
   * @returns {Promise<LiveStreamsSnapshot>}
   */
  list() {
    const age = this.snapshot ? this.now() - this.snapshotAt : Infinity;
    if (this.snapshot && age < CACHE_TTL_MS) return Promise.resolve(this.snapshot);
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    if (this.snapshot && age < STALE_LIMIT_MS) {
      this.pending.catch(() => {});
      return Promise.resolve(this.snapshot);
    }
    return this.pending;
  }

  /** @returns {Promise<LiveStreamsSnapshot>} */
  async refresh() {
    const settled = await Promise.all(PLATFORMS.map(platform => this.refreshPlatform(platform)));
    /** @type {LiveStream[]} */
    const streams = [];
    /** @type {Record<"twitch" | "kick", PlatformStatus>} */
    const platforms = { twitch: "off", kick: "off" };
    PLATFORMS.forEach((platform, index) => {
      platforms[platform] = settled[index].status;
      streams.push(...settled[index].streams);
    });
    streams.sort((a, b) => b.viewers - a.viewers || a.id.localeCompare(b.id));
    const at = this.now();
    this.snapshot = { streams, platforms, fetchedAt: new Date(at).toISOString() };
    this.snapshotAt = at;
    return this.snapshot;
  }

  /**
   * @param {"twitch" | "kick"} platform
   * @returns {Promise<{ status: PlatformStatus, streams: LiveStream[] }>}
   */
  async refreshPlatform(platform) {
    const credentials = credentialsOf(this.config[platform]);
    if (!credentials) return { status: "off", streams: [] };
    try {
      const streams = await this.withDeadline(this.fetchWithTokenRetry(platform, credentials));
      this.lastGood[platform] = { streams, at: this.now() };
      return { status: "ok", streams };
    } catch (err) {
      this.log?.warn?.({ platform, err: err instanceof Error ? err.message : String(err) }, "live streams fetch failed");
      const previous = this.lastGood[platform];
      if (previous && this.now() - previous.at < STALE_LIMIT_MS) {
        return { status: "stale", streams: previous.streams };
      }
      return { status: "error", streams: [] };
    }
  }

  /**
   * @template T
   * @param {Promise<T>} work
   * @returns {Promise<T>}
   */
  withDeadline(work) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("platform deadline exceeded")), this.platformDeadlineMs);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * A rejected token (revoked or rotated) is dropped and the call repeated
   * once with a fresh one.
   *
   * @param {"twitch" | "kick"} platform @param {ProviderCredentials} credentials
   */
  async fetchWithTokenRetry(platform, credentials) {
    try {
      return await this.fetchPlatform(platform, credentials);
    } catch (err) {
      if (!(err instanceof PlatformOauthError) || err.status !== 401) throw err;
      delete this.tokens[platform];
      return this.fetchPlatform(platform, credentials);
    }
  }

  /** @param {"twitch" | "kick"} platform @param {ProviderCredentials} credentials */
  async fetchPlatform(platform, credentials) {
    const token = await this.appToken(platform, credentials);
    const fetchImpl = this.fetchImpl;
    if (platform === "twitch") return fetchTwitchStreams({ credentials, token, fetchImpl });
    if (this.kickCategoryId === null) {
      this.kickCategoryId = await findKickCategoryId({ token, fetchImpl });
    }
    return fetchKickStreams({ categoryId: this.kickCategoryId, token, fetchImpl });
  }

  /** @param {"twitch" | "kick"} platform @param {ProviderCredentials} credentials */
  async appToken(platform, credentials) {
    const cached = this.tokens[platform];
    if (cached && this.now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const token = platform === "twitch"
      ? await getTwitchAppToken(credentials, this.fetchImpl)
      : await getKickAppToken(credentials, this.fetchImpl);
    this.tokens[platform] = { token, at: this.now() };
    return token;
  }
}

module.exports = { LiveStreamsService, credentialsOf, CACHE_TTL_MS, STALE_LIMIT_MS };
