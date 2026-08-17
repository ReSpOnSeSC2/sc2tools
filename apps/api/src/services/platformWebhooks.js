"use strict";

const {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} = require("crypto");

const WEBHOOK_MAX_AGE_MS = 10 * 60 * 1000;
const WEBHOOK_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

// Published by Kick for webhook sender validation. Keeping the documented key
// in source avoids trusting an unauthenticated key fetch during every request.
// Rotation can be shipped as a normal deploy; tests also allow key injection.
const KICK_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

class WebhookVerificationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

/** @param {import('http').IncomingHttpHeaders|Record<string, unknown>} headers */
function lowerHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? String(value[0] || "") : String(value || ""),
    ]),
  );
}

/** @param {{headers:Record<string,unknown>,rawBody:Buffer|string,secret:string,nowMs?:number}} args */
function verifyTwitchWebhook(args) {
  const headers = lowerHeaders(args.headers);
  const messageId = headers["twitch-eventsub-message-id"];
  const timestamp = headers["twitch-eventsub-message-timestamp"];
  const supplied = headers["twitch-eventsub-message-signature"];
  const messageType = headers["twitch-eventsub-message-type"];
  const subscriptionType = headers["twitch-eventsub-subscription-type"];
  requireFreshTimestamp(timestamp, args.nowMs ?? Date.now());
  if (!messageId || messageId.length > 200) {
    throw new WebhookVerificationError("missing_message_id", "missing Twitch message id");
  }
  if (!/^sha256=[0-9a-f]{64}$/i.test(supplied)) {
    throw new WebhookVerificationError("bad_signature", "invalid Twitch signature");
  }
  const secret = String(args.secret || "");
  if (secret.length < 10 || secret.length > 100 || /[^\x20-\x7e]/.test(secret)) {
    throw new WebhookVerificationError("bad_secret", "invalid Twitch webhook secret configuration");
  }
  const body = rawBuffer(args.rawBody);
  const expected = `sha256=${createHmac("sha256", secret)
    .update(messageId, "utf8")
    .update(timestamp, "utf8")
    .update(body)
    .digest("hex")}`;
  if (!safeEqual(expected, supplied.toLowerCase())) {
    throw new WebhookVerificationError("bad_signature", "Twitch signature mismatch");
  }
  return { messageId, timestamp, messageType, subscriptionType };
}

/** @param {{headers:Record<string,unknown>,rawBody:Buffer|string,publicKey?:string,nowMs?:number}} args */
function verifyKickWebhook(args) {
  const headers = lowerHeaders(args.headers);
  const messageId = headers["kick-event-message-id"];
  const timestamp = headers["kick-event-message-timestamp"];
  const supplied = headers["kick-event-signature"];
  const eventType = headers["kick-event-type"];
  const eventVersion = headers["kick-event-version"];
  requireFreshTimestamp(timestamp, args.nowMs ?? Date.now());
  if (!messageId || messageId.length > 200) {
    throw new WebhookVerificationError("missing_message_id", "missing Kick message id");
  }
  let signature;
  try {
    signature = Buffer.from(supplied, "base64");
  } catch {
    signature = Buffer.alloc(0);
  }
  if (signature.length < 64 || !eventType) {
    throw new WebhookVerificationError("bad_signature", "invalid Kick signature");
  }
  const body = rawBuffer(args.rawBody);
  const signed = Buffer.concat([
    Buffer.from(`${messageId}.${timestamp}.`, "utf8"),
    body,
  ]);
  let ok = false;
  try {
    ok = verify(
      "RSA-SHA256",
      signed,
      createPublicKey(args.publicKey || KICK_WEBHOOK_PUBLIC_KEY),
      signature,
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new WebhookVerificationError("bad_signature", "Kick signature mismatch");
  }
  return { messageId, timestamp, eventType, eventVersion };
}

/** @param {unknown} value @param {number} nowMs */
function requireFreshTimestamp(value, nowMs) {
  const atMs = Date.parse(String(value || ""));
  if (!Number.isFinite(atMs)) {
    throw new WebhookVerificationError("bad_timestamp", "invalid webhook timestamp");
  }
  if (
    nowMs - atMs > WEBHOOK_MAX_AGE_MS ||
    atMs - nowMs > WEBHOOK_FUTURE_TOLERANCE_MS
  ) {
    throw new WebhookVerificationError("stale_timestamp", "webhook timestamp outside replay window");
  }
}

/** @param {unknown} value */
function rawBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new WebhookVerificationError("missing_raw_body", "signed webhook raw body unavailable");
}

/** @param {string} left @param {string} right */
function safeEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {Buffer|string} rawBody */
function parseWebhookJson(rawBody) {
  const body = rawBuffer(rawBody);
  if (body.length === 0 || body.length > 256 * 1024) {
    throw new WebhookVerificationError("bad_body", "webhook body size invalid");
  }
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new WebhookVerificationError("bad_body", "webhook body is not valid JSON");
  }
}

