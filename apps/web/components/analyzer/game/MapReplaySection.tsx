"use client";

/**
 * MapReplaySection — fetch-and-render host for the map replayer.
 *
 * GET /v1/games/:id/map-playback returns the compact playback payload
 * for games synced by playback-capable agents, or 404
 * ``playback_not_computed`` for older uploads. Both hosts (the game
 * page's analysis flow and the macro-breakdown drilldown) embed this
 * one component so the data path, sanitizing, and empty states never
 * drift apart.
 */

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { MapReplayer } from "./MapReplayer";

export function MapReplaySection({
  gameId,
  compact = false,
}: {
  gameId: string;
  /** Drilldown hosts hide entirely (no hint card) when absent. */
  compact?: boolean;
}) {
  const req = useApi<Record<string, unknown>>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/map-playback` : null,
    { revalidateOnFocus: false },
  );
  const playback = useMemo(
    () => (req.data ? sanitizeMapPlayback(req.data) : null),
    [req.data],
  );

  if (req.isLoading) {
    if (compact) return null;
    // Roughly canvas-shaped so the page doesn't jump when the replay
    // arrives (most ladder maps project close to square).
    return (
      <div
        className="aspect-[4/3] max-h-[720px] w-full animate-pulse rounded-lg border border-border bg-bg-elevated/40"
        aria-busy="true"
        aria-label="Loading map replay"
      />
    );
  }
  if (!playback) {
    // 404 playback_not_computed (older agent upload) or junk payload —
    // a one-line hint beats an empty canvas, and nothing beats noise
    // in the compact drilldown.
    if (compact) return null;
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-4">
        <div className="text-body font-medium text-text">Map replay</div>
        <p className="mt-1 text-caption text-text-dim">
          No playback data for this game — replays synced with the
          latest desktop agent include a full map replay (unit
          movements, buildings, and battles over time).
        </p>
      </div>
    );
  }

  return (
    <section
      aria-label="Map replay"
      className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-body font-medium text-text">Map replay</div>
        <span className="text-micro text-text-dim">
          {playback.mapName || ""}
        </span>
      </div>
      <MapReplayer playback={playback} />
    </section>
  );
}
