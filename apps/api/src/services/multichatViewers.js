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
 * Upstream protection: results live in a bounded TTL/LRU cache per
 * (platform, channel), identical in-flight lookups are shared, and distinct
 * upstream work is capped. N open docks and Browser Sources therefore cost
 * the platforms one request per TTL window, not one per surface per poll.
 */

const { normalizeKickSlug } = require("./kickChannel");
const { normalizeYoutubeInput } = require("./youtubeLiveChat");

/** How long a fetched count is served before a refetch. */
const CACHE_TTL_MS = 20_000;
/** Bound every upstream call so a hung fetch can't pin the request. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Viewer lookups are optional dashboard decoration, so they must have a much
 * smaller memory budget than replay ingestion or game analysis. Native fetch
 * transparently decompresses responses; these limits are therefore enforced
 * against the decompressed byte stream, not just Content-Length.
 */
const TWITCH_JSON_MAX_BYTES = 256 * 1024;
const KICK_JSON_MAX_BYTES = 512 * 1024;
const YOUTUBE_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Keep long-running processes bounded even when many channel names rotate. */
const CACHE_MAX_ENTRIES = 256;
const IN_FLIGHT_MAX_ENTRIES = 4;
const IN_FLIGHT_MAX_SUBSCRIBERS = 16;
const CHANNEL_INPUT_MAX_CHARS = 2048;
const CAPACITY_WARNING_INTERVAL_MS = 10_000;

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

/** @param {unknown} raw @param {number} fallback @returns {number} */
function positiveInteger(raw, fallback) {
  return Number.isInteger(raw) && Number(raw) > 0 ? Number(raw) : fallback;
}

/**
 * Best-effort cancellation used when a declared or streamed response exceeds
 * its memory budget. It deliberately never hides the authoritative size error.
 *
 * @param {any} body
 */
async function cancelBody(body) {
  try {
    await body?.cancel?.();
  } catch {
    // The caller still reports the original bounded-response failure.
  }
}

/**
 * Read one response without allowing chunked transfer encoding or transparent
 * decompression to bypass the byte ceiling. Native fetch takes the streaming
 * branch. The `.text()` fallback exists only for small injected test doubles
 * and is still checked before its contents can be parsed.
 *
 * @param {Response|any} response
 * @param {number} maxBytes
 * @param {string} provider
 * @returns {Promise<string>}
 */
