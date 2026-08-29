"use strict";

/**
 * Timestamped Twitch / YouTube archives for replay games.
 *
 * The signed-in user's channels come only from their private multichat
 * preferences. Opponent channels, when requested, come only from SC2Pulse's
 * public pro-player links. The service never attempts to read another
 * SC2Tools user's preferences.
 *
 * Provider results are cached per channel and identical in-flight lookups are
 * shared. Every upstream failure degrades to an empty (or stale) archive list,
 * because VOD enrichment must not make replay history unavailable.
 */

const { TWITCH_WEB_CLIENT_ID } = require("./multichatViewers");
const { normalizeYoutubeInput } = require("./youtubeLiveChat");

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_ARCHIVES_QUERY =
  "query($login:String!){user(login:$login){videos(types:[ARCHIVE],sort:TIME,first:30){edges{node{id publishedAt lengthSeconds}}}}}";
const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_GAMES = 2_000;
const MAX_OPPONENT_IDENTITIES = 12;
const MAX_OPPONENT_YOUTUBE_CHANNELS = 4;
const MAX_YOUTUBE_VIDEOS = 30;
const YOUTUBE_CHANNEL_BUDGET_MS = 20_000;
const PROVIDER_FETCH_CONCURRENCY = 4;
const YOUTUBE_FETCH_CONCURRENCY = 4;
const PULSE_FETCH_CONCURRENCY = 5;
const MAX_HTML_CHARS = 8_000_000;
const MAX_GAME_DURATION_SEC = 24 * 60 * 60;
const MAX_VIDEO_DURATION_SEC = 7 * 24 * 60 * 60;
const YOUTUBE_SIMULCAST_TOLERANCE_MS = 5 * 60 * 1000;

const PAGE_HEADERS = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en",
});

/** @typedef {'twitch'|'youtube'} VodPlatform */
/** @typedef {'me'|'opponent'} VodPerspective */

/**
 * @typedef {{
 *   platform: VodPlatform,
 *   videoId: string,
 *   startMs: number,
 *   endMs: number,
 *   orientation?: 'horizontal'|'portrait'|'unknown',
 *   ongoing?: boolean,
 * }} ProviderVod
 */

/**
 * @typedef {{
 *   platform: VodPlatform,
 *   input: string,
 *   cacheKey: string,
 *   oauthUserId?: string,
 *   oauthRevision?: string,
 * }} ProviderChannel
 */

/**
 * @typedef {{
 *   platform: VodPlatform,
 *   videoId: string,
 *   url: string,
 *   offsetSec: number,
 *   perspective: VodPerspective,
 *   playerName: string,
 * }} GameVodLink
 */

