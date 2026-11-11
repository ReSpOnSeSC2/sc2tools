"use client";

import { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { MapPinOff } from "lucide-react";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { sanitizePlaybackManifest } from "@/lib/segmentedPlayback";
import { shareApiPath } from "@/lib/gameShares";
import type { SharedGameAnalysis } from "@/lib/sharedGame";
import { usePublicApi } from "@/lib/usePublicApi";

const SegmentedReplayHost = dynamic(
  () => import("@/components/analyzer/game/replay/SegmentedReplayHost").then((value) => value.SegmentedReplayHost),
  { ssr: false },
);
const ReplayStage = dynamic(
  () => import("@/components/analyzer/game/replay/ReplayStage").then((value) => value.ReplayStage),
  { ssr: false },
);

const placeholder = <div aria-busy="true" aria-label="Loading map replay" className="h-[36vh] min-h-48 animate-pulse rounded-xl border-2 border-line bg-bg-elevated motion-reduce:animate-none" />;

/**
 * The shared game's map replay, fed only by the share's scoped grant
 * (``/v1/shares/:token/map-playback…``), so it plays signed out. Segments
 * come from storage through one-minute links, with the API as fallback.
 */
export function SharedGameReplay({ token, data, seekRequest, initialTimeSec, onTimeChange }: {
  token: string; data: SharedGameAnalysis; seekRequest: { t: number; seq: number } | null;
  initialTimeSec: number | null; onTimeChange: (t: number) => void;
}) {
  const base = shareApiPath(token);
  const mode = data.playback.mode;
  const options = { revalidateOnFocus: false, shouldRetryOnError: false } as const;
  const manifestReq = usePublicApi<Record<string, unknown>>(mode === "segmented" ? `${base}/map-playback/manifest` : null, options);
  const inlineReq = usePublicApi<Record<string, unknown>>(mode === "inline" ? `${base}/map-playback` : null, options);
  const manifest = useMemo(() => (manifestReq.data ? sanitizePlaybackManifest(manifestReq.data) : null), [manifestReq.data]);
  const playback = useMemo(() => (inlineReq.data ? sanitizeMapPlayback(inlineReq.data) : null), [inlineReq.data]);
  const segmentPath = useCallback((artifactId: string, index: number) => `${base}/map-playback/artifacts/${artifactId}/segments/${index}`, [base]);
  const segmentLinkPath = useCallback((artifactId: string, index: number) => `${segmentPath(artifactId, index)}/link`, [segmentPath]);
  const { game } = data;
  const stageProps = {
    gameId: `share-${token}`,
    myName: game.playerLabel,
    oppName: game.opponentLabel,
    myRace: game.myRace,
    oppRace: game.oppRace,
    buildName: game.myBuild,
    initialTimeSec,
    seekRequest,
    onPlaybackTimeChange: onTimeChange,
    mobileCompact: true,
    defaultShowProduction: false,
    clip: "shared" as const,
  };
  if (manifest) {
    return <SegmentedReplayHost {...stageProps} manifest={manifest} anonymous segmentPath={segmentPath} segmentLinkPath={segmentLinkPath} />;
  }
  if (playback) return <ReplayStage {...stageProps} playback={playback} />;
  if ((mode === "segmented" && manifestReq.isLoading) || (mode === "inline" && inlineReq.isLoading)) return placeholder;
  return <p className="flex items-start gap-2 rounded-lg border border-border bg-bg-elevated/50 p-3 text-caption text-text-muted">
    <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
    {mode === "none" ? "Map playback wasn't recorded for this game. The timeline and build orders below still show how it went."
      : "The map replay couldn't be loaded right now. The rest of the analysis is below."}
  </p>;
}