/**
 * Map official Twitch EventSub notifications onto the existing ChatEvent
 * contract consumed by the Dock and alert widgets.
 */
/** @param {string} subscriptionType @param {any} payload @param {string} messageId */
function normalizeTwitchEvent(subscriptionType, payload, messageId) {
  const event = payload?.event;
  if (!event || typeof event !== "object") return null;
  const atMs = dateMs(
    event.followed_at || event.redeemed_at || event.resubbed_at || event.started_at,
  );
  if (subscriptionType === "channel.follow") {
    const user = userName(event);
    return {
      ...chatEvent("twitch", messageId, "follow", user, "followed on Twitch", undefined, atMs),
      updateKey: followCoalesceKey(user, atMs),
      updateVersion: 1,
    };
  }
  if (
    subscriptionType === "channel.channel_points_custom_reward_redemption.add"
  ) {
    const title = String(event.reward?.title || "Channel points reward").slice(0, 160);
    const input = String(event.user_input || "").trim().slice(0, 200);
    return chatEvent(
      "twitch",
      String(event.id || messageId),
      "reward",
      userName(event),
      input ? `redeemed ${title}: ${input}` : `redeemed ${title}`,
      event.reward?.cost ? `${event.reward.cost} points` : undefined,
      atMs,
    );
  }
  if (
    subscriptionType === "channel.channel_points_automatic_reward_redemption.add"
  ) {
    const title = humanize(String(event.reward?.type || "Channel points reward"));
    return chatEvent(
      "twitch",
      String(event.id || messageId),
      "reward",
      userName(event),
      `redeemed ${title}`,
      event.reward?.channel_points ? `${event.reward.channel_points} points` : undefined,
      atMs,
    );
  }
  if (subscriptionType === "channel.subscribe") {
    // Twitch emits this once per gifted recipient as well as emitting the
    // channel.subscription.gift summary. Surface only the summary for a gift
    // action or one N-pack would become N recipient alerts plus the summary.
    if (event.is_gift === true) return null;
    const user = userName(event);
    return withTransportDedupe(
      chatEvent("twitch", messageId, "sub", user, "subscribed on Twitch", event.tier ? `Tier ${event.tier}` : undefined, atMs),
      `support:sub:${actorKey(user)}`,
    );
  }
  if (subscriptionType === "channel.subscription.message") {
    const months = Number(event.cumulative_months) || 0;
    const user = userName(event);
    return withTransportDedupe(
      chatEvent("twitch", messageId, "resub", user, `resubscribed${months ? ` for ${months} months` : ""}`, undefined, atMs),
      `support:resub:${actorKey(user)}:${months}`,
    );
  }
  if (subscriptionType === "channel.subscription.gift") {
    const total = Math.max(1, Number(event.total) || 1);
    const user = event.is_anonymous ? "Anonymous" : userName(event);
    return withTransportDedupe(
      chatEvent("twitch", messageId, "giftsub", user, `gifted ${total} Twitch sub${total === 1 ? "" : "s"}`, String(total), atMs),
      `support:giftsub:${actorKey(user)}:${total}`,
    );
  }
  if (subscriptionType === "channel.cheer") {
    const bits = Math.max(0, Number(event.bits) || 0);
    const user = event.is_anonymous ? "Anonymous" : userName(event);
    return withTransportDedupe(
      chatEvent("twitch", messageId, "cheer", user, `cheered ${bits} bit${bits === 1 ? "" : "s"}`, String(bits), atMs),
      `support:cheer:${actorKey(user)}:${bits}:${shortHash(event.message?.text || event.message || "")}`,
    );
  }
  if (subscriptionType === "channel.raid") {
    const viewers = Math.max(0, Number(event.viewers) || 0);
    const user = String(event.from_broadcaster_user_name || "A channel");
    return withTransportDedupe(
      chatEvent("twitch", messageId, "raid", user, `raided with ${viewers} viewer${viewers === 1 ? "" : "s"}`, String(viewers), atMs),
      `support:raid:${actorKey(user)}:${viewers}`,
    );
  }
  return null;
}

