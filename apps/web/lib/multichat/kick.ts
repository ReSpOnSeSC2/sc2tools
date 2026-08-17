// Kick chat engine — Kick's public Pusher WebSocket, straight from the
// browser.
//
// Public Kick chatrooms are readable with NO auth: subscribe to
// `chatrooms.<id>.v2` on Kick's Pusher app and messages stream in.
// (Verified live: handshake + anonymous subscribe both succeed.) The
// only setup cost is knowing the numeric chatroom id — resolved once
// in Settings (auto via the API relay, or the guided manual flow when
// Cloudflare blocks the lookup).

import { kickEmoteUrl, type ChatEmote } from "./emotes";
import type { ChatEvent } from "./events";
import type { ChatBadge, ChatEngine, EngineCallbacks } from "./types";

// Kick's production Pusher app key + cluster — public constants baked
// into kick.com's own web bundle.
export const KICK_PUSHER_URL =
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KICK_EVENT_PREFIX = "App\\Events\\";
const KICK_LITERAL_EVENT_NAMES = new Set([
  "channel.followed",
  "channel.reward.redemption.updated",
]);

let fallbackEventSequence = 0;

export interface ParsedKickMessage {
  id: string;
  user: string;
  text: string;
  color?: string;
  badges: ChatBadge[];
  atMs: number;
  /** Emotes present in `text` — only set when the message carries any. */
  emotes?: ChatEmote[];
}

/** Map Kick identity badges to normalised tags. */
export function kickBadgeTags(
  badges: Array<{ type?: string }> | undefined,
): ChatBadge[] {
  if (!Array.isArray(badges)) return [];
  const out: ChatBadge[] = [];
  for (const b of badges) {
    const type = String(b?.type || "");
    if (type === "broadcaster") out.push("owner");
    else if (type === "moderator") out.push("moderator");
    else if (type === "subscriber" || type === "founder" || type === "og") {
      out.push("member");
    } else if (type === "vip") out.push("vip");
    else if (type === "verified") out.push("verified");
  }
  return [...new Set(out)];
}

/** Render Kick emote markup `[emote:123:name]` as `:name:` text. */
export function stripKickEmoteTags(content: string): string {
  return content
    .replace(/\[emote:\d+:([^\]]*)\]/g, (_, name) => (name ? `:${name}:` : ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Collect the emotes referenced by `[emote:id:name]` markup. The code
 * mirrors what stripKickEmoteTags leaves in the text (`:name:`) so the
 * renderer can swap occurrences back to images; codes dedupe.
 */
export function collectKickEmotes(content: string): ChatEmote[] {
  const out: ChatEmote[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(/\[emote:(\d+):([^\]]*)\]/g)) {
    const [, id, name] = m;
    if (!name) continue;
    const code = `:${name}:`;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, url: kickEmoteUrl(id) });
  }
  return out;
}

/**
 * Parse one Kick `ChatMessageEvent` payload (the `data` JSON of the
 * Pusher event) into a chat message. Pure, unit-tested.
 */
export function parseKickChatEvent(
  data: Record<string, unknown>,
): ParsedKickMessage | null {
  const sender = (data?.sender ?? {}) as Record<string, unknown>;
  const identity = (sender?.identity ?? {}) as Record<string, unknown>;
  const content = String(data?.content ?? "");
  const text = stripKickEmoteTags(content);
  if (!text) return null;
  const user = String(sender?.username || sender?.slug || "").trim();
  if (!user) return null;
  const created = Date.parse(String(data?.created_at ?? ""));
  const color = String(identity?.color ?? "");
  const emotes = collectKickEmotes(content);
  return {
    id: String(data?.id || `${Date.now()}-${user}`),
    user,
    text: text.slice(0, 500),
    color: /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : undefined,
    badges: kickBadgeTags(
      identity?.badges as Array<{ type?: string }> | undefined,
    ),
    atMs: Number.isFinite(created) ? created : Date.now(),
    // Omitted (not []) when absent — keeps emote-less parses toEqual
    // their pre-emote shape.
    ...(emotes.length > 0 ? { emotes } : {}),
  };
}

/**
 * Parse one non-chat Pusher event from the chatroom channel into a
 * platform event, or null for events we don't surface. Payload shapes
 * follow what the public channel delivers (observed live), but every
 * field is treated as optional — Kick renames things without notice.
 */
