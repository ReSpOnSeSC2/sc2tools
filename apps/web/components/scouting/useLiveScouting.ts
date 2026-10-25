"use client";
import { useEffect, useRef, useState } from "react";
import { useLiveGame } from "@/lib/useLiveGame";
import { liveScoutingActive } from "@/lib/liveScouting";

/** One SSE subscription; freshness uses the cloud's receipt time on cached reads. */
export function useLiveScouting() {
  const state = useLiveGame(), [now, setNow] = useState(() => Date.now());
  const identity = `${state.live?.gameKey || ""}:${state.live?.opponent?.name || ""}`;
  const first = useRef({ identity, at: Date.now() });
  if (first.current.identity !== identity) first.current = { identity, at: Date.now() };
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const received = state.live?.receivedAt;
  const last = typeof received === "number" && Number.isFinite(received) ? Math.min(received, state.lastUpdatedAt ?? received) : state.lastUpdatedAt;
  const fresh = last !== null && now - last <= 30_000 && last <= now + 5_000;
  return { ...state, live: fresh && liveScoutingActive(state.live) ? state.live : null, unavailable: now - first.current.at >= 8_000 };
}
