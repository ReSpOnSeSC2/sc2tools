"use strict";

const { createHash } = require("crypto");

/**
 * YouTube live-chat relay — resolve + poll helpers for the multichat
 * overlay widget.
 *
 * YouTube's live chat has no key-free public API and the web endpoints
 * don't send CORS headers, so the OBS Browser Source can't talk to
 * YouTube directly. This service is the thinnest possible relay over
 * the SAME endpoints the youtube.com chat frame itself uses
 * (`youtubei/v1/live_chat/get_live_chat`, no API key required):
 *
 *   1. ``resolveLiveChat(input)`` — turn whatever the streamer pasted
 *      (@handle, channel URL, watch URL, or bare 11-char video id)
 *      into the currently-live video id + the "Live chat" (all
 *      messages) continuation token scraped from the popout page.
 *   2. ``pollLiveChat({continuation})`` — one stateless poll: POST the
 *      continuation, parse the actions into slim chat messages, hand
 *      back the NEXT continuation + the polling interval YouTube
 *      itself requests. The client owns the loop, so the API holds no
 *      per-viewer state and horizontal scaling stays trivial.
 *
 * Parsing is defensive throughout: YouTube renderers are sprawling
 * union types and absent fields are the norm, not the exception. Only
 * ``liveChatTextMessageRenderer`` items become messages; membership
 * and Super Chat renderers become slim `events` for the events layer,
 * and everything else (join banners, tickers) is skipped.
 */

const DEFAULT_CLIENT_VERSION = "2.20260715.04.00";
const WATCH_URL = "https://www.youtube.com/watch?v=";
const LIVE_CHAT_URL = "https://www.youtube.com/live_chat?is_popout=1&v=";
const INNERTUBE_CHAT_URL =
  "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false";

/** Browser-like headers; YouTube serves a slim consent page otherwise. */
const PAGE_HEADERS = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en",
});

/** Clamp YouTube's requested poll interval to a sane overlay cadence. */
const MIN_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 4000;

/** Bound every upstream fetch so a hung poll can't pin a connection. */
const FETCH_TIMEOUT_MS = 15000;

/**
 * A normal poll is tens of kilobytes. Keep generous headroom for busy chats,
 * but never allow an upstream error/schema spike to become an unbounded
 * Buffer + string + parsed object on the API heap.
 */
const POLL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RELAY_RESPONSE_MAX_BYTES = 512 * 1024;
const POLL_RESULT_CACHE_MS = 1500;
const RESOLVE_RESULT_CACHE_MS = 5000;
const YOUTUBE_RELAY_MAX_ACTIVE = 2;
const YOUTUBE_RELAY_MAX_SUBSCRIBERS = 8;
const YOUTUBE_RELAY_CACHE_MAX = 4;

class YoutubeChatError extends Error {
  /**
   * @param {string} code machine-readable ("not_live", "not_found",
   *   "upstream", "bad_input")
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "YoutubeChatError";
    this.code = code;
  }
}

/**
 * @param {{ continuation: unknown, clientVersion?: unknown }} args
 * @returns {{continuation: string, clientVersion: string}}
 */
function normalizePollArgs(args) {
  const continuation = String(args?.continuation || "");
  if (!continuation || continuation.length > 4096) {
    throw new YoutubeChatError("bad_input", "continuation required");
  }
  const clientVersion =
    typeof args.clientVersion === "string" &&
    /^[0-9.]{5,30}$/.test(args.clientVersion)
      ? args.clientVersion
      : DEFAULT_CLIENT_VERSION;
  return { continuation, clientVersion };
}

/**
 * Read one native-fetch response without allowing chunked transfer encoding
 * to bypass the limit. The decoded string is deliberately short-lived and is
 * released as soon as the caller parses or extracts from it.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBoundedTextResponse(response, maxBytes) {
  const advertised = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new YoutubeChatError(
      "upstream_too_large",
      "youtube chat response exceeded the safe size limit",
    );
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new YoutubeChatError(
      "upstream",
      "youtube chat response was not streamable",
    );
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new YoutubeChatError(
          "upstream_too_large",
          "youtube chat response exceeded the safe size limit",
        );
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    chunks.length = 0;
    reader.releaseLock?.();
  }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Record<string, any>>}
 */
async function readBoundedJsonResponse(response, maxBytes) {
  const text = await readBoundedTextResponse(response, maxBytes);
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("unexpected response shape");
    }
    return /** @type {Record<string, any>} */ (json);
  } catch {
    throw new YoutubeChatError(
      "upstream",
      "youtube chat returned invalid JSON",
    );
  }
}