/** @param {string} eventType @param {any} payload @param {string} messageId */
function normalizeKickEvent(eventType, payload, messageId) {
  const atMs = dateMs(payload?.created_at || payload?.redeemed_at);
  if (eventType === "channel.followed") {
    const user = kickUser(payload?.follower);
    return {
      ...chatEvent("kick", messageId, "follow", user, "followed on Kick", undefined, atMs),
      // Kick's public Pusher channel may also surface this follow with a
      // transport-specific id. A short semantic key lets the client coalesce
      // the official + public copies without suppressing a later refollow.
      updateKey: followCoalesceKey(user, atMs),
      updateVersion: 1,
    };
  }
  if (eventType === "channel.reward.redemption.updated") {
    const title = String(payload?.reward?.title || "Channel reward").slice(0, 160);
    const input = String(payload?.user_input || "").trim().slice(0, 200);
    const user = kickUser(payload?.redeemer);
    return withTransportDedupe(
      chatEvent(
        "kick",
        String(payload?.id || messageId),
        "reward",
        user,
        input ? `redeemed ${title}: ${input}` : `redeemed ${title}`,
        payload?.reward?.cost ? `${payload.reward.cost} points` : undefined,
        atMs,
      ),
      `support:reward:${actorKey(user)}:${shortHash(title)}`,
    );
  }
  if (eventType === "channel.subscription.new") {
    const user = kickUser(payload?.subscriber);
    return withTransportDedupe(
      chatEvent("kick", messageId, "sub", user, "subscribed on Kick", undefined, atMs),
      `support:sub:${actorKey(user)}`,
    );
  }
  if (eventType === "channel.subscription.renewal") {
    const months = Math.max(0, Number(payload?.duration) || 0);
    const user = kickUser(payload?.subscriber);
    return withTransportDedupe(
      chatEvent("kick", messageId, "resub", user, `renewed a Kick subscription${months ? ` (${months} months)` : ""}`, undefined, atMs),
      `support:resub:${actorKey(user)}:${months}`,
    );
  }
  if (eventType === "channel.subscription.gifts") {
    const total = Math.max(1, Array.isArray(payload?.giftees) ? payload.giftees.length : 1);
    const user = kickUser(payload?.gifter, "Anonymous");
    return withTransportDedupe(
      chatEvent("kick", messageId, "giftsub", user, `gifted ${total} Kick sub${total === 1 ? "" : "s"}`, String(total), atMs),
      `support:giftsub:${actorKey(user)}:${total}`,
    );
  }
  if (eventType === "kicks.gifted") {
    const amount = Math.max(0, Number(payload?.gift?.amount) || 0);
    const name = String(payload?.gift?.name || "KICKs").slice(0, 100);
    return chatEvent("kick", messageId, "gift", kickUser(payload?.sender), `sent ${name}`, `${amount} KICKs`, atMs);
  }
  return null;
}

/** @param {any} item */
function normalizeYoutubeSubscriber(item) {
  const id = String(item?.id || "");
  const user = String(
    item?.subscriberSnippet?.title || item?.snippet?.title || "YouTube subscriber",
  ).trim();
  const atMs = Date.parse(String(item?.snippet?.publishedAt || ""));
  if (!id || !user || !Number.isFinite(atMs)) return null;
  return chatEvent(
    "youtube",
    `subscriber:${id}`,
    "follow",
    user,
    "subscribed on YouTube",
    undefined,
    atMs,
  );
}

/**
 * @param {string} platform @param {unknown} id @param {string} kind
 * @param {unknown} user @param {unknown} detail @param {unknown} amount
 * @param {number} atMs
 */
function chatEvent(platform, id, kind, user, detail, amount, atMs) {
  return {
    platform,
    id: String(id).slice(0, 240),
    kind,
    user: String(user || "Viewer").slice(0, 120),
    detail: String(detail || "").slice(0, 300),
    ...(amount ? { amount: String(amount).slice(0, 100) } : {}),
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
    official: true,
  };
}

/** @param {Record<string, any>} event @param {string} dedupeKey */
function withTransportDedupe(event, dedupeKey) {
  return {
    ...event,
    dedupeKey: String(dedupeKey).slice(0, 240),
    dedupeWindowMs: 2 * 60 * 1000,
  };
}

/** @param {unknown} value */
function actorKey(value) {
  return String(value || "viewer").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 100);
}

/** FNV-1a keeps user-written cheer text out of persisted semantic keys. */
/** @param {unknown} value */
function shortHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value || "").trim().toLowerCase()) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** @param {any} event */
function userName(event) {
  return String(event?.user_name || event?.user_login || "Viewer");
}

/** @param {any} value @param {string} [fallback] */
function kickUser(value, fallback = "Viewer") {
  if (value?.is_anonymous === true) return fallback;
  return String(value?.username || value?.channel_slug || fallback);
}

/** @param {string} user @param {number} atMs */
function followCoalesceKey(user, atMs) {
  const window = Math.floor(atMs / (15 * 60 * 1000));
  return `follow:${String(user).trim().toLowerCase()}:${window}`.slice(0, 240);
}

/** @param {unknown} value */
function dateMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** @param {string} value */
function humanize(value) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  KICK_WEBHOOK_PUBLIC_KEY,
  WEBHOOK_MAX_AGE_MS,
  WebhookVerificationError,
  verifyTwitchWebhook,
  verifyKickWebhook,
  parseWebhookJson,
  normalizeTwitchEvent,
  normalizeKickEvent,
  normalizeYoutubeSubscriber,
};
