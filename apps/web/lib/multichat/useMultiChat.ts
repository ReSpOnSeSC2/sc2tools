"use client";

// useMultiChat — wires the four platform engines to one merged feed.
//
// Engines push into a ref'd buffer; a 250 ms flush interval batches
// them into React state so a busy chat (Twitch raids…) doesn't
// re-render the OBS source per message. Statuses update immediately —
// they're low-frequency and the setup screen wants them live.

import { useEffect, useRef, useState } from "react";
import { appendMessages, FEED_CAP } from "./feed";
import { createKickChat } from "./kick";
import { createTikTokChat } from "./tiktok";
import { createTwitchChat } from "./twitch";
import { createYoutubeChat } from "./youtube";
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
  const [statuses, setStatuses] = useState<MultiChatState["statuses"]>({});
  const [active, setActive] = useState(false);
  const bufferRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    if (!config) return;
    const engines: ChatEngine[] = [];
    const onMessage = (m: ChatMessage) => {
      bufferRef.current.push(m);
    };
    const statusFor =
      (platform: ChatPlatform) => (state: PlatformState, detail?: string) => {
        setStatuses((prev) => ({ ...prev, [platform]: { state, detail } }));
      };

    if (config.twitch?.enabled && config.twitch.channel) {
      engines.push(
        createTwitchChat({
          channel: config.twitch.channel,
          callbacks: { onMessage, onStatus: statusFor("twitch") },
        }),
      );
    }
    if (config.kick?.enabled && config.kick.chatroomId) {
      engines.push(
        createKickChat({
          chatroomId: config.kick.chatroomId,
          callbacks: { onMessage, onStatus: statusFor("kick") },
        }),
      );
    }
    if (config.youtube?.enabled && config.youtube.channel) {
      engines.push(
        createYoutubeChat({
          apiBase,
          token,
          channel: config.youtube.channel,
          callbacks: { onMessage, onStatus: statusFor("youtube") },
        }),
      );
    }
    if (config.tiktok?.enabled && config.tiktok.username) {
      engines.push(
        createTikTokChat({
          apiBase,
          token,
          username: config.tiktok.username,
          callbacks: { onMessage, onStatus: statusFor("tiktok") },
        }),
      );
    }
    setActive(engines.length > 0);

    const flush = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const batch = bufferRef.current;
      bufferRef.current = [];
      setMessages((prev) => appendMessages(prev, batch, FEED_CAP));
    }, FLUSH_INTERVAL_MS);

    return () => {
      clearInterval(flush);
      for (const engine of engines) engine.close();
      bufferRef.current = [];
      setStatuses({});
    };
  }, [apiBase, token, config]);

  return { messages, statuses, active };
}