/**
 * One router owns one coordinator, which is process-global in production.
 * Multiple OBS surfaces asking for the same continuation share a single
 * fetch/parse/JSON stringify. A small number of distinct streams can make
 * progress concurrently; further work fails fast instead of retaining a
 * queue of upstream response bodies while the heap is under pressure.
 */
class YoutubePollCoordinator {
  /**
   * @param {{
   *   fetchImpl?: typeof fetch,
   *   maxActive?: number,
   *   maxSubscribers?: number,
   *   cacheMax?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.maxActive = Math.max(
      1,
      Math.floor(opts.maxActive || YOUTUBE_RELAY_MAX_ACTIVE),
    );
    this.maxSubscribers = Math.max(
      1,
      Math.floor(opts.maxSubscribers || YOUTUBE_RELAY_MAX_SUBSCRIBERS),
    );
    this.cacheMax = Math.max(
      1,
      Math.floor(opts.cacheMax || YOUTUBE_RELAY_CACHE_MAX),
    );
    /** @type {Map<string, {
     *   key: string,
     *   controller: AbortController,
     *   promise: Promise<string>,
     *   subscribers: number,
     *   settled: boolean,
     * }>} */
    this.active = new Map();
    /** @type {Map<string, {body: string, expiresAt: number}>} */
    this.recent = new Map();
  }

  /**
   * Relay pressure only. Continuations, channel inputs, and hashed cache keys
   * are deliberately excluded.
   */
  capacitySnapshot() {
    let subscribers = 0;
    for (const flight of this.active.values()) {
      subscribers += Number(flight.subscribers) || 0;
    }
    return {
      activeRequests: this.active.size,
      subscribers,
      cachedResponses: this.recent.size,
      maxActiveRequests: this.maxActive,
      maxSubscribersPerRequest: this.maxSubscribers,
      maxCachedResponses: this.cacheMax,
    };
  }

  /**
   * @param {{continuation: unknown, clientVersion?: unknown}} args
   * @param {{signal?: AbortSignal}} [opts]
   */
  async poll(args, opts = {}) {
    const normalized = normalizePollArgs(args);
    const key = `poll:${createHash("sha256")
      .update(normalized.clientVersion)
      .update("\0")
      .update(normalized.continuation)
      .digest("base64url")}`;
    return this._run(
      key,
      (workSignal) =>
        pollLiveChat(normalized, {
          fetchImpl: this.fetchImpl,
          signal: workSignal,
        }),
      opts.signal,
      "youtube_poll_busy",
      POLL_RESULT_CACHE_MS,
    );
  }

  /**
   * @param {string} input
   * @param {{signal?: AbortSignal}} [opts]
   */
  async resolve(input, opts = {}) {
    const normalizedInput = String(input || "").trim();
    normalizeYoutubeInput(normalizedInput);
    // YouTube video ids are case-sensitive. Lower-casing the entire input
    // aliases distinct streams (for example AbC... and aBc...) and can return
    // one user's continuation to another. Preserve the validated input bytes;
    // accepting a little less cache coalescing for differently-cased handles
    // is safer than cross-stream cache contamination.
    const key = `resolve:${createHash("sha256")
      .update(normalizedInput)
      .digest("base64url")}`;
    return this._run(
      key,
      (workSignal) =>
        resolveLiveChat(normalizedInput, {
          fetchImpl: this.fetchImpl,
          signal: workSignal,
        }),
      opts.signal,
      "youtube_resolve_busy",
      RESOLVE_RESULT_CACHE_MS,
    );
  }

  /**
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<Record<string, any>>} work
   * @param {AbortSignal | undefined} signal
   * @param {string} busyCode
   * @param {number} cacheMs
   */
  async _run(key, work, signal, busyCode, cacheMs) {
    if (signal?.aborted) throw signal.reason || abortError();
    this._pruneRecent();
    const cached = this.recent.get(key);
    if (cached) {
      // Touch so the bounded Map is also an LRU under a busy multi-user stream.
      this.recent.delete(key);
      this.recent.set(key, cached);
      return cached.body;
    }

    let flight = this.active.get(key);
    // The last subscriber may disconnect before the upstream fetch observes
    // its abort. Keep that retiring work counted until its promise settles:
    // immediately replacing it would let rapid disconnect/reconnect cycles
    // exceed the process-wide upstream-memory bound. A live client receives a
    // retryable busy response and retries the same continuation shortly.
    if (flight?.controller.signal.aborted) {
      throw new YoutubeChatError(
        busyCode,
        "youtube chat relay is finishing cancelled work; retry shortly",
      );
    }
    if (!flight && this.active.size >= this.maxActive) {
      throw new YoutubeChatError(
        busyCode,
        "youtube chat relay is busy; retry shortly",
      );
    }
    if (flight && flight.subscribers >= this.maxSubscribers) {
      throw new YoutubeChatError(
        busyCode,
        "youtube chat relay has too many viewers; retry shortly",
      );
    }
    if (!flight) {
      const controller = new AbortController();
      flight = {
        key,
        controller,
        subscribers: 0,
        settled: false,
        promise: Promise.resolve(""),
      };
      const ownedFlight = flight;
      ownedFlight.promise = work(controller.signal)
        .then((value) => {
          const body = JSON.stringify(value);
          if (Buffer.byteLength(body, "utf8") > RELAY_RESPONSE_MAX_BYTES) {
            throw new YoutubeChatError(
              "upstream_too_large",
              "youtube chat result exceeded the safe size limit",
            );
          }
          this.recent.set(key, { body, expiresAt: Date.now() + cacheMs });
          this._pruneRecent();
          return body;
        })
        .finally(() => {
          ownedFlight.settled = true;
          if (this.active.get(key) === ownedFlight) this.active.delete(key);
        });
      this.active.set(key, ownedFlight);
    }

    flight.subscribers += 1;
    try {
      if (!signal) return await flight.promise;
      return await waitForPromiseOrAbort(flight.promise, signal);
    } finally {
      flight.subscribers = Math.max(0, flight.subscribers - 1);
      if (flight.subscribers === 0 && !flight.settled) {
        flight.controller.abort(abortError());
      }
    }
  }

  _pruneRecent() {
    const now = Date.now();
    for (const [key, cached] of this.recent) {
      if (cached.expiresAt <= now) this.recent.delete(key);
    }
    while (this.recent.size > this.cacheMax) {
      const oldest = this.recent.keys().next().value;
      if (typeof oldest !== "string") break;
      this.recent.delete(oldest);
    }
  }
}

