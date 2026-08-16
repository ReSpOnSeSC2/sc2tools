// TikTok chat engine — consumes the API's SSE relay.
//
// The server holds the actual TikTok connection (the webcast socket
// needs signed URLs a browser can't produce). Reading chat requires
// only the streamer's @username — no stream key, no TikTok login —
// and when the streamer isn't live the relay keeps retrying quietly,
// so the widget can sit in an OBS scene all day and light up when the
// TikTok stream starts. EventSource reconnects automatically.

import { isChatEventKind } from "./events";
import type { ChatBadge, ChatEngine, EngineCallbacks, PlatformState } from "./types";

/** Keep replayed SSE frames from resurfacing after an EventSource reconnect. */
const SEEN_CHAT_IDS_CAP = 512;

const RELAY_STATES: readonly PlatformState[] = [
  "connecting",
  "connected",
  "offline",
  "ended",
  "error",
];

interface RelayEvent {
  type: "status" | "chat" | "event";
  state?: string;
  detail?: string;
  session?: string;
  replay?: boolean;
  message?: {
    id: string;
    user: string;
    text: string;
    badges?: string[];
    atMs: number;
  };
  event?: {
    id: string;
    kind: string;
    user: string;
    detail: string;
    amount?: string;
    atMs: number;
  };
}

export function createTikTokChat(
  opts: {
    apiBase: string;
    token: string;
    username: string;
    callbacks: EngineCallbacks;
  },
): ChatEngine {
  const { apiBase, token, username, callbacks } = opts;
  callbacks.onStatus("connecting");
  const url =
    `${apiBase}/v1/multichat/${encodeURIComponent(token)}` +
    `/tiktok/stream?username=${encodeURIComponent(username)}`;
  const source = new EventSource(url);
  const seenChatIds = new Set<string>();

  source.onmessage = (event) => {
    let data: RelayEvent;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (data.type === "status") {
      const state = RELAY_STATES.includes(data.state as PlatformState)
        ? (data.state as PlatformState)
        : "error";
      callbacks.onStatus(state, data.detail);
      return;
    }
    if (data.type === "chat" && data.message) {
      const m = data.message;
      const sourceId = String(m.id);
      const session = String(data.session || "").trim();
      // TikTok message ids are scoped to a broadcast room. Including
      // the room keeps reconnect duplicates out while allowing a new
      // broadcast to reuse a connector id in the same open widget.
      const id = session ? `${session}:${sourceId}` : sourceId;
      if (seenChatIds.has(id)) return;
      seenChatIds.add(id);
      if (seenChatIds.size > SEEN_CHAT_IDS_CAP) {
        const oldest = seenChatIds.values().next().value;
        if (oldest !== undefined) seenChatIds.delete(oldest);
      }
      callbacks.onMessage({
        platform: "tiktok",
        id,
        user: m.user,
        text: m.text,
        badges: (m.badges || []).filter((b): b is ChatBadge =>
          ["owner", "moderator", "member", "verified", "vip"].includes(b),
        ),
        atMs: m.atMs,
        ...(data.replay === true ? { backlog: true } : {}),
      });
      return;
    }
    if (data.type === "event" && data.event) {
      const e = data.event;
      // Unknown kinds (a newer relay) are skipped, not guessed at.
      if (!isChatEventKind(e.kind)) return;
      callbacks.onEvent?.({
        platform: "tiktok",
        id: String(e.id),
        kind: e.kind,
        user: String(e.user || "viewer"),
        detail: String(e.detail || ""),
        amount: e.amount != null ? String(e.amount) : undefined,
        atMs: Number.isFinite(e.atMs) ? e.atMs : Date.now(),
      });
    }
  };

  // EventSource retries on its own; report the gap so the status dot
  // is honest while it does.
  source.onerror = () => {
    callbacks.onStatus("connecting", "relay reconnecting");
  };

  return {
    close: () => {
      source.close();
    },
  };
}
