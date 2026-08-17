"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle } from "lucide-react";
import { useLiveGame } from "@/lib/useLiveGame";
import { useApi } from "@/lib/clientApi";

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
 *   * If the agent heartbeat is fresh → green "Agent connected · no
 *     game", even with no envelope at all. This is the case the
 *     indicator used to get wrong: the live bridge reads Blizzard's
 *     localhost client API, which only exists while SC2 is running, so
 *     a perfectly healthy agent sitting with the game closed emitted
 *     nothing and was reported "offline". The heartbeat (POSTed every
 *     60 s regardless of SC2) is the honest "is the agent alive?"
 *     signal; the envelope stream only distinguishes in-game.
 *   * Otherwise → dim "Agent offline".
 *
 * Both connected states share the green tone: the streamer's question
 * is binary ("is the agent working?"), and the in-game-vs-menu detail
 * lives in the label.
 *
 * Re-evaluated once a second so the indicator flips promptly without
 * holding the rest of the page hostage on a setState.
 */
const FRESH_LIVE_MS = 10_000;
const FRESH_ANY_MS = 60_000;
/**
 * The agent heartbeats every 60 s (apps/agent heartbeat.py
 * DEFAULT_INTERVAL_SEC). Allow two misses before calling it offline so a
 * single dropped request or a slow round trip doesn't flicker the badge.
 */
const FRESH_HEARTBEAT_MS = 150_000;
/** Re-read /v1/me often enough that a stopped agent goes grey promptly. */
const HEARTBEAT_POLL_MS = 60_000;

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
  // The agent's own heartbeat, independent of whether SC2 is running.
  const { data: me } = useApi<{ agentLastSeenAt?: string | null }>(
    "/v1/me",
    { refreshInterval: HEARTBEAT_POLL_MS },
  );
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const envelopeAgeMs = lastUpdatedAt === null ? null : now - lastUpdatedAt;
  if (live && envelopeAgeMs !== null && envelopeAgeMs < FRESH_LIVE_MS) {
    return "connected-live";
  }
  if (envelopeAgeMs !== null && envelopeAgeMs < FRESH_ANY_MS) {
    return "connected-idle";
  }

  // No usable envelope. Fall back to the heartbeat: an agent with SC2
  // closed is connected, just not in a game.
  const heartbeatMs = parseTimestamp(me?.agentLastSeenAt);
  if (heartbeatMs !== null && now - heartbeatMs < FRESH_HEARTBEAT_MS) {
    return "connected-idle";
  }
  return "offline";
}

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
