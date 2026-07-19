"use client";

// useTickerFacts — the stats-ticker's career-stats + trivia pool,
// computed server-side from the streamer's real games history
// (GET /v1/multichat/:token/ticker-facts). The server caches the
// heavy compute per user; this hook just refetches slowly so a
// long-running Browser Source picks up fresh facts as games land.

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";

const REFRESH_MS = 5 * 60_000;
const MAX_FACTS = 60;
const MAX_TEXT = 200;

export interface TickerFact {
  id: string;
  text: string;
}

export function sanitizeTickerFacts(raw: unknown): TickerFact[] {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { facts?: unknown }).facts)
      ? ((raw as { facts: unknown[] }).facts as unknown[])
      : [];
  const out: TickerFact[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id.slice(0, 60) : "";
    const text = typeof f.text === "string" ? f.text.slice(0, MAX_TEXT) : "";
    if (!id || !text) continue;
    out.push({ id, text });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

export function useTickerFacts(token: string): TickerFact[] {
  const [facts, setFacts] = useState<TickerFact[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/ticker-facts`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (cancelled) return;
        setFacts(sanitizeTickerFacts(body));
      } catch {
        /* transient — the next slow tick retries */
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  return facts;
}
