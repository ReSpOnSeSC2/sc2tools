"use client";

// useEngagementReporter — every open multichat surface (widgets, the
// dock) reports the chat lines and platform events it sees to the
// engagement API in small batches. The server's unique
// (token, platform, msgId) index makes duplicate reports from
// multiple Browser Sources a no-op, so coverage holds whichever
// subset of sources is open — no leader election needed.
//
// Powers: loyalty XP + supporter wall, Crystal Ball !win/!loss
// picks, and chat-spike clip detection. Batches flush every 10 s
// (draining faster during bursts), fire-and-forget: a batch lost to
// a transient error is not re-queued — with several surfaces
// reporting and the server deduping, the cost is a few XP ticks,
// which isn't worth retry complexity inside OBS.

import { useEffect, useRef } from "react";
import { API_BASE } from "@/lib/clientApi";
import type { ChatMessage } from "./types";
import type { ChatEvent } from "./events";

const FLUSH_MS = 10_000;
const FLUSH_AT = 80;
const SEEN_CAP = 4000;

interface WireEvent {
  platform: string;
  id: string;
  user: string;
  text?: string;
  kind?: string;
  atMs: number;
}

export function useEngagementReporter(
  token: string,
  messages: ReadonlyArray<ChatMessage>,
  events: ReadonlyArray<ChatEvent>,
): void {
  const seenRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<WireEvent[]>([]);
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    const seen = seenRef.current;
    const pending = pendingRef.current;
    for (const m of messages) {
      const key = `m:${m.platform}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The backlog visible at mount predates this reporter — other
      // sources already reported it (or it predates the stream).
      if (m.atMs < mountedAtRef.current - 5_000) continue;
      pending.push({
        platform: m.platform,
        id: m.id,
        user: m.user,
        text: m.text.slice(0, 200),
        atMs: m.atMs,
      });
    }
    for (const e of events) {
      const key = `e:${e.platform}:${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.atMs < mountedAtRef.current - 5_000) continue;
      pending.push({
        platform: e.platform,
        id: `ev:${e.id}`,
        user: e.user,
        kind: e.kind,
        atMs: e.atMs,
      });
    }
    if (seen.size > SEEN_CAP) {
      seenRef.current = new Set([...seen].slice(-SEEN_CAP / 2));
    }
  }, [messages, events]);

  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      const batch = pending.splice(0, 100);
      try {
        await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/engage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
            cache: "no-store",
            keepalive: true,
          },
        );
      } catch {
        /* transient — the server dedupes, losing a batch is benign */
      }
      // Oversized backlog (burst) — drain faster than the timer.
      if (!cancelled && pendingRef.current.length >= FLUSH_AT) void flush();
    };
    const timer = setInterval(() => void flush(), FLUSH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      void flush();
    };
  }, [token]);
}
