"use strict";

/**
 * Live viewer counts for the multichat surfaces (Stream Dock).
 *
 * The dock already merges four chats into one feed; this service
 * answers the other half of "how is the stream doing right now" —
 * how many people are watching each platform, and the combined
 * audience across all of them.
 *
 * Every count is READ FROM THE PLATFORM, never modelled or inferred:
 *
 *   - Twitch — `gql.twitch.tv/gql` with the public web Client-ID
 *     (the same constant twitch.tv's own bundle ships, exactly like
 *     the public Kick Pusher key the chat engine uses). One query,
 *     `user(login){stream{viewersCount}}`; a null `stream` means
 *     offline, which is a real 0-viewer answer, not an error.
 *   - Kick — `kick.com/api/v2/channels/<slug>` →
 *     `livestream.viewer_count`. Same endpoint (and same Cloudflare
 *     exposure) as the chatroom resolver: when Cloudflare blocks the
 *     datacenter IP the count is reported UNKNOWN (null), never 0.
 *   - YouTube — the live watch page's `videoViewCountRenderer`
 *     carries `originalViewCount`, the "N watching now" concurrent
 *     figure. Scraped from the same page the chat resolver reads.
 *   - TikTok — no fetch at all: the relay already holds the webcast
 *     connection, whose `roomUser` frames ARE the viewer count. It is
 *     known while any surface is subscribed, unknown otherwise.
 *
 * Two states are deliberately distinct all the way to the UI:
 *   `viewers: 0`    — platform answered, nobody is watching / offline.
 *   `viewers: null` — we could not get a truthful number (blocked,
 *                     upstream error, no live connection). The dock
 *                     renders nothing rather than a fake zero.
 *
 * Upstream protection: results are TTL-cached per (platform, channel)
 * and identical in-flight lookups are shared, so N open docks and
 * Browser Sources cost the platforms one request per TTL window, not
 * one per surface per poll.
 */

const { normalizeKickSlug } = require("./kickChannel");
const { normalizeYoutubeInput } = require("./youtubeLiveChat");

/** How long a fetched count is served before a refetch. */
const CACHE_TTL_MS = 20_000;
/** Bound every upstream call so a hung fetch can't pin the request. */
const FETCH_TIMEOUT_MS = 10_000;

/** Twitch's public web Client-ID — shipped in twitch.tv's own bundle. */
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_VIEWERS_QUERY =
  "query($login:String!){user(login:$login){stream{viewersCount}}}";

const WATCH_URL = "https://www.youtube.com/watch?v=";

/** Browser-like headers; both hosts serve bot pages otherwise. */
const PAGE_HEADERS = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en",
});

const KICK_HEADERS = Object.freeze({
  Accept: "application/json",
  "Accept-Language": "en",
  "User-Agent": PAGE_HEADERS["User-Agent"],
});

/**
 * @typedef {{
 *   platform: "twitch"|"kick"|"youtube"|"tiktok",
 *   viewers: number | null,
 *   live: boolean,
 * }} PlatformViewers
 */

/**
 * Clamp an upstream figure to a plausible viewer count. Guards the UI
 * against a schema drift handing back a float, a negative, or a total
 * view count where a concurrent count belongs.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
function toViewerCount(raw) {
  // `Number(null)` and `Number("")` are both 0 — the exact fake zero
  // this whole module exists to avoid. Reject non-values up front.
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const n = typeof raw === "string" ? Number(raw.replace(/,/g, "")) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Pull the concurrent-viewer figure out of a YouTube watch page.
 *
 * The live watch page embeds
 * `"viewCount":{"videoViewCountRenderer":{"viewCount":{"runs":[
 *   {"text":"1,200"},{"text":" watching now"}]},"isLive":true,
 *   "originalViewCount":"1200"}}`
 * — `originalViewCount` is the unformatted concurrent count. The
 * rendered runs are the locale-formatted fallback for when YouTube
 * omits it. A renderer without `"isLive":true` is a finished stream
 * (its number is lifetime views, not viewers) and reports null.
 *
 * @param {string} html
 * @returns {number | null}
 */