class GameVodsService {
  /**
   * @param {{
   *   users: {getPreferences: (userId: string, type: string) => Promise<Record<string, any>>},
   *   pulseIntel?: {getIntel: (pulseCharacterId: string|number) => Promise<object|null>} | null,
   *   platformIntegrations?: {
   *     getYoutubeConnectionRevision?: (userId:string) => Promise<string>,
   *     resolveYoutubeGameVods: (
   *       userId:string,
   *       opts?:{
   *         expectedHandle?:string,
   *         expectedChannelId?:string,
   *         expectedRevision?:string,
   *       },
   *     ) => Promise<Record<string,any>|null>,
   *   } | null,
   *   fetchImpl?: typeof fetch,
   *   log?: {warn?: Function,info?: Function} | null,
   *   cacheTtlMs?: number,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.users || typeof opts.users.getPreferences !== "function") {
      throw new Error("GameVodsService requires users.getPreferences");
    }
    this.users = opts.users;
    this.pulseIntel = opts.pulseIntel || null;
    this.platformIntegrations = opts.platformIntegrations || null;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.log = opts.log || null;
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" && opts.cacheTtlMs >= 0
        ? opts.cacheTtlMs
        : CACHE_TTL_MS;
    this.now = opts.now || (() => Date.now());
    /** @type {Map<string, {fetchedAt: number, vods: ProviderVod[]}>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<ProviderVod[]>>} */
    this._inflight = new Map();
  }

  /**
   * Resolve the current user's enabled channel archives for a bounded game
   * batch. Public opponent channels are included only when explicitly asked.
   *
   * @param {string} userId
   * @param {Array<Record<string, any>>} games
   * @param {{includeOpponent?: boolean}} [opts]
   * @returns {Promise<{
   *   configuredPlatforms: VodPlatform[],
   *   linksByGameId: Record<string, GameVodLink[]>,
   * }>}
   */
  async resolveForGames(userId, games, opts = {}) {
    const normalizedGames = normalizeGames(games);
    /** @type {Record<string, GameVodLink[]>} */
    const linksByGameId = Object.create(null);
    for (const game of normalizedGames) linksByGameId[game.gameId] = [];

    const prefs = await this.users.getPreferences(userId, "multichat");
    let oauthRevision = "";
    if (
      prefs?.youtube?.channel
      && typeof this.platformIntegrations?.getYoutubeConnectionRevision
        === "function"
    ) {
      try {
        oauthRevision = String(
          await this.platformIntegrations.getYoutubeConnectionRevision(userId),
        );
      } catch {
        oauthRevision = "";
      }
    }
    const ownChannels = configuredOwnChannels(prefs).map((channel) =>
      channel.platform === "youtube"
        ? { ...channel, oauthUserId: userId, oauthRevision }
        : channel);
    const sourcesByGame = new Map(
      normalizedGames.map((game) => [game.gameId, ownSources(ownChannels)]),
    );

    if (opts.includeOpponent === true && this.pulseIntel) {
      await this._addOpponentSources(normalizedGames, sourcesByGame);
    }

    /** @type {Map<string, ProviderChannel>} */
    const uniqueChannels = new Map();
    for (const sources of sourcesByGame.values()) {
      for (const source of sources) {
        uniqueChannels.set(providerKey(source.channel), source.channel);
      }
    }

    const configuredSet = new Set();
    for (const channel of uniqueChannels.values()) {
      configuredSet.add(channel.platform);
    }
    const configuredPlatforms = /** @type {VodPlatform[]} */ (
      ["twitch", "youtube"].filter((platform) => configuredSet.has(platform))
    );
    if (normalizedGames.length === 0 || uniqueChannels.size === 0) {
      return { configuredPlatforms, linksByGameId };
    }

    /** @type {Map<string, ProviderVod[]>} */
    const archivesByChannel = new Map();
    await mapWithConcurrency(
      Array.from(uniqueChannels.values()),
      PROVIDER_FETCH_CONCURRENCY,
      async (channel) => {
        archivesByChannel.set(
          providerKey(channel),
          await this._archivesForChannel(channel),
        );
      },
    );

    for (const game of normalizedGames) {
      if (game.startMs === null) continue;
      const seen = new Set();
      const seenYoutubePerspectives = new Set();
      for (const source of sourcesByGame.get(game.gameId) || []) {
        const vod = findContainingVod(
          archivesByChannel.get(providerKey(source.channel)) || [],
          game.startMs,
        );
        if (!vod) continue;
        const offsetSec = Math.max(
          0,
          Math.floor((game.startMs - vod.startMs) / 1000),
        );
        const url = buildTimestampUrl(vod.platform, vod.videoId, offsetSec);
        if (!url) continue;
        if (
          vod.platform === "youtube"
          && seenYoutubePerspectives.has(source.perspective)
        ) {
          continue;
        }
        const dedupeKey =
          `${source.perspective}:${vod.platform}:${vod.videoId}:${offsetSec}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        if (vod.platform === "youtube") {
          seenYoutubePerspectives.add(source.perspective);
        }
        linksByGameId[game.gameId].push({
          platform: vod.platform,
          videoId: vod.videoId,
          url,
          offsetSec,
          perspective: source.perspective,
          playerName: source.playerName,
        });
      }
    }

    return { configuredPlatforms, linksByGameId };
  }

  /**
   * @param {Array<{gameId: string, raw: Record<string, any>, startMs: number|null}>} games
   * @param {Map<string, Array<{channel: ProviderChannel, perspective: VodPerspective, playerName: string}>>} sourcesByGame
   */
  async _addOpponentSources(games, sourcesByGame) {
    /** @type {Map<string, Array<{gameId: string, game: Record<string, any>}>>} */
    const byCharacter = new Map();
    for (const game of games) {
      if (game.startMs === null) continue;
      const characterId = cleanPulseCharacterId(
        game.raw?.opponent?.pulseCharacterId,
      );
      if (!characterId) continue;
      if (!byCharacter.has(characterId)) {
        if (byCharacter.size >= MAX_OPPONENT_IDENTITIES) continue;
        byCharacter.set(characterId, []);
      }
      byCharacter.get(characterId)?.push({ gameId: game.gameId, game: game.raw });
    }

    /** @type {Map<string, Record<string, any>|null>} */
    const intelByCharacter = new Map();
    await mapWithConcurrency(
      Array.from(byCharacter.keys()),
      PULSE_FETCH_CONCURRENCY,
      async (characterId) => {
        try {
          const intel = await this.pulseIntel?.getIntel(characterId);
          intelByCharacter.set(
            characterId,
            intel && typeof intel === "object"
              ? /** @type {Record<string, any>} */ (intel)
              : null,
          );
        } catch (err) {
          this._warn(err, "pulse", { pulseCharacterId: characterId });
          intelByCharacter.set(characterId, null);
        }
      },
    );

    const opponentYoutubeChannels = new Set();
    for (const [characterId, rows] of byCharacter.entries()) {
      const intel = intelByCharacter.get(characterId);
      const links = publicProLinks(intel?.pro?.links);
      if (links.length === 0) continue;
      for (const row of rows) {
        const playerName = cleanPlayerName(row.game?.opponent?.displayName)
          || cleanPlayerName(intel?.pro?.nickname)
          || "Opponent";
        const sources = sourcesByGame.get(row.gameId);
        if (!sources) continue;
        for (const channel of links) {
          if (channel.platform === "youtube") {
            const key = providerKey(channel);
            if (
              !opponentYoutubeChannels.has(key)
              && opponentYoutubeChannels.size >= MAX_OPPONENT_YOUTUBE_CHANNELS
            ) {
              continue;
            }
            opponentYoutubeChannels.add(key);
          }
          addSource(sources, {
            channel,
            perspective: "opponent",
            playerName,
          });
        }
      }
    }
  }

  /** @param {ProviderChannel} channel @returns {Promise<ProviderVod[]>} */
  _archivesForChannel(channel) {
    const key = providerKey(channel);
    const cached = this._cache.get(key);
    if (cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
      this._touchCache(key, cached);
      return Promise.resolve(cached.vods);
    }
    const pending = this._inflight.get(key);
    if (pending) return pending;

    const job = this._fetchArchives(channel)
      .then((vods) => {
        this._touchCache(key, { fetchedAt: this.now(), vods });
        return vods;
      })
      .catch((err) => {
        this._warn(err, channel.platform, { channel: channel.cacheKey });
        const vods = cached ? cached.vods : [];
        // Cache fail-soft answers too, preventing a broken provider from being
        // hammered by every open game table during the outage.
        this._touchCache(key, { fetchedAt: this.now(), vods });
        return vods;
      })
      .finally(() => this._inflight.delete(key));
    this._inflight.set(key, job);
    return job;
  }

  /** @param {ProviderChannel} channel @returns {Promise<ProviderVod[]>} */
  async _fetchArchives(channel) {
    if (typeof this.fetchImpl !== "function") throw new Error("fetch unavailable");
    return channel.platform === "twitch"
      ? this._fetchTwitchArchives(channel.input)
      : this._fetchYoutubeArchives(
        channel.input,
        channel.oauthUserId,
        channel.oauthRevision,
      );
  }

  /** @param {string} login @returns {Promise<ProviderVod[]>} */
  async _fetchTwitchArchives(login) {
    const response = await this.fetchImpl(TWITCH_GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: TWITCH_ARCHIVES_QUERY,
        variables: { login },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`twitch gql ${response.status}`);
    const payload = /** @type {Record<string, any>} */ (await response.json());
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error("twitch gql response errors");
    }
    return parseTwitchArchives(payload);
  }

  /**
   * Prefer the official uploads index only for the signed-in user's own saved
   * channel. Any missing/failed OAuth path falls through to the existing
   * public channel-page scraper, preserving fail-soft behavior.
   *
   * @param {string} rawInput
   * @param {string|undefined} oauthUserId
   * @param {string|undefined} oauthRevision
   * @returns {Promise<ProviderVod[]>}
   */
  async _fetchYoutubeArchives(rawInput, oauthUserId, oauthRevision) {
    // OAuth discovery and public scraping share one end-to-end budget so a
    // slow official-provider failure cannot double the route latency.
    const deadlineMs = Date.now() + YOUTUBE_CHANNEL_BUDGET_MS;
    if (
      oauthUserId
      && typeof this.platformIntegrations?.resolveYoutubeGameVods === "function"
    ) {
      const official = await this._fetchOfficialYoutubeArchives(
        oauthUserId,
        rawInput,
        oauthRevision,
      );
      if (official !== null) return official;
    }

    const normalized = normalizeYoutubeArchiveInput(rawInput);
    const ownerChannelIds = new Set();
    /** @type {string[]} */
    let videoIds = normalized.videoId ? [normalized.videoId] : [];
    if (!normalized.videoId) {
      for (const streamsUrl of normalized.streamsUrls) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) break;
        const response = await this.fetchImpl(streamsUrl, {
          headers: PAGE_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
        });
        if (!response.ok) {
          throw new Error(`youtube streams ${response.status}`);
        }
        const html = await readTextBounded(response, MAX_HTML_CHARS);
        const ownerChannelId = extractYoutubeChannelId(html);
        if (ownerChannelId) ownerChannelIds.add(ownerChannelId);
        videoIds.push(...extractYoutubeVideoIds(html, MAX_YOUTUBE_VIDEOS));
        videoIds = Array.from(new Set(videoIds)).slice(0, MAX_YOUTUBE_VIDEOS);
        if (videoIds.length >= MAX_YOUTUBE_VIDEOS) break;
      }
      // Channel pages can contain recommendation ids as well as uploads. If
      // YouTube changes the page shape and we cannot identify the channel
      // owner, do not guess a player's POV from those broad candidates.
      if (ownerChannelIds.size === 0) return [];
    }

    /** @type {Array<ProviderVod|null>} */
    const parsed = await mapWithConcurrency(
      videoIds,
      YOUTUBE_FETCH_CONCURRENCY,
      async (videoId) => {
        try {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) return null;
          const response = await this.fetchImpl(YOUTUBE_WATCH_URL + videoId, {
            headers: PAGE_HEADERS,
            redirect: "follow",
            signal: AbortSignal.timeout(
              Math.min(FETCH_TIMEOUT_MS, remainingMs),
            ),
          });
          if (!response.ok) throw new Error(`youtube watch ${response.status}`);
          const html = await readTextBounded(response, MAX_HTML_CHARS);
          if (!normalized.videoId) {
            const videoOwner = extractYoutubeVideoOwnerChannelId(html);
            if (!videoOwner || !ownerChannelIds.has(videoOwner)) return null;
          }
          const timing = parseYoutubeBroadcastDetails(html);
          if (!timing) return null;
          return {
            platform: "youtube",
            videoId,
            startMs: timing.startMs,
            endMs: timing.endMs,
          };
        } catch (err) {
          this._warn(err, "youtube", { videoId });
          return null;
        }
      },
    );
    return /** @type {ProviderVod[]} */ (parsed.filter(Boolean));
  }

  /**
   * @param {string} userId
   * @param {string} configuredInput
   * @param {string|undefined} oauthRevision
   * @returns {Promise<ProviderVod[]|null>}
   */
  async _fetchOfficialYoutubeArchives(
    userId,
    configuredInput,
    oauthRevision,
  ) {
    const configured = configuredYoutubeIdentity(configuredInput);
    if (!configured) {
      this._youtubeDiagnostic("oauth_identity_unverifiable");
      return null;
    }
    let result;
    try {
      const expectedIdentity = configured?.type === "handle"
        ? { expectedHandle: configured.value }
        : configured?.type === "channel"
          ? { expectedChannelId: configured.value }
          : {};
      result = await this.platformIntegrations?.resolveYoutubeGameVods(userId, {
        ...expectedIdentity,
        expectedRevision: oauthRevision || "",
      });
    } catch (err) {
      this._warnOfficialYoutube(err);
      this._youtubeDiagnostic("oauth_request_failed");
      return null;
    }
    if (!result || typeof result !== "object") {
      this._youtubeDiagnostic("oauth_unavailable");
      return null;
    }
    const identity = matchConfiguredYoutubeIdentity(configuredInput, result);
    if (!identity.matches) {
      this._youtubeDiagnostic(identity.reason);
      return null;
    }
    const vods = normalizeOfficialYoutubeVods(result.vods);
    const counts = {
      archiveCount: vods.length,
      uploadsScanned: boundedDiagnosticCount(result.uploadsScanned),
      pagesFetched: boundedDiagnosticCount(result.pagesFetched),
      videoBatches: boundedDiagnosticCount(result.videoBatches),
    };
    // A valid channel may still have no livestreams in the bounded uploads
    // window. Let the existing public channel scan have one chance to find an
    // active or unusually old stream before caching an empty answer.
    if (vods.length === 0) {
      this._youtubeDiagnostic("oauth_no_livestreams", counts);
      return null;
    }
    this._youtubeDiagnostic(null, counts);
    return vods;
  }

  /** @param {string} key @param {{fetchedAt: number, vods: ProviderVod[]}} entry */
  _touchCache(key, entry) {
    this._cache.delete(key);
    this._cache.set(key, entry);
    while (this._cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this._cache.keys().next().value;
      if (oldest === undefined) break;
      this._cache.delete(oldest);
    }
  }

  /**
   * @param {unknown} err
   * @param {string} provider
   * @param {Record<string, unknown>} [fields]
   */
  _warn(err, provider, fields = {}) {
    this.log?.warn?.(
      { err: String(err), provider, ...fields },
      "game_vod_lookup_failed",
    );
  }

  /**
   * @param {string|null} fallbackReason
   * @param {Record<string,number>} [counts]
   */
  _youtubeDiagnostic(fallbackReason, counts = {}) {
    this.log?.info?.(
      {
        provider: "youtube",
        source: fallbackReason ? "public_scrape" : "official",
        ...(fallbackReason ? { fallbackReason } : {}),
        ...counts,
      },
      "game_vod_youtube_source_selected",
    );
  }

  /**
   * Official provider errors are logged without messages or credentials.
   * @param {unknown} err
   */
  _warnOfficialYoutube(err) {
    const rawCode = String(/** @type {any} */ (err)?.code || "");
    const code = /^[a-z0-9_]{1,80}$/i.test(rawCode)
      ? rawCode
      : "youtube_official_failed";
    const rawStatus = Number(/** @type {any} */ (err)?.status);
    this.log?.warn?.(
      {
        provider: "youtube",
        source: "official",
        code,
        ...(Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
          ? { status: rawStatus }
          : {}),
      },
      "game_vod_lookup_failed",
    );
  }

}

/**
 * @param {unknown} rawGames
 * @returns {Array<{gameId: string, raw: Record<string, any>, startMs: number|null}>}
 */
function normalizeGames(rawGames) {
  if (!Array.isArray(rawGames)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of rawGames) {
    if (!raw || typeof raw !== "object") continue;
    const game = /** @type {Record<string, any>} */ (raw);
    const gameId = cleanGameId(game.gameId);
    if (!gameId || seen.has(gameId)) continue;
    seen.add(gameId);
    result.push({ gameId, raw: game, startMs: gameStartMs(game) });
    if (result.length >= MAX_GAMES) break;
  }
  return result;
}

/**
 * Prefer the exact replay start; old rows fall back to end minus duration.
 *
 * @param {Record<string, any>} game
 * @returns {number|null}
 */
function gameStartMs(game) {
  const exact = parseDateMs(game?.startedAt);
  if (exact !== null) return exact;
  const endMs = parseDateMs(game?.date);
  const durationSec = finiteDuration(game?.durationSec, MAX_GAME_DURATION_SEC);
  if (endMs === null || durationSec === null) return null;
  return endMs - durationSec * 1000;
}

/** @param {unknown} raw @returns {string|null} */
function normalizeTwitchLogin(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || input.length > 300) return null;
  if (/^https?:\/\//i.test(input) || /^(?:www\.)?twitch\.tv\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.protocol !== "https:" || host !== "twitch.tv") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    return validTwitchLogin(parts[0]);
  }
  return validTwitchLogin(input.replace(/^#/, ""));
}

/** @param {string} raw @returns {string|null} */
function validTwitchLogin(raw) {
  const login = raw.toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(login)) return null;
  if (
    new Set([
      "videos",
      "directory",
      "downloads",
      "settings",
      "subscriptions",
      "inventory",
      "wallet",
      "search",
    ]).has(login)
  ) {
    return null;
  }
  return login;
}

/**
 * Reuse the live-chat input parser, then turn its channel `/live` candidate
 * into `/streams`. Repeated trailing `/live` is stripped because an already
 * complete `/live` URL is normalized by the existing helper to `/live/live`.
 *
 * @param {unknown} raw
 * @returns {{videoId: string|null, streamsUrls: string[], cacheKey: string}}
 */
function normalizeYoutubeArchiveInput(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || input.length > 500) throw new Error("invalid youtube channel");
  const normalized = normalizeYoutubeInput(input);
  if (normalized.videoId) {
    if (!isYoutubeVideoId(normalized.videoId)) {
      throw new Error("invalid youtube video id");
    }
    return {
      videoId: normalized.videoId,
      streamsUrls: [],
      cacheKey: `video:${normalized.videoId}`,
    };
  }

  const streamsUrls = [];
  for (const pageUrl of normalized.pageUrls.slice(0, 3)) {
    const parsed = new URL(pageUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.protocol !== "https:" || host !== "youtube.com") continue;
    let path = parsed.pathname.replace(/\/+$/, "");
    while (
      /\/(?:live|streams|videos|featured|about|community|shorts)$/i.test(path)
    ) {
      path = path
        .replace(
          /\/(?:live|streams|videos|featured|about|community|shorts)$/i,
          "",
        )
        .replace(/\/+$/, "");
    }
    if (!isYoutubeChannelPath(path)) continue;
    streamsUrls.push(`https://www.youtube.com${path}/streams`);
  }
  const unique = Array.from(new Set(streamsUrls));
  if (unique.length === 0) throw new Error("invalid youtube channel");
  return {
    videoId: null,
    streamsUrls: unique,
    cacheKey: `channel:${unique.join("|")}`,
  };
}

/**
 * Bind an authenticated channel to the user's saved multichat channel before
 * using private OAuth-derived results. Modern `@handle` and canonical
 * `/channel/UC...` inputs are exact and safe to compare. Legacy `/c`, `/user`,
 * root-name, and direct-video inputs are intentionally left to public scraping
 * because the Data API response cannot prove they identify the same channel.
 *
 * @param {unknown} rawInput
 * @param {Record<string,any>} official
 * @returns {{matches:boolean,reason:string}}
 */
function matchConfiguredYoutubeIdentity(rawInput, official) {
  const configured = configuredYoutubeIdentity(rawInput);
  if (!configured) {
    return { matches: false, reason: "oauth_identity_unverifiable" };
  }
  if (configured.type === "channel") {
    const channelId = String(official?.channelId || "");
    return channelId === configured.value
      ? { matches: true, reason: "" }
      : { matches: false, reason: "oauth_channel_mismatch" };
  }
  const officialHandle = youtubeCustomHandle(official?.customUrl);
  if (official?.handleLookupAttempted === true) {
    const channelId = String(official?.channelId || "");
    const handleChannelId = String(official?.handleChannelId || "");
    return channelId && handleChannelId && channelId === handleChannelId
      ? { matches: true, reason: "" }
      : { matches: false, reason: "oauth_handle_mismatch" };
  }
  return officialHandle === configured.value
    ? { matches: true, reason: "" }
    : { matches: false, reason: "oauth_handle_mismatch" };
}

/**
 * @param {unknown} raw
 * @returns {{type:'channel'|'handle',value:string}|null}
 */
function configuredYoutubeIdentity(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return null;
  if (/^@[A-Za-z0-9._-]{2,60}$/.test(input)) {
    return { type: "handle", value: input.toLowerCase() };
  }
  if (
    /^[A-Za-z0-9._-]{2,60}$/.test(input)
    && !/^[A-Za-z0-9_-]{11}$/.test(input)
  ) {
    return { type: "handle", value: `@${input.toLowerCase()}` };
  }
  if (!/^https?:\/\//i.test(input)) return null;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
  if (parsed.protocol !== "https:" || host !== "youtube.com") return null;
  let path = parsed.pathname.replace(/\/+$/, "");
  while (/\/(?:live|streams|videos)$/i.test(path)) {
    path = path.replace(/\/(?:live|streams|videos)$/i, "").replace(/\/+$/, "");
  }
  const channel = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
  if (channel) return { type: "channel", value: channel[1] };
  const handle = /^\/(\@[A-Za-z0-9._-]{2,60})$/.exec(path);
  return handle
    ? { type: "handle", value: handle[1].toLowerCase() }
    : null;
}

/** @param {unknown} raw @returns {string|null} */
function youtubeCustomHandle(raw) {
  let input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return null;
  if (/^(?:www\.|m\.)?youtube\.com\//i.test(input)) {
    input = `https://${input}`;
  }
  if (/^https?:\/\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
    if (parsed.protocol !== "https:" || host !== "youtube.com") return null;
    input = parsed.pathname.replace(/^\/+|\/+$/g, "");
  }
  return /^@[A-Za-z0-9._-]{2,60}$/.test(input)
    ? input.toLowerCase()
    : null;
}

/** @param {unknown} rawVods @returns {ProviderVod[]} */
function normalizeOfficialYoutubeVods(rawVods) {
  if (!Array.isArray(rawVods)) return [];
  /** @type {ProviderVod[]} */
  const vods = [];
  const seen = new Set();
  for (const row of rawVods.slice(0, MAX_YOUTUBE_VIDEOS * 10)) {
    const videoId = String(row?.videoId || "");
    const startMs = Number(row?.startMs);
    const endMs = Number(row?.endMs);
    if (
      !isYoutubeVideoId(videoId)
      || seen.has(videoId)
      || !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || endMs <= startMs
    ) {
      continue;
    }
    seen.add(videoId);
    const orientation = row?.orientation === "horizontal"
      || row?.orientation === "portrait"
      ? row.orientation
      : "unknown";
    vods.push({
      platform: "youtube",
      videoId,
      startMs,
      endMs,
      orientation,
      ongoing: row?.ongoing === true,
    });
  }
  return vods;
}

/** @param {unknown} value */
function boundedDiagnosticCount(value) {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) ? Math.max(0, Math.min(10_000, count)) : 0;
}

/** @param {string} path @returns {boolean} */
function isYoutubeChannelPath(path) {
  if (!path || path.length > 220 || /[\s\\]/.test(path)) return false;
  return (
    /^\/@[A-Za-z0-9._-]{2,60}$/.test(path)
    || /^\/channel\/[A-Za-z0-9_-]{10,80}$/.test(path)
    || /^\/(?:c|user)\/[A-Za-z0-9._%-]{2,100}$/.test(path)
    || /^\/[A-Za-z0-9._%-]{2,100}$/.test(path)
  );
}

/**
 * Extract channel-owned recent video ids in document order. YouTube repeats
 * ids throughout its renderer tree; deduplication keeps the watch-page work
 * bounded to at most `limit` requests.
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {string[]}
 */
function extractYoutubeVideoIds(html, limit = MAX_YOUTUBE_VIDEOS) {
  const cap = Math.max(0, Math.min(MAX_YOUTUBE_VIDEOS, Math.floor(limit)));
  if (cap === 0 || typeof html !== "string") return [];
  const ids = [];
  const seen = new Set();
  // YouTube repeats ids across several renderer shapes and changes those
  // wrappers frequently. Discovery stays broad and bounded here; the watch
  // page's main-video channelId is checked against the channel page before a
  // VOD is associated with this POV, which filters recommendations safely.
  const pattern =
    /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"|(?:\\?\/watch\?v=|\\?\/live\/)([A-Za-z0-9_-]{11})/g;
  for (const match of html.matchAll(pattern)) {
    const id = match[1] || match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= cap) break;
  }
  return ids;
}

