"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { MapPinOff } from "lucide-react";
import { InteractiveTimeline } from "@/components/analyzer/game/InteractiveTimeline";
import { BuildOrderColumns } from "@/components/analyzer/game/BuildOrderColumns";
import type { GameBuildOrderResponse } from "@/components/analyzer/game/types";
import type { ReplayMapMarker } from "@/components/analyzer/game/MapReplayer";
import { ReplayStage } from "@/components/analyzer/game/replay/ReplayStage";
import type { CommentTimelineMarker } from "@/components/analyzer/game/replay/TransportDock";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { sanitizePlaybackManifest } from "@/lib/segmentedPlayback";
import { usePublicApi } from "@/lib/usePublicApi";
import { reviewsRollout, type ReviewAnalysis } from "@/lib/reviews";

const SegmentedReplayHost = dynamic(
  () => import("@/components/analyzer/game/replay/SegmentedReplayHost").then((m) => m.SegmentedReplayHost),
  { ssr: false },
);

type StatsEvents = NonNullable<Parameters<typeof InteractiveTimeline>[0]["statsEvents"]>;

/**
 * The replay half of a review page, fed ONLY by the request's scoped
 * grant (``/v1/reviews/:id/analysis…``) — never the owner's private
 * ``/v1/games`` routes — so it works signed out.
 *
 * Map playback (inline or segmented) renders the full replay stage with
 * the review hooks (seek-and-pause, numbered pins, comment strip, pin
 * placement). Games without playback fall back to the army/supply
 * timeline, whose scrub cursor stands in for the replay clock so time
 * chips still work; map pins are then unavailable.
 */
export function ReviewReplayPanel({
  requestId,
  hidden = false,
  analysis,
  analysisError,
  seekRequest,
  onTimeChange,
  onPlaybackAvailable,
  mapMarkers,
  onWorldClick,
  onMarkerClick,
  commentMarkers,
  onCommentMarker,
}: {
  requestId: string;
  /** Hidden pending moderation: the grant is suspended, nothing to load. */
  hidden?: boolean;
  analysis: ReviewAnalysis | undefined;
  analysisError: { status: number; message: string } | undefined;
  seekRequest: { t: number; seq: number } | null;
  onTimeChange: (t: number) => void;
  onPlaybackAvailable: (available: boolean) => void;
  mapMarkers: readonly ReplayMapMarker[];
  onWorldClick?: (x: number, y: number, t: number) => void;
  onMarkerClick: (id: string) => void;
  commentMarkers: readonly CommentTimelineMarker[];
  onCommentMarker: (marker: CommentTimelineMarker) => void;
}) {
  const enc = encodeURIComponent(requestId);
  const mode = analysis?.playback.mode ?? "none";
  // The admins-only stage 404s anonymous reads, so send the token then.
  const adminStage = reviewsRollout() === "admins";
  const inlineReq = usePublicApi<Record<string, unknown>>(
    mode === "inline" ? `/v1/reviews/${enc}/analysis/map-playback` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    { personalized: adminStage },
  );
  const manifestReq = usePublicApi<Record<string, unknown>>(
    mode === "segmented" ? `/v1/reviews/${enc}/analysis/map-playback/manifest` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    { personalized: adminStage },
  );
  const playback = useMemo(() => (inlineReq.data ? sanitizeMapPlayback(inlineReq.data) : null), [inlineReq.data]);
  const manifest = useMemo(() => (manifestReq.data ? sanitizePlaybackManifest(manifestReq.data) : null), [manifestReq.data]);
  const available = Boolean(playback || manifest);
  useEffect(() => onPlaybackAvailable(available), [available, onPlaybackAvailable]);

  const segmentPath = useCallback(
    (artifactId: string, index: number) => `/v1/reviews/${enc}/analysis/map-playback/artifacts/${artifactId}/segments/${index}`,
    [enc],
  );

  if (hidden) {
    return (
      <div role="status" className="rounded-xl border-2 border-line bg-bg-surface p-4 text-body text-text-muted">
        The replay isn&apos;t shared while this request is hidden pending moderator review.
      </div>
    );
  }
  if (analysisError) {
    return (
      <div role="status" className="rounded-xl border-2 border-line bg-bg-surface p-4 text-body text-text-muted">
        {analysisError.status === 410
          ? analysisError.message || "This request is closed, so its replay is no longer shared."
          : "The replay analysis couldn't be loaded right now. The review thread is still available."}
      </div>
    );
  }
  if (!analysis) {
    return <div aria-busy="true" aria-label="Loading replay" className="h-[36vh] min-h-48 animate-pulse rounded-xl border-2 border-line bg-bg-elevated xl:h-[min(80vh,900px)]" />;
  }

  const stageProps = {
    myName: analysis.game.askerLabel,
    oppName: analysis.game.opponentLabel,
    myRace: analysis.game.myRace,
    oppRace: analysis.game.oppRace,
    buildName: analysis.game.myBuild,
    seekRequest,
    mapMarkers,
    onWorldClick,
    onMarkerClick,
    commentMarkers,
    onCommentMarker,
    mobileCompact: true,
    defaultShowProduction: false,
  };

  if (manifest) {
    return (
      <SegmentedReplayHost
        gameId={`review-${requestId}`}
        manifest={manifest}
        anonymous={!adminStage}
        segmentPath={segmentPath}
        onPlaybackTimeChange={onTimeChange}
        {...stageProps}
      />
    );
  }
  if (playback) {
    return <ReplayStage playback={playback} gameId={`review-${requestId}`} onPlaybackTimeChange={onTimeChange} {...stageProps} />;
  }
  const loadingPlayback = (mode === "inline" && inlineReq.isLoading) || (mode === "segmented" && manifestReq.isLoading);
  if (loadingPlayback) {
    return <div aria-busy="true" aria-label="Loading map replay" className="h-[36vh] min-h-48 animate-pulse rounded-xl border-2 border-line bg-bg-elevated xl:h-[min(80vh,900px)]" />;
  }
  return <TimelineFallback analysis={analysis} seekRequest={seekRequest} onTimeChange={onTimeChange} />;
}

