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
 *  - ``compact`` (the macro drilldown modal) → ``CompactReplayHost``:
 *    the same bare ``MapReplayer`` as before plus a one-control strip
 *    carrying the background score. The requirement there is still "map
 *    and transport only, no rails", which is exactly what the
 *    replayer's own chrome already is, and it keeps the drilldown's
 *    units-lost panels that hosts have shipped with since the replayer
 *    landed — the score was simply unreachable in this host, because
 *    ``MusicControl`` only ever lived in ``ReplayStage``'s dock.
 */

import { useMapReplay, type MapReplayController } from "@/lib/useMapReplay";
import { CompactReplayHost } from "./replay/CompactReplayHost";
import { ReplayStage } from "./replay/ReplayStage";

/** Stage height cap for the compact (drilldown) host, in CSS px. The
 * full-page host passes none and the replayer sizes itself to the
 * viewport like a video player. */
const COMPACT_STAGE_MAX_H_PX = 420;

export function MapReplaySection({
  gameId,
  controller,
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
  /** Share the host’s recording action and progress without a second request. */
  controller?: MapReplayController;
  /** Compact map and transport presentation for drilldowns. */
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
  const fallback = useMapReplay(controller ? null : gameId);
  const { playback, isLoading, error, canRefresh, refreshing, refreshMessage, refresh } = controller ?? fallback;
  const refreshControl = canRefresh && (playback?.fidelity?.positions !== "engine" ||
    playback?.fidelity?.complete === false || playback?.fidelity?.attacks !== "observed" ||
    refreshing || refreshMessage) ? (
    <div className="flex flex-wrap items-center gap-2 text-caption">
      <button type="button" disabled={refreshing} onClick={refresh}
        className="rounded-md border border-border bg-bg-elevated px-3 py-1.5 font-medium text-text hover:border-accent disabled:cursor-wait disabled:opacity-60">
        {refreshing ? "Recording replay…" : "Generate accurate playback"}
      </button>
      <span role="status" className="text-text-dim">
        {refreshMessage || "Optional: accurate capture is off by default. Enable it in agent Settings → Map replay. Recording a new replay runs StarCraft II in the background and can use significantly more CPU for several minutes. Saved recordings are reused."}
      </span>
    </div>
  ) : null;

  const stageMaxH = maxHeightPx ?? (compact ? COMPACT_STAGE_MAX_H_PX : undefined);

  if (isLoading) {
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
    // Older uploads can still be recorded from their original local replay.
    // Keep the compact empty state actionable instead of hiding the entry point.
    if (compact && !canRefresh) return null;
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-4">
        <div className="text-body font-medium text-text">Map replay</div>
        <p className="mt-1 text-caption text-text-dim">
          {error && error.status !== 404
            ? error.message || "Could not load map playback. Check your connection and try again."
            : "No playback data for this game. Sync the replay for standard analysis, or opt in to accurate capture for detailed map playback."}
        </p>
        {refreshControl}
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
        {refreshControl}
        <CompactReplayHost
          playback={playback}
          gameId={gameId}
          myRace={myRace}
          maxHeightPx={stageMaxH}
        />
      </section>
    );
  }

  return (
    <div className="space-y-2">
    {refreshControl}
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
    </div>
  );
}
