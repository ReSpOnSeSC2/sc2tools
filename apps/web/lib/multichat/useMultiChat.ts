"use client";

// useMultiChat — wires the four platform engines to one merged feed.
//
// Engines push into a ref'd buffer; a 250 ms flush interval batches
// them into React state so a busy chat (Twitch raids…) doesn't
// re-render the OBS source per message. Statuses update immediately —
// they're low-frequency and the setup screen wants them live.

import { useEffect, useRef, useState } from "react";
import { appendEvents, EVENT_CAP, type ChatEvent } from "./events";
import { appendMessages, FEED_CAP } from "./feed";
import { createKickChat } from "./kick";
import { createTikTokChat } from "./tiktok";
import { createTwitchChat } from "./twitch";
import { createYoutubeChat } from "./youtube";
import { createOfficialPlatformEvents } from "./official";
import type {
  ChatEngine,
  ChatMessage,
  ChatPlatform,
  MultichatConfig,
  PlatformState,
} from "./types";

const FLUSH_INTERVAL_MS = 250;

export interface MultiChatState {
  messages: ChatMessage[];
  /** Platform events (subs, raids, gifts…) — capped, deduped, in arrival order. */
  events: ChatEvent[];
  statuses: Partial<Record<ChatPlatform, { state: PlatformState; detail?: string }>>;
  /** True when at least one platform is enabled + configured. */
  active: boolean;
}

export function useMultiChat(args: {
  apiBase: string;
  token: string;
  config: MultichatConfig | null;
}): MultiChatState {
  const { apiBase, token, config } = args;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [statuses, setStatuses] = useState<MultiChatState["statuses"]>({});
  const [active, setActive] = useState(false);
  const bufferRef = useRef<ChatMessage[]>([]);
  const eventBufferRef = useRef<ChatEvent[]>([]);

  useEffect(() => {
    if (!config && !token) {
      setActive(false);
      return;
    }
    const engines: ChatEngine[] = [];
    const onMessage = (m: ChatMessage) => {
      bufferRef.current.push(m);
    };
    const onEvent = (e: ChatEvent) => {
      eventBufferRef.current.push(e);
    };
    const statusFor =
      (platform: ChatPlatform) => (state: PlatformState, detail?: string) => {
        setStatuses((prev) => ({ ...prev, [platform]: { state, detail } }));
      };

    if (config?.twitch?.enabled && config.twitch.channel) {
      engines.push(
        createTwitchChat({
          channel: config.twitch.channel,
          callbacks: { onMessage, onEvent, onStatus: statusFor("twitch") },
        }),
      );
    }
    if (config?.kick?.enabled && config.kick.chatroomId) {
      engines.push(
        createKickChat({
          chatroomId: config.kick.chatroomId,
          callbacks: { onMessage, onEvent, onStatus: statusFor("kick") },
        }),
      );
    }
    if (config?.youtube?.enabled && config.youtube.channel) {
      engines.push(
        createYoutubeChat({
          apiBase,
          token,
          channel: config.youtube.channel,
          callbacks: { onMessage, onEvent, onStatus: statusFor("youtube") },
        }),
      );
    }
    if (config?.tiktok?.enabled && config.tiktok.username) {
      engines.push(
        createTikTokChat({
          apiBase,
          token,
          username: config.tiktok.username,
          callbacks: { onMessage, onEvent, onStatus: statusFor("tiktok") },
        }),
      );
    }
    // Official connections fill gaps the public chat transports cannot expose
    // (Twitch/Kick follows + rewards, public YouTube subscribers). Keep this
    // separate from platform status dots so one shared socket cannot mask a
    // direct chat outage.
    const chatEngineCount = engines.length;
    if (token) {
      engines.push(createOfficialPlatformEvents({ apiBase, token, onEvent }));
    }
    setActive(chatEngineCount > 0);

    const flush = setInterval(() => {
      if (bufferRef.current.length > 0) {
        const batch = bufferRef.current;
        bufferRef.current = [];
        setMessages((prev) => appendMessages(prev, batch, FEED_CAP));
      }
      if (eventBufferRef.current.length > 0) {
        const batch = eventBufferRef.current;
        eventBufferRef.current = [];
        setEvents((prev) => appendEvents(prev, batch, EVENT_CAP));
      }
    }, FLUSH_INTERVAL_MS);

    return () => {
      clearInterval(flush);
      for (const engine of engines) engine.close();
      bufferRef.current = [];
      eventBufferRef.current = [];
      setStatuses({});
    };
  }, [apiBase, token, config]);

  return { messages, events, statuses, active };
}