export function parseKickEvent(
  eventName: string,
  data: Record<string, unknown>,
): ChatEvent | null {
  const short = eventName.startsWith(KICK_EVENT_PREFIX)
    ? eventName.slice(KICK_EVENT_PREFIX.length)
    : eventName;

  let kind: ChatEvent["kind"];
  let user: string;
  let detail: string;
  let amount: string | undefined;
  let dedupeKey: string | undefined;
  switch (short) {
    case "SubscriptionEvent": {
      user = String(data?.username || "").trim();
      const months = Number(data?.months);
      if (Number.isFinite(months) && months > 1) {
        kind = "resub";
        detail = `subscribed for ${months} months`;
      } else {
        kind = "sub";
        detail = "subscribed";
      }
      dedupeKey = kind === "resub"
        ? `support:resub:${kickSupportActorKey(user)}:${Number.isFinite(months) ? months : 0}`
        : `support:sub:${kickSupportActorKey(user)}`;
      break;
    }
    case "GiftedSubscriptionsEvent": {
      kind = "giftsub";
      user = String(data?.gifter_username || "").trim();
      const gifted = data?.gifted_usernames;
      const count = Array.isArray(gifted) ? gifted.length || 1 : 1;
      amount = String(count);
      detail = `gifted ${count} ${count === 1 ? "sub" : "subs"}`;
      dedupeKey = `support:giftsub:${kickSupportActorKey(user)}:${count}`;
      break;
    }
    case "StreamHostEvent": {
      kind = "raid";
      user = String(data?.host_username || "").trim();
      const viewers = Number(data?.number_viewers) || 0;
      amount = String(viewers);
      detail = `raiding with ${viewers} viewers`;
      break;
    }
    case "FollowerEvent":
    case "FollowedEvent":
    case "ChannelFollowedEvent":
    case "channel.followed": {
      kind = "follow";
      const follower = (data?.follower ?? {}) as Record<string, unknown>;
      user = String(
        follower?.username || data?.username || data?.follower_username || "",
      ).trim();
      detail = "followed";
      break;
    }
    case "RewardRedeemedEvent":
    case "ChannelRewardRedemptionEvent":
    case "channel.reward.redemption.updated": {
      kind = "reward";
      const redeemer = (data?.user ?? data?.redeemer ?? {}) as Record<
        string,
        unknown
      >;
      const reward = (data?.reward ?? {}) as Record<string, unknown>;
      user = String(
        redeemer?.username || data?.username || data?.user_username || "",
      ).trim();
      const title = String(
        reward?.title || data?.reward_title || "Channel reward",
      ).trim();
      detail = `redeemed ${title}`;
      dedupeKey = `support:reward:${kickSupportActorKey(user)}:${kickSupportShortHash(title)}`;
      break;
    }
    default:
      return null;
  }
  if (!user) return null;

  const created = Date.parse(String(data?.created_at ?? ""));
  const receivedAt = Date.now();
  const transportId = data?.id || data?.event_id;
  const atMs = Number.isFinite(created) ? created : receivedAt;
  const parsed: ChatEvent = {
    platform: "kick",
    id: transportId
      ? String(transportId)
      : Number.isFinite(created)
        ? `${short}:${created}:${user}`
        : nextFallbackEventId(short, user, receivedAt),
    kind,
    user,
    detail,
    amount,
    atMs,
    ...(dedupeKey ? { dedupeKey, dedupeWindowMs: 2 * 60 * 1000 } : {}),
  };
  if (kind === "follow") {
    parsed.updateKey = kickFollowCoalesceKey(user, atMs);
    parsed.updateVersion = 1;
  }
  return parsed;
}

function kickFollowCoalesceKey(user: string, atMs: number): string {
  const window = Math.floor(atMs / (15 * 60 * 1000));
  return `follow:${user.trim().toLowerCase()}:${window}`.slice(0, 240);
}

function kickSupportActorKey(value: unknown): string {
  return String(value || "viewer").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 100);
}

function kickSupportShortHash(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of String(value || "").trim().toLowerCase()) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function createKickChat(
  opts: { chatroomId: number; callbacks: EngineCallbacks; url?: string },
): ChatEngine {
  const { callbacks } = opts;
  if (!Number.isInteger(opts.chatroomId) || opts.chatroomId <= 0) {
    callbacks.onStatus("error", "missing chatroom id");
    return { close: () => undefined };
  }

  let closed = false;
  let ws: WebSocket | null = null;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    callbacks.onStatus("connecting");
    ws = new WebSocket(opts.url || KICK_PUSHER_URL);
    ws.onmessage = (event) => {
      let frame: { event?: string; data?: string };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (frame.event) {
        case "pusher:connection_established":
          ws?.send(
            JSON.stringify({
              event: "pusher:subscribe",
              data: { auth: "", channel: `chatrooms.${opts.chatroomId}.v2` },
            }),
          );
          break;
        case "pusher_internal:subscription_succeeded":
          attempts = 0;
          callbacks.onStatus("connected");
          break;
        case "pusher:ping":
          ws?.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          break;
        case "App\\Events\\ChatMessageEvent": {
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(String(frame.data || "{}"));
          } catch {
            return;
          }
          const parsed = parseKickChatEvent(payload);
          if (parsed) callbacks.onMessage({ platform: "kick", ...parsed });
          break;
        }
        default: {
          // Kick sends most platform events under App\Events\*, while its
          // documented follow/reward events use literal dotted names.
          // Admit both forms, then let the defensive parser drop unknowns.
          const eventName = String(frame.event || "");
          if (
            !eventName.startsWith(KICK_EVENT_PREFIX)
            && !KICK_LITERAL_EVENT_NAMES.has(eventName)
          ) break;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(String(frame.data || "{}"));
          } catch {
            return;
          }
          const event = parseKickEvent(eventName, payload);
          if (event) callbacks.onEvent?.(event);
          break;
        }
      }
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      callbacks.onStatus("connecting", "reconnecting");
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** Math.min(attempts, 5),
      );
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {
        /* already down */
      }
    },
  };
}

function nextFallbackEventId(
  shortName: string,
  user: string,
  receivedAt: number,
): string {
  // With neither a transport id nor a source timestamp, a deterministic id
  // would suppress every later event of the same kind from this user. Pair a
  // receipt timestamp with a process-local sequence so even same-tick frames
  // remain distinct. Stable transport/timestamp identities above still dedupe.
  fallbackEventSequence += 1;
  return `${shortName}:received:${receivedAt}:${fallbackEventSequence}:${user}`;
}