/** @param {string} html @returns {string|null} */
function extractYoutubeChannelId(html) {
  if (typeof html !== "string") return null;
  return /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1]
    || null;
}

/** @param {string} html @returns {string|null} */
function extractYoutubeVideoOwnerChannelId(html) {
  if (typeof html !== "string") return null;
  const details = /"videoDetails"\s*:\s*\{.{0,8000}?"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/s
    .exec(html);
  return details?.[1] || null;
}

/**
 * Read a provider page without first materialising an unbounded response.
 * Native fetch responses take the streamed branch; tiny unit-test response
 * stubs fall back to `.text()` and are still byte-checked.
 *
 * @param {any} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readTextBounded(response, maxBytes) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("provider page too large");
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = String(await response.text());
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("provider page too large");
    }
    return text;
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      bytes += value?.byteLength || 0;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("provider page too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Parse true livestream timing from a YouTube watch page. `uploadDate` is
 * deliberately ignored: an ordinary upload must never be mistaken for a
 * stream archive. When `endTimestamp` is absent, the main video's duration is
 * the only accepted fallback.
 *
 * @param {string} html
 * @returns {{startMs: number, endMs: number}|null}
 */
function parseYoutubeBroadcastDetails(html) {
  if (typeof html !== "string" || !html) return null;
  const markers = html.matchAll(
    /\\?"liveBroadcastDetails\\?"\s*:\s*\{/g,
  );
  for (const marker of markers) {
    const segment = html.slice(marker.index, marker.index + 2_000);
    const startRaw = extractPossiblyEscapedString(segment, "startTimestamp");
    const startMs = parseDateMs(startRaw);
    if (startMs === null) continue;

    const endRaw = extractPossiblyEscapedString(segment, "endTimestamp");
    let endMs = parseDateMs(endRaw);
    if (endMs === null || endMs <= startMs) {
      const durationSec = youtubeDurationSec(html);
      if (durationSec === null) continue;
      endMs = startMs + durationSec * 1000;
    }
    if (endMs <= startMs) continue;
    return { startMs, endMs };
  }
  return null;
}

/** @param {string} source @param {string} field @returns {string|null} */
function extractPossiblyEscapedString(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\\\?"${escaped}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]{1,100})\\\\?"`,
  );
  return pattern.exec(source)?.[1] || null;
}

/** @param {string} html @returns {number|null} */
function youtubeDurationSec(html) {
  const seconds = /\\?"lengthSeconds\\?"\s*:\s*(?:\\?")?(\d{1,9})/.exec(html);
  if (seconds) return finiteDuration(seconds[1], MAX_VIDEO_DURATION_SEC);
  const millis = /\\?"approxDurationMs\\?"\s*:\s*(?:\\?")?(\d{1,12})/.exec(html);
  if (millis) {
    const value = Number(millis[1]);
    return finiteDuration(Math.ceil(value / 1000), MAX_VIDEO_DURATION_SEC);
  }
  const iso = /\\?"duration\\?"\s*:\s*\\?"(P(?:\d+D)?T[^"\\]+)\\?"/.exec(html);
  return iso ? parseIsoDurationSec(iso[1]) : null;
}

/** @param {string} raw @returns {number|null} */
function parseIsoDurationSec(raw) {
  const match =
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw);
  if (!match) return null;
  const seconds =
    Number(match[1] || 0) * 86_400
    + Number(match[2] || 0) * 3_600
    + Number(match[3] || 0) * 60
    + Number(match[4] || 0);
  return finiteDuration(Math.ceil(seconds), MAX_VIDEO_DURATION_SEC);
}

/** @param {Record<string, any>} payload @returns {ProviderVod[]} */
function parseTwitchArchives(payload) {
  const edges = payload?.data?.user?.videos?.edges;
  if (!Array.isArray(edges)) return [];
  /** @type {ProviderVod[]} */
  const vods = [];
  for (const edge of edges.slice(0, 30)) {
    const node = edge?.node;
    const videoId = typeof node?.id === "string" ? node.id : String(node?.id ?? "");
    if (!isTwitchVideoId(videoId)) continue;
    const startMs = parseDateMs(node?.publishedAt);
    const durationSec = finiteDuration(
      node?.lengthSeconds,
      MAX_VIDEO_DURATION_SEC,
    );
    if (startMs === null || durationSec === null) continue;
    vods.push({
      platform: "twitch",
      videoId,
      startMs,
      endMs: startMs + durationSec * 1000,
    });
  }
  return vods;
}

/**
 * @param {ProviderVod[]} vods
 * @param {number} atMs
 * @returns {ProviderVod|null}
 */
function findContainingVod(vods, atMs) {
  if (!Number.isFinite(atMs)) return null;
  let best = null;
  for (const vod of Array.isArray(vods) ? vods : []) {
    if (
      !Number.isFinite(vod?.startMs)
      || !Number.isFinite(vod?.endMs)
      || atMs < vod.startMs
      || atMs >= vod.endMs
    ) {
      continue;
    }
    if (!best || preferContainingVod(vod, best)) best = vod;
  }
  return best;
}

/**
 * YouTube can publish a horizontal and portrait simulcast with starts a few
 * seconds apart. Prefer horizontal only while both streams contain this game;
 * the containing filter in `findContainingVod` preserves a portrait-only
 * prefix or tail. Unknown dimensions keep the established latest-start rule.
 *
 * @param {ProviderVod} candidate
 * @param {ProviderVod} current
 */
function preferContainingVod(candidate, current) {
  const nearSimulcast = candidate.platform === "youtube"
    && current.platform === "youtube"
    && Math.abs(candidate.startMs - current.startMs)
      <= YOUTUBE_SIMULCAST_TOLERANCE_MS;
  if (nearSimulcast) {
    if (
      candidate.orientation === "horizontal"
      && current.orientation === "portrait"
    ) {
      return true;
    }
    if (
      candidate.orientation === "portrait"
      && current.orientation === "horizontal"
    ) {
      return false;
    }
  }
  return candidate.startMs > current.startMs;
}

/**
 * Construct, rather than mutate, the two allowed provider URLs. No upstream
 * URL is ever reflected into the response.
 *
 * @param {VodPlatform} platform
 * @param {string} videoId
 * @param {number} offsetSec
 * @returns {string|null}
 */
function buildTimestampUrl(platform, videoId, offsetSec) {
  if (!Number.isFinite(offsetSec) || offsetSec < 0) return null;
  const seconds = Math.min(
    MAX_VIDEO_DURATION_SEC,
    Math.floor(offsetSec),
  );
  if (platform === "twitch" && isTwitchVideoId(videoId)) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `https://www.twitch.tv/videos/${videoId}?t=${h}h${m}m${s}s`;
  }
  if (platform === "youtube" && isYoutubeVideoId(videoId)) {
    return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
  }
  return null;
}

/** @param {Record<string, any>|null|undefined} prefs @returns {ProviderChannel[]} */
function configuredOwnChannels(prefs) {
  /** @type {ProviderChannel[]} */
  const result = [];
  // `enabled` controls whether chat is connected. A saved channel remains a
  // known public VOD account even when chat is temporarily disabled.
  if (prefs?.twitch?.channel) {
    const login = normalizeTwitchLogin(prefs.twitch.channel);
    if (login) result.push({ platform: "twitch", input: login, cacheKey: login });
  }
  if (prefs?.youtube?.channel) {
    try {
      const normalized = normalizeYoutubeArchiveInput(prefs.youtube.channel);
      result.push({
        platform: "youtube",
        input: String(prefs.youtube.channel).trim(),
        cacheKey: normalized.cacheKey,
      });
    } catch {
      // A malformed saved preference is equivalent to unconfigured.
    }
  }
  return result;
}

/**
 * @param {unknown} rawLinks
 * @returns {ProviderChannel[]}
 */
function publicProLinks(rawLinks) {
  if (!rawLinks || typeof rawLinks !== "object" || Array.isArray(rawLinks)) {
    return [];
  }
  /** @type {Record<string, unknown>} */
  const byName = {};
  for (const [key, value] of Object.entries(rawLinks)) {
    byName[key.toLowerCase()] = value;
  }
  /** @type {ProviderChannel[]} */
  const result = [];
  const twitch = normalizeTwitchLogin(byName.twitch);
  if (twitch) result.push({ platform: "twitch", input: twitch, cacheKey: twitch });
  if (typeof byName.youtube === "string") {
    try {
      const normalized = normalizeYoutubeArchiveInput(byName.youtube);
      result.push({
        platform: "youtube",
        input: byName.youtube.trim(),
        cacheKey: normalized.cacheKey,
      });
    } catch {
      // Public profile links are untrusted input; silently discard junk.
    }
  }
  return result;
}

/** @param {ProviderChannel[]} channels */
function ownSources(channels) {
  return channels.map((channel) => ({
    channel,
    perspective: /** @type {VodPerspective} */ ("me"),
    playerName: "You",
  }));
}

/**
 * @param {Array<{channel: ProviderChannel, perspective: VodPerspective, playerName: string}>} sources
 * @param {{channel: ProviderChannel, perspective: VodPerspective, playerName: string}} source
 */
function addSource(sources, source) {
  const key = `${source.perspective}:${providerKey(source.channel)}`;
  if (sources.some((existing) =>
    `${existing.perspective}:${providerKey(existing.channel)}` === key)) {
    return;
  }
  sources.push(source);
}

/** @param {ProviderChannel} channel */
function providerKey(channel) {
  const owner = channel.platform === "youtube" && channel.oauthUserId
    ? `:oauth:${channel.oauthUserId}:${channel.oauthRevision || "none"}`
    : "";
  return `${channel.platform}:${channel.cacheKey}${owner}`;
}

/** @param {unknown} value @returns {string|null} */
function cleanGameId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 200 ? id : null;
}

