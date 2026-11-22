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
const STATUS_TIMEOUT_MS = 40_000;
const RELAY_RETRY_MS = 20_000;

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
    receivedAtMs?: number;
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
    `${apiBase.replace(/\/$/, "")}/v1/multichat/${encodeURIComponent(token)}` +
    `/tiktok/stream?username=${encodeURIComponent(username)}`;
  const seenChatIds = new Set<string>();
  let lastState: PlatformState = "connecting";
  let source: EventSource;
  let closed = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function stopWaiting() {
    clearTimeout(statusTimer);
    statusTimer = undefined;
  }

  function report(state: PlatformState, detail?: string) {
    lastState = state;
    if (state !== "connecting") stopWaiting();
    callbacks.onStatus(state, detail);
  }

  function waitForStatus() {
    if (statusTimer !== undefined) return;
    statusTimer = setTimeout(() => {
      if (lastState !== "error") report("error", "TikTok chat relay did not respond");
      scheduleRetry();
    }, STATUS_TIMEOUT_MS);
  }

  function scheduleRetry() {
    stopWaiting();
    retryTimer ??= setTimeout(() => {
      retryTimer = undefined;
      source.close();
      open();
    }, RELAY_RETRY_MS);
  }

  function onMessage(event: MessageEvent) {
    let data: RelayEvent;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (data.type === "status") {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      const state = RELAY_STATES.includes(data.state as PlatformState)
        ? (data.state as PlatformState)
        : "error";
      report(state, data.detail);
      if (state === "connecting") waitForStatus();
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
      const receivedAtMs = Number(e.receivedAtMs);
      // Unknown kinds (a newer relay) are skipped, not guessed at.
      if (!isChatEventKind(e.kind)) return;
      const sourceId = String(e.id);
      const session = String(data.session || "").trim();
      callbacks.onEvent?.({
        platform: "tiktok",
        // Connector ids may be reused in a later broadcast. Match chat's
        // room-scoped identity so a loyal supporter is never deduped away.
        id: session ? `${session}:${sourceId}` : sourceId,
        kind: e.kind,
        user: String(e.user || "viewer"),
        detail: String(e.detail || ""),
        amount: e.amount != null ? String(e.amount) : undefined,
        atMs: Number.isFinite(e.atMs) ? e.atMs : Date.now(),
        ...(Number.isFinite(receivedAtMs) && receivedAtMs > 0
          ? { receivedAtMs: Math.trunc(receivedAtMs) }
          : {}),
        ...(data.replay === true ? { replayed: true } : {}),
      });
    }
  }

  function open() {
    const nextSource = source = new EventSource(url);
    nextSource.onmessage = (event) => {
      if (!closed && source === nextSource) onMessage(event);
    };
    nextSource.onerror = () => {
      if (closed || source !== nextSource) return;
      // EventSource retries ordinary network gaps, but stops after a failed
      // HTTP handshake. Keep the latest relay error until a new status arrives.
      if (nextSource.readyState === EventSource.CLOSED) {
        if (lastState !== "error") report("error", "TikTok chat relay unavailable");
        scheduleRetry();
      } else if (lastState !== "error") {
        report("connecting", "relay reconnecting");
        waitForStatus();
      }
    };
    waitForStatus();
  }

  open();

  return {
    close: () => {
      closed = true;
      stopWaiting();
      clearTimeout(retryTimer);
      source.close();
    },
  };
}
