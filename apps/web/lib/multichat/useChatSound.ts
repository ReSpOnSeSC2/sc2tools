"use client";

// useChatSound — plays the message ding for newly-arrived chat lines.
// Same arrival semantics as useChatTts: messages are marked as seen
// even while the sound is disabled (so flipping it on mid-session
// doesn't ding for the on-screen backlog), and only lines arriving
// after mount ring.

import { useEffect, useMemo, useRef } from "react";
import { API_BASE } from "@/lib/clientApi";
import {
  createDinger,
  sanitizeSoundConfig,
  type ChatDinger,
  type ChatSoundConfig,
} from "./sound";
import type { ChatMessage } from "./types";

const SEEN_IDS_CAP = 2000;

export function useChatSound(
  messages: ReadonlyArray<ChatMessage>,
  rawConfig: unknown,
): void {
  const config: ChatSoundConfig = useMemo(
    () => sanitizeSoundConfig(rawConfig),
    [rawConfig],
  );
  const dingerRef = useRef<ChatDinger | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!config.enabled) {
      dingerRef.current?.close();
      dingerRef.current = null;
      return;
    }
    const dinger = createDinger(config, API_BASE);
    dingerRef.current = dinger;
    return () => {
      dinger.close();
      if (dingerRef.current === dinger) dingerRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const dinger = dingerRef.current;
    let fresh = false;
    for (const m of messages) {
      const key = `${m.platform}:${m.id}`;
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      if (
        !config.enabled ||
        m.backlog ||
        m.atMs < mountedAtRef.current - 2000
      ) {
        continue;
      }
      fresh = true;
    }
    if (fresh && dinger) dinger.ping();
    if (seenRef.current.size > SEEN_IDS_CAP) {
      seenRef.current = new Set(messages.map((m) => `${m.platform}:${m.id}`));
    }
  }, [messages, config.enabled]);
}