/** @param {unknown} value @returns {string|null} */
function cleanPulseCharacterId(value) {
  const id = String(value ?? "").trim();
  return /^\d{1,32}$/.test(id) ? id : null;
}

/** @param {unknown} value @returns {string|null} */
function cleanPlayerName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return name ? name.slice(0, 80) : null;
}

/** @param {unknown} value @returns {number|null} */
function parseDateMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** @param {unknown} value @param {number} max @returns {number|null} */
function finiteDuration(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 && duration <= max
    ? duration
    : null;
}

/** @param {unknown} value @returns {boolean} */
function isTwitchVideoId(value) {
  return typeof value === "string" && /^\d{1,30}$/.test(value);
}

/** @param {unknown} value @returns {boolean} */
function isYoutubeVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/**
 * @template T,U
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<U>} worker
 * @returns {Promise<U[]>}
 */
async function mapWithConcurrency(values, concurrency, worker) {
  if (values.length === 0) return [];
  /** @type {U[]} */
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await worker(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

module.exports = {
  GameVodsService,
  TWITCH_ARCHIVES_QUERY,
  TWITCH_GQL_URL,
  gameStartMs,
  normalizeTwitchLogin,
  normalizeYoutubeArchiveInput,
  extractYoutubeVideoIds,
  extractYoutubeChannelId,
  extractYoutubeVideoOwnerChannelId,
  parseYoutubeBroadcastDetails,
  matchConfiguredYoutubeIdentity,
  normalizeOfficialYoutubeVods,
  parseTwitchArchives,
  findContainingVod,
  buildTimestampUrl,
  readTextBounded,
};