function abortError() {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function waitForPromiseOrAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason || abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Normalize whatever the streamer pasted into candidate page URLs, in
 * priority order. Supported: bare 11-char video id, watch/live/youtu.be
 * URLs, @handle, channel/c/user URLs, bare channel names.
 *
 * @param {string} raw
 * @returns {{ videoId: string | null, pageUrls: string[] }}
 */
function normalizeYoutubeInput(raw) {
  const input = String(raw || "").trim();
  if (!input) throw new YoutubeChatError("bad_input", "channel required");

  // Bare video id.
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) {
    return { videoId: input, pageUrls: [] };
  }

  // URL forms.
  const urlMatch = input.match(/^https?:\/\/[^\s]+$/i);
  if (urlMatch) {
    let u;
    try {
      u = new URL(input);
    } catch {
      throw new YoutubeChatError("bad_input", "unparseable URL");
    }
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { videoId: id, pageUrls: [] };
    }
    if (host === "youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
        return { videoId: v, pageUrls: [] };
      }
      const path = u.pathname.replace(/\/+$/, "");
      const liveMatch = path.match(/^\/live\/([A-Za-z0-9_-]{11})$/);
      if (liveMatch) return { videoId: liveMatch[1], pageUrls: [] };
      // Channel-ish URL — ask its /live page which video is on air.
      if (path) {
        return {
          videoId: null,
          pageUrls: [`https://www.youtube.com${path}/live`],
        };
      }
    }
    throw new YoutubeChatError("bad_input", "unrecognized YouTube URL");
  }

  // @handle or bare channel name.
  const handle = input.startsWith("@") ? input : `@${input}`;
  if (!/^@[A-Za-z0-9._-]{2,60}$/.test(handle)) {
    throw new YoutubeChatError("bad_input", "unrecognized channel or handle");
  }
  return {
    videoId: null,
    pageUrls: [`https://www.youtube.com/${handle}/live`],
  };
}