async function readBoundedText(response, maxBytes, provider) {
  const declaredRaw = response?.headers?.get?.("content-length");
  const declared = Number(declaredRaw);
  if (
    declaredRaw !== null &&
    declaredRaw !== undefined &&
    declaredRaw !== "" &&
    Number.isFinite(declared) &&
    declared > maxBytes
  ) {
    await cancelBody(response?.body);
    throw new Error(`${provider} response exceeded the safe size limit`);
  }

  const reader = response?.body?.getReader?.();
  if (reader) {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await cancelBody(reader);
          throw new Error(`${provider} response exceeded the safe size limit`);
        }
        chunks.push(
          Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
      }
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    } finally {
      chunks.length = 0;
      try {
        reader.releaseLock?.();
      } catch {
        // Some injected readers do not expose reusable locks.
      }
    }
  }

  if (typeof response?.text !== "function") {
    throw new Error(`${provider} response body unavailable`);
  }
  const text = String(await response.text());
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${provider} response exceeded the safe size limit`);
  }
  return text;
}

/**
 * JSON is parsed only after the complete decompressed response has passed the
 * byte ceiling above.
 *
 * @param {Response|any} response
 * @param {number} maxBytes
 * @param {string} provider
 * @returns {Promise<Record<string, any>>}
 */
async function readBoundedJson(response, maxBytes, provider) {
  return /** @type {Record<string, any>} */ (
    JSON.parse(await readBoundedText(response, maxBytes, provider))
  );
}

/**
 * @param {"twitch"|"kick"|"youtube"|"tiktok"} platform
 * @returns {PlatformViewers}
 */
function unknownCount(platform) {
  return { platform, viewers: null, live: false };
}

/**
 * @typedef {{
 *   platform: "twitch"|"kick"|"youtube"|"tiktok",
 *   viewers: number | null,
 *   live: boolean,
 *   observedAtMs?: number,
 * }} PlatformViewers
 */

/**
 * @typedef {{ value: PlatformViewers, observedAtMs: number | null }}
 * ObservedPlatformViewers
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
 * Parse the JSON object beginning at `openBrace` without letting a
 * neighbouring renderer's fields leak into the match. YouTube embeds
 * these renderers as JSON inside the watch-page response.
 *
 * @param {string} source
 * @param {number} openBrace
 * @returns {Record<string, any> | null}
 */
function parseEmbeddedJsonObject(source, openBrace) {
  if (source[openBrace] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBrace; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(source.slice(openBrace, i + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** @param {Record<string, any>} renderer @returns {string} */
function youtubeViewCountLabel(renderer) {
  const viewCount = renderer?.viewCount;
  if (typeof viewCount?.simpleText === "string") return viewCount.simpleText;
  if (!Array.isArray(viewCount?.runs)) return "";
  return viewCount.runs
    .map((/** @type {Record<string, any>} */ run) =>
      typeof run?.text === "string" ? run.text : "",
    )
    .join("");
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
 * omits it. Both `"isLive":true` and the same renderer's visible
 * "watching now" label are required; otherwise its number may be
 * lifetime views and reports null.
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
    const brace = html.indexOf("{", open.index);
    const renderer = parseEmbeddedJsonObject(html, brace);
    if (!renderer || renderer.isLive !== true) continue;

    // `isLive` only says the VIDEO is live. When a streamer hides the
    // concurrent audience, YouTube can still put the video's lifetime
    // views in this renderer. The visible label is the semantic guard:
    // never accept `originalViewCount` unless this exact object says
    // the figure is "watching now".
    const label = youtubeViewCountLabel(renderer);
    if (!/\bwatching now\b/i.test(label)) continue;

    const exact = toViewerCount(renderer.originalViewCount);
    if (exact !== null) return exact;

    // Locale-formatted fallback, e.g. "1,200 watching now". Page
    // headers request English, so requiring that label is deliberate.
    const visible = label.match(/([\d][\d,.\s\u00a0]*)\s+watching now\b/i);
    if (visible) {
      const n = toViewerCount(visible[1].replace(/[.\s\u00a0]/g, ""));
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
   *   maxCacheEntries?: number,
   *   maxInFlight?: number,
   *   maxSubscribersPerLookup?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.tiktokRelay = opts.tiktokRelay || null;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || null;
    this.maxCacheEntries = positiveInteger(
      opts.maxCacheEntries,
      CACHE_MAX_ENTRIES,
    );
    this.maxInFlight = positiveInteger(
      opts.maxInFlight,
      IN_FLIGHT_MAX_ENTRIES,
    );
    this.maxSubscribersPerLookup = positiveInteger(
      opts.maxSubscribersPerLookup,
      IN_FLIGHT_MAX_SUBSCRIBERS,
    );
    this.lastCapacityWarningAtMs = 0;
    /**
     * @type {Map<string, {
     *   atMs: number, observedAtMs: number, value: PlatformViewers,
     * }>}
     */
    this.cache = new Map();
    /**
     * @type {Map<string, {
     *   promise: Promise<ObservedPlatformViewers>, subscribers: number,
     * }>}
     */
    this.inFlight = new Map();
  }

  /**
   * @param {string} key
   * @param {PlatformViewers} value
   * @param {number} observedAtMs
   */
  setCached(key, value, observedAtMs) {
    this.cache.delete(key);
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { atMs: this.now(), observedAtMs, value });
  }

  /**
   * Capacity rejection is expected during a burst. Throttle its warning so
   * protective shedding cannot itself turn into an unbounded logging burst.
   *
   * @param {string} reason
   * @param {string} platform
   */
  warnCapacity(reason, platform) {
    const nowMs = this.now();
    if (nowMs - this.lastCapacityWarningAtMs < CAPACITY_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastCapacityWarningAtMs = nowMs;
    this.log?.warn?.(
      { platform, reason },
      "multichat viewer count lookup shed for capacity",
    );
  }

  /**
   * Aggregate-only runtime telemetry. Channel identities never leave this
   * service through diagnostics.
   *
   * @returns {{
   *   cacheEntries: number,
   *   inflightRequests: number,
   *   subscribers: number,
   *   maxCacheEntries: number,
   *   maxInflightRequests: number,
   *   maxSubscribersPerRequest: number,
   * }}
   */
  capacitySnapshot() {
    let subscribers = 0;
    for (const flight of this.inFlight.values()) {
      subscribers += flight.subscribers;
    }
    return {
      cacheEntries: this.cache.size,
      inflightRequests: this.inFlight.size,
      subscribers,
      maxCacheEntries: this.maxCacheEntries,
      maxInflightRequests: this.maxInFlight,
      maxSubscribersPerRequest: this.maxSubscribersPerLookup,
    };
  }

  /**
   * Per-platform counts + the combined total for one streamer's
   * multichat config. Platforms that are disabled or unconfigured are
   * absent from the result entirely — the dock only shows what the
   * streamer actually runs.
   *
   * `total` sums the KNOWN current snapshots only — it is the combined
   * concurrent audience, never an accumulated/lifetime count. A
   * blocked Kick lookup understates it rather than poisoning it with
   * a guess; `partial` tells the UI that happened.
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
      jobs.push(this.lookupForConfig("twitch", String(cfg.twitch.channel)));
    }
    if (cfg.kick?.enabled && cfg.kick.channel) {
      jobs.push(this.lookupForConfig("kick", String(cfg.kick.channel)));
    }
    if (cfg.youtube?.enabled && cfg.youtube.channel) {
      jobs.push(this.lookupForConfig("youtube", String(cfg.youtube.channel)));
    }
    if (cfg.tiktok?.enabled && cfg.tiktok.username) {
      jobs.push(this.lookupForConfig("tiktok", String(cfg.tiktok.username)));
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
    return this.lookupObserved(platform, channel).then(({ value }) => value);
  }

  /**
   * Viewer response shape used only by `forConfig`. Public single-platform
   * lookup callers retain the legacy object exactly, while the Dock receives
   * the time this upstream observation completed (including cache hits).
   *
   * @param {"twitch"|"kick"|"youtube"|"tiktok"} platform
   * @param {string} channel
   * @returns {Promise<PlatformViewers & { observedAtMs?: number }>}
   */
  lookupForConfig(platform, channel) {
    return this.lookupObserved(platform, channel).then(
      ({ value, observedAtMs }) => ({
        ...value,
        ...(observedAtMs === null ? {} : { observedAtMs }),
      }),
    );
  }

  /**
   * Internal lookup retaining observation metadata through cache/in-flight
   * de-duplication. `observedAtMs` is captured when `fetchOne` resolves: the
   * response may contain a raid that happened while the request was in flight,
   * so request-start time would incorrectly label that newer count pre-raid.
   *
   * @param {"twitch"|"kick"|"youtube"|"tiktok"} platform
   * @param {string} channel
   * @returns {Promise<ObservedPlatformViewers>}
   */
  lookupObserved(platform, channel) {
    const input = String(channel ?? "").trim();
    if (!input || input.length > CHANNEL_INPUT_MAX_CHARS) {
      return Promise.resolve({
        value: unknownCount(platform),
        observedAtMs: null,
      });
    }
    // YouTube video IDs are case-sensitive. Other supported channel names are
    // not, so retain their previous case-insensitive cache behaviour.
    const identity = platform === "youtube" ? input : input.toLowerCase();
    const key = `${platform}:${identity}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.atMs < this.ttlMs) {
      // Map insertion order doubles as a tiny LRU list.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve({
        value: hit.value,
        observedAtMs: hit.observedAtMs,
      });
    }
    if (hit) this.cache.delete(key);
    const pending = this.inFlight.get(key);
    if (pending) {
      if (pending.subscribers >= this.maxSubscribersPerLookup) {
        this.warnCapacity("subscriber_limit", platform);
        return Promise.resolve({
          value: unknownCount(platform),
          observedAtMs: null,
        });
      }
      pending.subscribers += 1;
      return pending.promise;
    }
    if (this.inFlight.size >= this.maxInFlight) {
      this.warnCapacity("in_flight_limit", platform);
      return Promise.resolve({
        value: unknownCount(platform),
        observedAtMs: null,
      });
    }

    const baseJob = this.fetchOne(platform, channel)
      .catch((err) => {
        // Upstream hiccups are expected (Cloudflare, rate limits, a
        // page shape change): report unknown, never a fabricated 0.
        this.log?.warn?.(
          { err: String(err), platform },
          "multichat viewer count lookup failed",
        );
        return unknownCount(platform);
      })
      .then((value) => {
        const observedAtMs = this.now();
        this.setCached(key, value, observedAtMs);
        return { value, observedAtMs };
      });
    const flight = { promise: baseJob, subscribers: 1 };
    flight.promise = baseJob.finally(() => {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    });
    this.inFlight.set(key, flight);
    return flight.promise;
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
    if (!res.ok) {
      await cancelBody(res.body);
      throw new Error(`twitch gql ${res.status}`);
    }
    const json = await readBoundedJson(
      res,
      TWITCH_JSON_MAX_BYTES,
      "twitch",
    );
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
    if (!res.ok) {
      await cancelBody(res.body);
      throw new Error(`kick ${res.status}`);
    }
    const json = await readBoundedJson(res, KICK_JSON_MAX_BYTES, "kick");
    const live = json?.livestream;
    if (!live || live.is_live === false) {
      return { platform: "kick", viewers: 0, live: false };
    }
    // `viewer_count` is the endpoint's concurrent audience. Do not
    // guess from other similarly named fields if it is absent.
    const viewers = toViewerCount(live.viewer_count);
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
      if (!res.ok) {
        await cancelBody(res.body);
        throw new Error(`youtube page ${res.status}`);
      }
      const html = await readBoundedText(
        res,
        YOUTUBE_PAGE_MAX_BYTES,
        "youtube",
      );
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
  TWITCH_JSON_MAX_BYTES,
  KICK_JSON_MAX_BYTES,
  YOUTUBE_PAGE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  IN_FLIGHT_MAX_ENTRIES,
  IN_FLIGHT_MAX_SUBSCRIBERS,
};
