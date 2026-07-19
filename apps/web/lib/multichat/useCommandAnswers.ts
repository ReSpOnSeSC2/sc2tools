"use client";

// useCommandAnswers — answers SC2 chat commands ON STREAM. When any
// connected chat says !opponent / !mmr / !build, the widget fetches
// the same token-keyed chatbot line Nightbot would (/v1/chatbot/…)
// and shows it as an answer card. This gives Kick/YouTube/TikTok
// viewers the bot experience without the streamer wiring a bot into
// each platform — the overlay itself answers.
//
// Throttled per command (a spammed !mmr answers once), bounded to the
// commands the cloud actually serves, and cleared automatically.

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./types";

const COMMANDS = ["opponent", "mmr", "build"] as const;
export type ChatCommand = (typeof COMMANDS)[number];

/** Minimum gap between answers for the SAME command. */
export const COMMAND_THROTTLE_MS = 15_000;
/** How long an answer card stays up. */
export const ANSWER_TTL_MS = 12_000;

export interface CommandAnswer {
  command: ChatCommand;
  /** Who asked (first asker in the window). */
  user: string;
  text: string;
  atMs: number;
}

export function useCommandAnswers(
  messages: ReadonlyArray<ChatMessage>,
  args: { apiBase: string; token: string; enabled: boolean },
): CommandAnswer | null {
  const { apiBase, token, enabled } = args;
  const [answer, setAnswer] = useState<CommandAnswer | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const lastFiredRef = useRef<Record<string, number>>({});
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    for (const m of messages) {
      const key = `${m.platform}:${m.id}`;
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      if (!enabled || m.atMs < mountedAtRef.current - 2000) continue;
      const match = m.text.trim().match(/^!(opponent|mmr|build)\b/i);
      if (!match) continue;
      const command = match[1].toLowerCase() as ChatCommand;
      const now = Date.now();
      if (now - (lastFiredRef.current[command] ?? 0) < COMMAND_THROTTLE_MS) {
        continue;
      }
      lastFiredRef.current[command] = now;
      void (async () => {
        try {
          const res = await fetch(
            `${apiBase}/v1/chatbot/${encodeURIComponent(token)}/${command}`,
            { cache: "no-store" },
          );
          if (!res.ok) return;
          const text = (await res.text()).trim();
          if (!text) return;
          setAnswer({ command, user: m.user, text, atMs: Date.now() });
        } catch {
          /* transient — the next command retries */
        }
      })();
    }
    if (seenRef.current.size > 2000) {
      seenRef.current = new Set(messages.map((x) => `${x.platform}:${x.id}`));
    }
  }, [messages, enabled, apiBase, token]);

  // Auto-expire the card.
  useEffect(() => {
    if (!answer) return;
    const t = setTimeout(() => setAnswer(null), ANSWER_TTL_MS);
    return () => clearTimeout(t);
  }, [answer]);

  return answer;
}