/**
 * Extract the live video id from a channel /live page (or verify a
 * watch page is live). Returns null when the page carries no live
 * video.
 *
 * @param {string} html
 * @returns {string | null}
 */
function extractLiveVideoId(html) {
  if (!/"isLive"\s*:\s*true/.test(html)) return null;
  const m = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  return m ? m[1] : null;
}

/**
 * Extract the all-messages "Live chat" continuation from the popout
 * chat page. The page embeds several continuations; the LAST one is
 * the unfiltered "Live chat" feed (the first is "Top chat", which
 * hides most messages — verified against live streams).
 *
 * @param {string} html
 * @returns {string | null}
 */
function extractChatContinuation(html) {
  const all = [...html.matchAll(/"continuation"\s*:\s*"([A-Za-z0-9_%-]+)"/g)];
  if (all.length === 0) return null;
  return all[all.length - 1][1];
}

/** @param {string} html @returns {string} */
function extractClientVersion(html) {
  const m = html.match(/"clientVersion"\s*:\s*"([0-9.]+)"/);
  return m ? m[1] : DEFAULT_CLIENT_VERSION;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{signal?: AbortSignal, maxResponseBytes?: number}} [opts]
 * @returns {Promise<string>}
 */
async function fetchPage(fetchImpl, url, opts = {}) {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const res = await fetchImpl(url, {
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal,
    });
    if (!res.ok) {
      throw new YoutubeChatError("upstream", `youtube page ${res.status}`);
    }
    return await readBoundedTextResponse(
      res,
      opts.maxResponseBytes || PAGE_RESPONSE_MAX_BYTES,
    );
  } catch (err) {
    if (err instanceof YoutubeChatError || opts.signal?.aborted) throw err;
    throw new YoutubeChatError("upstream", "youtube page request failed");
  }
}

/**
 * Resolve a streamer input to a live chat session.
 *
 * @param {string} input
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, maxPageBytes?: number }} [opts]
 * @returns {Promise<{ videoId: string, continuation: string,
 *   clientVersion: string }>}
 */
