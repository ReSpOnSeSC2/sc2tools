"use strict";

/**
 * Kick channel resolution for the multichat overlay widget.
 *
 * Kick chat itself needs NO auth: public chatrooms are readable by
 * subscribing to `chatrooms.<id>.v2` on Kick's public Pusher app —
 * the OBS Browser Source does that directly (verified: the Pusher
 * handshake + subscribe succeed anonymously). The ONLY thing that
 * needs Kick's HTTP API is turning a channel slug into its numeric
 * chatroom id, once, at setup time.
 *
 * That lookup endpoint sits behind Cloudflare bot protection which
 * frequently 403s datacenter IPs. So this resolver is best-effort:
 * try the v2 + v1 endpoints with browser-like headers, and when
 * Cloudflare blocks us, throw a structured `kick_blocked` error the
 * settings UI turns into a guided manual flow (the streamer opens
 * `kick.com/api/v2/channels/<slug>` in their own browser — a real
 * browser session passes Cloudflare — and pastes the JSON or the id).
 */

const FETCH_TIMEOUT_MS = 12000;

const HEADERS = Object.freeze({
  Accept: "application/json",
  "Accept-Language": "en",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

class KickResolveError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "KickResolveError";
    this.code = code;
  }
}

/**
 * Normalize a pasted channel value ("Slug", "kick.com/slug", full URL)
 * to the bare slug Kick uses in its API paths.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeKickSlug(raw) {
  let input = String(raw || "").trim().toLowerCase();
  if (!input) throw new KickResolveError("bad_input", "channel required");
  input = input.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (input.startsWith("kick.com/")) {
    input = input.slice("kick.com/".length);
  }
  input = input.split(/[/?#]/)[0];
  if (!/^[a-z0-9_-]{2,40}$/.test(input)) {
    throw new KickResolveError("bad_input", "unrecognized Kick channel");
  }
  return input;
}

/**
 * Pull the chatroom id out of a Kick channels API payload (v1 and v2
 * share the `chatroom.id` shape).
 *
 * @param {Record<string, any>} json
 * @returns {number | null}
 */
function chatroomIdFrom(json) {
  const id = json?.chatroom?.id;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Resolve a Kick slug to its numeric chatroom id.
 *
 * @param {string} slug
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ slug: string, chatroomId: number }>}
 */
async function resolveKickChatroom(slug, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const clean = normalizeKickSlug(slug);
  let blocked = false;
  for (const version of ["v2", "v1"]) {
    let res;
    try {
      res = await fetchImpl(
        `https://kick.com/api/${version}/channels/${clean}`,
        { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
    } catch {
      blocked = true;
      continue;
    }
    if (res.status === 404) {
      throw new KickResolveError("not_found", "Kick channel not found");
    }
    if (!res.ok) {
      blocked = true;
      continue;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      blocked = true;
      continue;
    }
    const chatroomId = chatroomIdFrom(json);
    if (chatroomId) return { slug: clean, chatroomId };
  }
  throw new KickResolveError(
    blocked ? "kick_blocked" : "not_found",
    blocked
      ? "Kick's API blocked the lookup — use the manual chatroom id flow"
      : "no chatroom on that Kick channel",
  );
}

module.exports = {
  KickResolveError,
  normalizeKickSlug,
  chatroomIdFrom,
  resolveKickChatroom,
};
