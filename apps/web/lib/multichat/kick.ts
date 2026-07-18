// Kick chat engine — Kick's public Pusher WebSocket, straight from the
// browser.
//
// Public Kick chatrooms are readable with NO auth: subscribe to
// `chatrooms.<id>.v2` on Kick's Pusher app and messages stream in.
// (Verified live: handshake + anonymous subscribe both succeed.) The
// only setup cost is knowing the numeric chatroom id — resolved once
// in Settings (auto via the API relay, or the guided manual flow when
// Cloudflare blocks the lookup).

import type { ChatEvent } from "./events";
import type { ChatBadge, ChatEngine, EngineCallbacks } from "./types";

// Kick's production Pusher app key + cluster — public constants baked
// into kick.com's own web bundle.
export const KICK_PUSHER_URL =
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export interface ParsedKickMessage {
  id: string;
  user: string;
  text: string;
  color?: string;
  badges: ChatBadge[];
  atMs: number;
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
 * Parse one Kick `ChatMessageEvent` payload (the `data` JSON of the
 * Pusher event) into a chat message. Pure, unit-tested.
 */
export function parseKickChatEvent(
  data: Record<string, unknown>,
): ParsedKickMessage | null {
  const sender = (data?.sender ?? {}) as Record<string, unknown>;
  const identity = (sender?.identity ?? {}) as Record<string, unknown>;
  const text = stripKickEmoteTags(String(data?.content ?? ""));
  if (!text) return null;
  const user = String(sender?.username || sender?.slug || "").trim();
  if (!user) return null;
  const created = Date.parse(String(data?.created_at ?? ""));
  const color = String(identity?.color ?? "");
  return {
    id: String(data?.id || `${Date.now()}-${user}`),
    user,
    text: text.slice(0, 500),
    color: /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : undefined,
    badges: kickBadgeTags(
      identity?.badges as Array<{ type?: string }> | undefined,
    ),
    atMs: Number.isFinite(created) ? created : Date.now(),
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
  const short = eventName.startsWith("App\\Events\\")
    ? eventName.slice("App\\Events\\".length)
    : eventName;

  let kind: ChatEvent["kind"];
  let user: string;
  let detail: string;
  let amount: string | undefined;
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
      break;
    }
    case "GiftedSubscriptionsEvent": {
      kind = "giftsub";
      user = String(data?.gifter_username || "").trim();
      const gifted = data?.gifted_usernames;
      const count = Array.isArray(gifted) ? gifted.length || 1 : 1;
      amount = String(count);
      detail = `gifted ${count} ${count === 1 ? "sub" : "subs"}`;
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
    default:
      return null;
  }
  if (!user) return null;

  const created = Date.parse(String(data?.created_at ?? ""));
  return {
    platform: "kick",
    id: String(data?.id || `${eventName}-${Date.now()}-${user}`),
    kind,
    user,
    detail,
    amount,
    atMs: Number.isFinite(created) ? created : Date.now(),
  };
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
          // Any other App\Events\* frame is a candidate platform event
          // (subs, gifted subs, hosts) — parse defensively, drop the rest.
          if (!String(frame.event || "").startsWith("App\\Events\\")) break;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(String(frame.data || "{}"));
          } catch {
            return;
          }
          const event = parseKickEvent(String(frame.event), payload);
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