async function resolveLiveChat(input, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { videoId: directId, pageUrls } = normalizeYoutubeInput(input);

  let videoId = directId;
  if (!videoId) {
    for (const url of pageUrls) {
      const html = await fetchPage(fetchImpl, url, {
        signal: opts.signal,
        maxResponseBytes: opts.maxPageBytes,
      });
      videoId = extractLiveVideoId(html);
      if (videoId) break;
    }
    if (!videoId) {
      throw new YoutubeChatError(
        "not_live",
        "channel has no live stream right now",
      );
    }
  }

  const chatHtml = await fetchPage(fetchImpl, LIVE_CHAT_URL + videoId, {
    signal: opts.signal,
    maxResponseBytes: opts.maxPageBytes,
  });
  const continuation = extractChatContinuation(chatHtml);
  if (!continuation) {
    // A watch page exists but its chat frame has no continuation —
    // either the video isn't live or chat is disabled.
    const watchHtml = await fetchPage(fetchImpl, WATCH_URL + videoId, {
      signal: opts.signal,
      maxResponseBytes: opts.maxPageBytes,
    });
    if (!extractLiveVideoId(watchHtml)) {
      throw new YoutubeChatError("not_live", "video is not live");
    }
    throw new YoutubeChatError("not_found", "live chat is unavailable");
  }
  return {
    videoId,
    continuation,
    clientVersion: extractClientVersion(chatHtml),
  };
}

/**
 * Flatten a message's `runs` into plain text. Emoji runs render as
 * their first shortcut (":smile:") so custom/member emoji stay legible
 * as text — the overlay renders text only, never remote images.
 *
 * @param {Array<Record<string, any>>} runs
 * @returns {string}
 */
function runsToText(runs) {
  if (!Array.isArray(runs)) return "";
  let out = "";
  for (const run of runs) {
    if (typeof run?.text === "string") {
      out += run.text;
      continue;
    }
    const emoji = run?.emoji;
    if (emoji) {
      const shortcut =
        (Array.isArray(emoji.shortcuts) && emoji.shortcuts[0]) ||
        (Array.isArray(emoji.searchTerms) && emoji.searchTerms[0]) ||
        emoji.emojiId ||
        "";
      out += String(shortcut);
    }
  }
  return out;
}

/**
 * Map authorBadges to slim role tags.
 *
 * @param {Array<Record<string, any>> | undefined} badges
 * @returns {string[]}
 */
function badgeTags(badges) {
  if (!Array.isArray(badges)) return [];
  /** @type {string[]} */
  const out = [];
  for (const b of badges) {
    const r = b?.liveChatAuthorBadgeRenderer;
    if (!r) continue;
    const icon = r.icon?.iconType;
    const tooltip = String(r.tooltip || "");
    if (icon === "OWNER") out.push("owner");
    else if (icon === "MODERATOR") out.push("moderator");
    else if (icon === "VERIFIED") out.push("verified");
    else if (r.customThumbnail || /member/i.test(tooltip)) out.push("member");
  }
  return out;
}

/**
 * Parse one raw get_live_chat response into slim messages + platform
 * events + the next continuation. Pure — unit-tested against a
 * captured real response.
 *
 * Events cover the two receipt renderers a chat overlay cares about:
 * ``liveChatMembershipItemRenderer`` (new/renewed members) and
 * ``liveChatPaidMessageRenderer`` (Super Chats). Everything else
 * (stickers, banners, tickers) stays skipped.
 *
 * @param {Record<string, any>} json
 * @returns {{ messages: Array<{ id: string, user: string, text: string,
 *   badges: string[], atMs: number }>, events: Array<{ id: string,
 *   kind: string, user: string, detail: string, amount?: string,
 *   atMs: number }>, continuation: string | null, timeoutMs: number,
 *   done: boolean }}
 */
