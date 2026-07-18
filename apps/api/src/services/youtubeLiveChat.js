"use strict";

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
 * @returns {Promise<string>}
 */
async function fetchPage(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: PAGE_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new YoutubeChatError("upstream", `youtube page ${res.status}`);
  }
  return res.text();
}

/**
 * Resolve a streamer input to a live chat session.
 *
 * @param {string} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ videoId: string, continuation: string,
 *   clientVersion: string }>}
 */
async function resolveLiveChat(input, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { videoId: directId, pageUrls } = normalizeYoutubeInput(input);

  let videoId = directId;
  if (!videoId) {
    for (const url of pageUrls) {
      const html = await fetchPage(fetchImpl, url);
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

  const chatHtml = await fetchPage(fetchImpl, LIVE_CHAT_URL + videoId);
  const continuation = extractChatContinuation(chatHtml);
  if (!continuation) {
    // A watch page exists but its chat frame has no continuation —
    // either the video isn't live or chat is disabled.
    const watchHtml = await fetchPage(fetchImpl, WATCH_URL + videoId);
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
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function pollLiveChat(args, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const continuation = String(args?.continuation || "");
  if (!continuation || continuation.length > 4096) {
    throw new YoutubeChatError("bad_input", "continuation required");
  }
  const clientVersion =
    typeof args.clientVersion === "string" && /^[0-9.]{5,30}$/.test(args.clientVersion)
      ? args.clientVersion
      : DEFAULT_CLIENT_VERSION;
  const res = await fetchImpl(INNERTUBE_CHAT_URL, {
    method: "POST",
    headers: { ...PAGE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion, hl: "en" } },
      continuation,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new YoutubeChatError("upstream", `youtube chat ${res.status}`);
  }
  const json = await res.json();
  return parseLiveChatResponse(/** @type {Record<string, any>} */ (json));
}

module.exports = {
  YoutubeChatError,
  normalizeYoutubeInput,
  extractLiveVideoId,
  extractChatContinuation,
  extractClientVersion,
  runsToText,
  badgeTags,
  parseLiveChatResponse,
  resolveLiveChat,
  pollLiveChat,
  DEFAULT_CLIENT_VERSION,
};
