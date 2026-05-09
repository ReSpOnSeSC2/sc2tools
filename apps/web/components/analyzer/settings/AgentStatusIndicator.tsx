"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle } from "lucide-react";
import { useLiveGame } from "@/lib/useLiveGame";

/**
 * Live "Agent connected ✓ / Agent offline ✗" indicator for the
 * Settings → Overlay header.
 *
 * Source of truth: a fresh ``useLiveGame`` envelope means the desktop
 * agent has POSTed to ``/v1/agent/live`` recently AND the cloud is
 * fanning that out via SSE. Either link breaking would stop the
 * indicator from going green, which is exactly the signal a
 * troubleshooting streamer needs ("agent unreachable" vs "OBS not
 * subscribed").
 *
 * Heuristic:
 *   * If a non-idle envelope has arrived in the last 10 s → green
 *     "Agent connected · in game". Tells the streamer their match
 *     is being captured AND surfaced to widgets.
 *   * If an idle/menu envelope has arrived in the last 60 s → green
 *     "Agent connected · no game". The bridge still reports phase
 *     transitions in menu, so this proves the connection is alive.
 *     Streamers asked for a single "is the agent working?" tell —
 *     both connected states share the green tone so the indicator
 *     stays green when they're sitting in the menu picking a build.
 *   * Otherwise → dim "Agent offline".
 *
 * Re-evaluated once a second so the indicator flips promptly without
 * holding the rest of the page hostage on a setState.
 */
const FRESH_LIVE_MS = 10_000;
const FRESH_ANY_MS = 60_000;

export type AgentStatus = "connected-live" | "connected-idle" | "offline";

export function AgentStatusIndicator({
  className,
}: {
  className?: string;
}) {
  const status = useAgentStatus();
  // Both connected states share the green tone — the streamer's
  // mental model is binary ("agent is talking to the cloud or it
  // isn't"); the in-game-vs-menu distinction lives in the label.
  const tone =
    status === "offline" ? "text-text-dim" : "text-success";
  const label =
    status === "connected-live"
      ? "Agent connected · in game"
      : status === "connected-idle"
        ? "Agent connected · no game"
        : "Agent offline";
  const Icon = status === "offline" ? AlertCircle : Activity;
  return (
    <span
      className={["inline-flex items-center gap-1.5 text-caption", tone, className]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-flex h-2 w-2 rounded-full"
        style={{
          background:
            status === "offline"
              ? "var(--color-text-dim, #5b6473)"
              : "var(--color-success, #3ec07a)",
        }}
        aria-hidden
      />
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Internals: derive the freshness status from ``useLiveGame`` plus a
 * 1 s ticker so the label flips even when no fresh envelope is
 * arriving. Exported for test re-use.
 */
export function useAgentStatus(): AgentStatus {
  const { live, lastUpdatedAt } = useLiveGame();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (lastUpdatedAt === null) return "offline";
  const ageMs = now - lastUpdatedAt;
  if (live && ageMs < FRESH_LIVE_MS) return "connected-live";
  if (ageMs < FRESH_ANY_MS) return "connected-idle";
  return "offline";
}