function parseLiveChatResponse(json) {
  const root = json?.continuationContents?.liveChatContinuation;
  if (!root) {
    // Stream over (or continuation expired) — tell the client to
    // re-resolve rather than hammering a dead token.
    return {
      messages: [],
      events: [],
      continuation: null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      done: true,
    };
  }

  /** @type {Array<{id: string, user: string, text: string, badges: string[], atMs: number}>} */
  const messages = [];
  /** @type {Array<{id: string, kind: string, user: string, detail: string, amount?: string, atMs: number}>} */
  const events = [];
  for (const action of Array.isArray(root.actions) ? root.actions : []) {
    const item = action?.addChatItemAction?.item;

    const member = item?.liveChatMembershipItemRenderer;
    if (member) {
      const usec = Number(member.timestampUsec);
      events.push({
        id: String(member.id || `${member.timestampUsec}-${events.length}`),
        kind: "member",
        user: String(member.authorName?.simpleText || "viewer"),
        detail:
          runsToText(member.headerSubtext?.runs).trim() ||
          runsToText(member.headerPrimaryText?.runs).trim() ||
          "became a member",
        atMs: Number.isFinite(usec) ? Math.round(usec / 1000) : Date.now(),
      });
      continue;
    }

    const paid = item?.liveChatPaidMessageRenderer;
    if (paid) {
      const usec = Number(paid.timestampUsec);
      const amount = String(paid.purchaseAmountText?.simpleText || "").trim();
      events.push({
        id: String(paid.id || `${paid.timestampUsec}-${events.length}`),
        kind: "superchat",
        user: String(paid.authorName?.simpleText || "viewer"),
        detail: runsToText(paid.message?.runs).trim() || "sent a Super Chat",
        ...(amount ? { amount } : {}),
        atMs: Number.isFinite(usec) ? Math.round(usec / 1000) : Date.now(),
      });
      continue;
    }

    const r = item?.liveChatTextMessageRenderer;
    if (!r) continue;
    const text = runsToText(r.message?.runs).trim();
    if (!text) continue;
    const usec = Number(r.timestampUsec);
    messages.push({
      id: String(r.id || `${r.timestampUsec}-${messages.length}`),
      user: String(r.authorName?.simpleText || "viewer"),
      text,
      badges: badgeTags(r.authorBadges),
      atMs: Number.isFinite(usec) ? Math.round(usec / 1000) : Date.now(),
    });
  }

  let continuation = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const contWrapper = Array.isArray(root.continuations)
    ? root.continuations[0]
    : null;
  if (contWrapper && typeof contWrapper === "object") {
    for (const value of Object.values(contWrapper)) {
      if (value && typeof value === "object" && value.continuation) {
        continuation = String(value.continuation);
        const t = Number(value.timeoutMs);
        if (Number.isFinite(t)) timeoutMs = t;
        break;
      }
    }
  }
  return {
    messages,
    events,
    continuation,
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs)),
    done: continuation === null,
  };
}

/**
 * One stateless poll against the innertube chat endpoint.
 *
 * @param {{ continuation: string, clientVersion?: string }} args
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, maxResponseBytes?: number }} [opts]
 */
async function pollLiveChat(args, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { continuation, clientVersion } = normalizePollArgs(args);
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const res = await fetchImpl(INNERTUBE_CHAT_URL, {
      method: "POST",
      headers: { ...PAGE_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion, hl: "en" } },
        continuation,
      }),
      signal,
    });
    if (!res.ok) {
      throw new YoutubeChatError("upstream", `youtube chat ${res.status}`);
    }
    const json = await readBoundedJsonResponse(
      res,
      opts.maxResponseBytes || POLL_RESPONSE_MAX_BYTES,
    );
    return parseLiveChatResponse(json);
  } catch (err) {
    if (err instanceof YoutubeChatError || opts.signal?.aborted) throw err;
    throw new YoutubeChatError("upstream", "youtube chat request failed");
  }
}

module.exports = {
  YoutubeChatError,
  YoutubePollCoordinator,
  normalizeYoutubeInput,
  normalizePollArgs,
  extractLiveVideoId,
  extractChatContinuation,
  extractClientVersion,
  runsToText,
  badgeTags,
  parseLiveChatResponse,
  resolveLiveChat,
  pollLiveChat,
  DEFAULT_CLIENT_VERSION,
  POLL_RESPONSE_MAX_BYTES,
  RELAY_RESPONSE_MAX_BYTES,
  YOUTUBE_RELAY_MAX_ACTIVE,
  YOUTUBE_RELAY_MAX_SUBSCRIBERS,
};