function extractConcurrentViewers(html) {
  // Match the renderer OPENING (`"videoViewCountRenderer":{`), not the
  // bare name: real watch pages also list every renderer name in
  // `webResponseContextPreloadData.preloadMessageNames`, and that
  // string appears BEFORE the actual renderer in the document.
  const opens = html.matchAll(/"videoViewCountRenderer"\s*:\s*\{/g);
  for (const open of opens) {
    // Bounded slice: the renderer is small, and scanning the whole
    // ~1MB page would happily match another renderer's numbers.
    const slice = html.slice(open.index, open.index + 600);
    if (!/"isLive"\s*:\s*true/.test(slice)) continue;
    const exact = slice.match(/"originalViewCount"\s*:\s*"?(\d+)"?/);
    if (exact) return toViewerCount(exact[1]);
    // Locale-formatted fallback: `"runs":[{"text":"1,200"},
    // {"text":" watching now"}]`.
    const runs = slice.match(
      /"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([\d,.\s ]+)"/,
    );
    if (runs) {
      const n = toViewerCount(runs[1].replace(/[.\s ]/g, ""));
      if (n !== null) return n;
    }
  }
  return null;
}

class MultichatViewersService {
  /**
   * @param {{
   *   tiktokRelay?: { viewerCount?: (username: string) => number | null },
   *   fetchImpl?: typeof fetch,
   *   ttlMs?: number,
   *   now?: () => number,
   *   log?: { warn: Function } | null,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.tiktokRelay = opts.tiktokRelay || null;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || null;
    /** @type {Map<string, { atMs: number, value: PlatformViewers }>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<PlatformViewers>>} */
    this.inFlight = new Map();
  }

  /**
   * Per-platform counts + the combined total for one streamer's
   * multichat config. Platforms that are disabled or unconfigured are
   * absent from the result entirely — the dock only shows what the
   * streamer actually runs.
   *
   * `total` sums the KNOWN counts only, so a blocked Kick lookup
   * understates the total rather than poisoning it with a guess;
   * `partial` tells the UI that happened.
   *
   * @param {Record<string, any> | null | undefined} config
   * @returns {Promise<{ platforms: PlatformViewers[], total: number,
   *   partial: boolean, atMs: number }>}
   */
  async forConfig(config) {
    /** @type {Array<Promise<PlatformViewers | null>>} */
    const jobs = [];
    const cfg = config && typeof config === "object" ? config : {};

    if (cfg.twitch?.enabled && cfg.twitch.channel) {
      jobs.push(this.lookup("twitch", String(cfg.twitch.channel)));
    }
    if (cfg.kick?.enabled && cfg.kick.channel) {
      jobs.push(this.lookup("kick", String(cfg.kick.channel)));
    }
    if (cfg.youtube?.enabled && cfg.youtube.channel) {
      jobs.push(this.lookup("youtube", String(cfg.youtube.channel)));
    }
    if (cfg.tiktok?.enabled && cfg.tiktok.username) {
      jobs.push(this.lookup("tiktok", String(cfg.tiktok.username)));
    }

    const platforms = /** @type {PlatformViewers[]} */ (
      (await Promise.all(jobs)).filter(Boolean)
    );
    let total = 0;
    let partial = false;
    for (const p of platforms) {
      if (p.viewers === null) partial = true;
      else total += p.viewers;
    }
    return { platforms, total, partial, atMs: this.now() };
  }

  /**
   * One platform's count, TTL-cached and de-duplicated in flight.
   *
   * @param {"twitch"|"kick"|"youtube"|"tiktok"} platform
   * @param {string} channel
   * @returns {Promise<PlatformViewers>}
   */
  lookup(platform, channel) {
    const key = `${platform}:${channel.trim().toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.atMs < this.ttlMs) {
      return Promise.resolve(hit.value);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const job = this.fetchOne(platform, channel)
      .catch((err) => {
        // Upstream hiccups are expected (Cloudflare, rate limits, a
        // page shape change): report unknown, never a fabricated 0.
        this.log?.warn?.(
          { err: String(err), platform },
          "multichat viewer count lookup failed",
        );
        return /** @type {PlatformViewers} */ ({
          platform,
          viewers: null,
          live: false,
        });
      })
      .then((value) => {
        this.cache.set(key, { atMs: this.now(), value });
        this.inFlight.delete(key);
        return value;
      });
    this.inFlight.set(key, job);
    return job;
  }

  /**
   * @param {"twitch"|"kick"|"youtube"|"tiktok"} platform
   * @param {string} channel
   * @returns {Promise<PlatformViewers>}
   */
  async fetchOne(platform, channel) {
    if (platform === "twitch") return this.fetchTwitch(channel);
    if (platform === "kick") return this.fetchKick(channel);
    if (platform === "youtube") return this.fetchYoutube(channel);
    return this.readTikTok(channel);
  }

  /** @param {string} channel @returns {Promise<PlatformViewers>} */
  async fetchTwitch(channel) {
    const login = String(channel)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//, "")
      .replace(/^#/, "")
      .split(/[/?#]/)[0];
    if (!/^[a-z0-9_]{2,25}$/.test(login)) {
      return { platform: "twitch", viewers: null, live: false };
    }
    const res = await this.fetchImpl(TWITCH_GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: TWITCH_VIEWERS_QUERY,
        variables: { login },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`twitch gql ${res.status}`);
    const json = /** @type {Record<string, any>} */ (await res.json());
    const stream = json?.data?.user?.stream;
    // A known-offline channel is a truthful zero; an unknown login
    // (user null) is not — that stays unknown.
    if (!json?.data?.user) {
      return { platform: "twitch", viewers: null, live: false };
    }
    if (!stream) return { platform: "twitch", viewers: 0, live: false };
    const viewers = toViewerCount(stream.viewersCount);
    return { platform: "twitch", viewers, live: viewers !== null };
  }

  /** @param {string} channel @returns {Promise<PlatformViewers>} */
  async fetchKick(channel) {
    /** @type {string} */
    let slug;
    try {
      slug = normalizeKickSlug(channel);
    } catch {
      return { platform: "kick", viewers: null, live: false };
    }
    const res = await this.fetchImpl(`https://kick.com/api/v2/channels/${slug}`, {
      headers: KICK_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 403 is Cloudflare blocking the datacenter IP — the documented
    // failure mode of this endpoint, and an unknown, not a zero.
    if (!res.ok) throw new Error(`kick ${res.status}`);
    const json = /** @type {Record<string, any>} */ (await res.json());
    const live = json?.livestream;
    if (!live || live.is_live === false) {
      return { platform: "kick", viewers: 0, live: false };
    }
    const viewers = toViewerCount(live.viewer_count ?? live.viewers);
    return { platform: "kick", viewers, live: viewers !== null };
  }

  /** @param {string} channel @returns {Promise<PlatformViewers>} */
  async fetchYoutube(channel) {
    /** @type {string[]} */
    let urls;
    try {
      const { videoId, pageUrls } = normalizeYoutubeInput(channel);
      urls = videoId ? [WATCH_URL + videoId] : pageUrls;
    } catch {
      return { platform: "youtube", viewers: null, live: false };
    }
    for (const url of urls) {
      const res = await this.fetchImpl(url, {
        headers: PAGE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`youtube page ${res.status}`);
      const html = await res.text();
      const viewers = extractConcurrentViewers(html);
      if (viewers !== null) {
        return { platform: "youtube", viewers, live: true };
      }
      // The page loaded and simply carries no live stream — that is
      // a definite "nobody is watching a stream that isn't on".
      if (!/"isLive"\s*:\s*true/.test(html)) {
        return { platform: "youtube", viewers: 0, live: false };
      }
    }
    return { platform: "youtube", viewers: null, live: false };
  }

  /**
   * TikTok's count comes from the relay's own live connection —
   * known only while a surface (dock or Browser Source) is attached.
   *
   * @param {string} username
   * @returns {Promise<PlatformViewers>}
   */
  async readTikTok(username) {
    const viewers = this.tiktokRelay?.viewerCount
      ? toViewerCount(this.tiktokRelay.viewerCount(username))
      : null;
    return { platform: "tiktok", viewers, live: viewers !== null };
  }
}

module.exports = {
  MultichatViewersService,
  extractConcurrentViewers,
  toViewerCount,
  TWITCH_WEB_CLIENT_ID,
};
