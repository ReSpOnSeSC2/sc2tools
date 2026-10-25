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
import type { PatchEra } from "@/lib/meta";
import { CompactReplayHost } from "./replay/CompactReplayHost";
import type { ComponentProps } from "react";
import dynamic from "next/dynamic";
import { PlaybackFidelityCard } from "./PlaybackFidelityCard";
import { MISSING_PLAYBACK_HINT } from "@/lib/playbackFidelity";

const SegmentedReplayHost = dynamic(() => import("./replay/SegmentedReplayHost").then(value => value.SegmentedReplayHost), { ssr: false });
// Dossiers also import this host for a compact modal. Keep the full HUD's
// rails, shortcut sheet and preferences out of their initial page bundle.
const ReplayStage = dynamic(() => import("./replay/ReplayStage").then(value => value.ReplayStage), {
  loading: () => <div role="status" className="flex min-h-64 items-center justify-center rounded-lg border border-border bg-bg-elevated/40 text-caption text-text-muted">Loading replay controls…</div>,
});

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
  initialTimeSec,
  patchEra,
  seekRequest,
  onPlaybackTimeChange,
  onPlaybackStateChange,
  onStageSeek,
  banked,
  upgrades,
  clockLink,
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
  /** Seek once when this game/timestamp navigation opens; never starts capture. */
  initialTimeSec?: number | null;
  /** The game's patch era (``patchEraForGame`` on the game row), which
   *  prices kills and losses. Omitted, the live 12-worker game. */
  patchEra?: PatchEra | null;
} & Pick<ComponentProps<typeof ReplayStage>, "seekRequest" | "onPlaybackTimeChange" | "onPlaybackStateChange" | "onStageSeek" | "banked" | "upgrades" | "clockLink">) {
  const fallback = useMapReplay(controller ? null : gameId);
  const recording = controller ?? fallback;
  const { playback, manifest, isLoading, error, canRefresh } = recording;
  const fidelity = manifest?.fidelity ?? playback?.fidelity;
  const refreshControl = <PlaybackFidelityCard controller={recording} recorded={fidelity?.positions === "engine"}
    upgrade={fidelity?.positions !== "engine" || fidelity?.complete === false || fidelity?.attacks !== "observed"} />;

  const stageMaxH = maxHeightPx ?? (compact ? COMPACT_STAGE_MAX_H_PX : undefined);

  if (manifest) return <section data-playback-section aria-label="Map replay" className="space-y-2">
    {refreshControl}
    <SegmentedReplayHost key={JSON.stringify([gameId, manifest.artifactId, onPlaybackTimeChange ? null : initialTimeSec ?? null])}
      seekRequest={seekRequest} onPlaybackTimeChange={onPlaybackTimeChange} onPlaybackStateChange={onPlaybackStateChange} onStageSeek={onStageSeek} banked={banked} upgrades={upgrades} clockLink={clockLink}
      manifest={manifest} gameId={gameId} compact={compact} initialTimeSec={initialTimeSec}
      maxHeightPx={stageMaxH} myName={myName} oppName={oppName} myRace={myRace} oppRace={oppRace}
      buildName={buildName} buildMatchPct={buildMatchPct} patchEra={patchEra} />
  </section>;

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
      <div data-playback-section className="rounded-lg border border-border bg-bg-elevated/40 p-4">
        <div className="text-body font-medium text-text">Map replay</div>
        <p className="mt-1 text-caption text-text-dim">
          {error && error.status !== 404
            ? error.message || "Could not load map playback. Check your connection and try again."
            : MISSING_PLAYBACK_HINT}
        </p>
        {refreshControl}
      </div>
    );
  }

  if (compact) {
    return (
      <section
        data-playback-section
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
          key={JSON.stringify([gameId, initialTimeSec ?? null])}
          playback={playback}
          gameId={gameId}
          initialTimeSec={initialTimeSec}
          myRace={myRace}
          maxHeightPx={stageMaxH}
          patchEra={patchEra}
        />
      </section>
    );
  }

  return (
    <div data-playback-section className="space-y-2">
    {refreshControl}
    <ReplayStage
      key={JSON.stringify([gameId, onPlaybackTimeChange ? null : initialTimeSec ?? null])}
      seekRequest={seekRequest} onPlaybackTimeChange={onPlaybackTimeChange} onPlaybackStateChange={onPlaybackStateChange} onStageSeek={onStageSeek} banked={banked} upgrades={upgrades} clockLink={clockLink}
      playback={playback}
      gameId={gameId}
      initialTimeSec={initialTimeSec}
      maxHeightPx={stageMaxH}
      myName={myName}
      oppName={oppName}
      myRace={myRace}
      oppRace={oppRace}
      buildName={buildName}
      buildMatchPct={buildMatchPct}
      patchEra={patchEra}
    />
    </div>
  );
}
