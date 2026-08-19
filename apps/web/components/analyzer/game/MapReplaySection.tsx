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
 *
 * Two presentations over the same payload:
 *
 *  - full page  → ``ReplayStage``, the vespene-style HUD: mirrored top
 *    bar, production rail, live build-order feed, transport dock with
 *    event markers.
 *  - ``compact`` (the macro drilldown modal) → the bare
 *    ``MapReplayer``, unchanged. The requirement there is "map and
 *    transport only, no rails", which is exactly what the replayer's
 *    own chrome already is, and it keeps the drilldown's units-lost
 *    panels that hosts have shipped with since the replayer landed.
 */

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { MapReplayer } from "./MapReplayer";
import { ReplayStage } from "./replay/ReplayStage";

/** Stage height cap for the compact (drilldown) host, in CSS px. The
 * full-page host passes none and the replayer sizes itself to the
 * viewport like a video player. */
const COMPACT_STAGE_MAX_H_PX = 420;

export function MapReplaySection({
  gameId,
  compact = false,
  maxHeightPx,
  myName,
  oppName,
  myRace,
  oppRace,
  buildName,
  buildMatchPct,
}: {
  gameId: string;
  /** Drilldown hosts hide entirely (no hint card) when absent. */
  compact?: boolean;
  /** Override the stage height cap. Defaults to the viewport-sized
   * stage, or ``COMPACT_STAGE_MAX_H_PX`` in compact hosts. */
  maxHeightPx?: number;
  /* The playback payload carries no player identity, no race and no
   * build detection — those live on the game row and the build-order
   * endpoint, which the hosts have already fetched. Pass them through
   * and the HUD uses them; omit them and it falls back to
   * "You" / "Opponent" with no race icon and a heuristic opening read
   * off the first structures placed. */
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
  buildName?: string | null;
  buildMatchPct?: number | null;
}) {
  const req = useApi<Record<string, unknown>>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/map-playback` : null,
    { revalidateOnFocus: false },
  );
  const playback = useMemo(
    () => (req.data ? sanitizeMapPlayback(req.data) : null),
    [req.data],
  );

  const stageMaxH = maxHeightPx ?? (compact ? COMPACT_STAGE_MAX_H_PX : undefined);

  if (req.isLoading) {
    if (compact) return null;
    // Roughly canvas-shaped so the page doesn't jump when the replay
    // arrives (most ladder maps project close to square). Height
    // tracks the stage's own viewport sizing rather than the old
    // 720 px ceiling.
    return (
      <div
        className="aspect-square max-h-[78vh] w-full animate-pulse rounded-lg border border-border bg-bg-elevated/40"
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

  if (compact) {
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
        <MapReplayer playback={playback} maxHeightPx={stageMaxH} />
      </section>
    );
  }

  return (
    <ReplayStage
      playback={playback}
      gameId={gameId}
      maxHeightPx={stageMaxH}
      myName={myName}
      oppName={oppName}
      myRace={myRace}
      oppRace={oppRace}
      buildName={buildName}
      buildMatchPct={buildMatchPct}
    />
  );
}
