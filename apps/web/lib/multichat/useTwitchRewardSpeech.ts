"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import type { ChatMessage } from "./types";

export function useTwitchRewardSpeech(socketRef: RefObject<Socket | null> | undefined, ready: () => boolean, speak: (message: ChatMessage) => boolean, blocked: ReadonlySet<string>) {
  const handler = useRef({ ready, speak, blocked });
  handler.current = { ready, speak, blocked };
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket) return;
    const onReady = (reply: unknown) => { if (typeof reply === "function") reply(handler.current.ready()); };
    const onSpeech = (payload: unknown, reply: unknown) => {
      if (typeof reply !== "function") return;
      if (!payload || typeof payload !== "object") { reply(false); return; }
      const { id, name, text } = payload as Record<string, unknown>;
      if (typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(id) || typeof name !== "string" || !name || name.length > 120
        || typeof text !== "string" || !text || text.length > 400 || /[\p{Cc}\p{Cf}]/u.test(text)
        || handler.current.blocked.has(name.trim().toLowerCase().replace(/^@+/, ""))) { reply(false); return; }
      reply(handler.current.ready() && handler.current.speak({ id: `reward:${id}`, user: name, platform: "twitch", text, badges: [], atMs: Date.now() }));
    };
    socket.on("overlay:rewardSpeechReady", onReady);
    socket.on("overlay:rewardSpeech", onSpeech);
    return () => { socket.off("overlay:rewardSpeechReady", onReady); socket.off("overlay:rewardSpeech", onSpeech); };
  }, [socketRef]);
}