function TimelineFallback({
  analysis,
  seekRequest,
  onTimeChange,
}: {
  analysis: ReviewAnalysis;
  seekRequest: { t: number; seq: number } | null;
  onTimeChange: (t: number) => void;
}) {
  const [scrub, setScrub] = useState<number | null>(seekRequest?.t ?? null);
  useEffect(() => {
    if (seekRequest) setScrub(seekRequest.t);
  }, [seekRequest]);
  const macro = analysis.macroBreakdown as { stats_events?: StatsEvents; opp_stats_events?: StatsEvents } | null;
  const build = analysis.buildOrder as unknown as GameBuildOrderResponse | null;
  return (
    <div className="space-y-3" data-testid="review-timeline-fallback">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-bg-elevated/50 p-3 text-caption text-text-muted">
        <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        Map playback wasn&apos;t recorded for this game, so comments can&apos;t be pinned to the map. Time chips move the timeline cursor instead.
      </p>
      <InteractiveTimeline
        statsEvents={macro?.stats_events}
        oppStatsEvents={macro?.opp_stats_events}
        gameLengthSec={analysis.game.durationSec}
        scrubTime={scrub}
        onScrub={(t) => {
          setScrub(t);
          onTimeChange(t);
        }}
        myName={analysis.game.askerLabel}
        oppName={analysis.game.opponentLabel}
        perspectiveLabel={analysis.game.askerLabel}
      />
      <div className="hidden xl:block">
        <BuildOrderColumns
          myEvents={build?.events}
          oppEvents={build?.opp_events}
          myLabel={build?.my_build ?? analysis.game.myBuild}
          oppLabel={build?.opp_strategy ?? analysis.game.oppStrategy}
          myHeadingLabel={analysis.game.askerLabel}
          opponentHeadingLabel="Opponent"
          myStatus={build?.my_status}
          oppStatus={build?.opp_status}
        />
      </div>
    </div>
  );
}
