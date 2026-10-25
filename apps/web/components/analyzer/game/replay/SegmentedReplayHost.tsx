"use client";

import { useCallback, useRef, useState, type ComponentProps } from "react";
import { useAuth } from "@clerk/nextjs";
import type { PlaybackManifest } from "@/lib/segmentedPlayback";
import { usePlaybackSegments } from "@/lib/usePlaybackSegments";
import { clampReplayTime } from "@/lib/replayLink";
import { Button } from "@/components/ui/Button";
import { CompactReplayHost } from "./CompactReplayHost";
import { ReplayStage } from "./ReplayStage";

type Props = {
  gameId: string; manifest: PlaybackManifest; compact?: boolean; maxHeightPx?: number;
  initialTimeSec?: number | null; myName?: string | null; oppName?: string | null;
  myRace?: string | null; oppRace?: string | null; buildName?: string | null; buildMatchPct?: number | null;
  /** Review routes use their existing scoped grant instead of owner URLs. */
  segmentPath?: (artifactId: string, index: number) => string;
  anonymous?: boolean;
  onPlaybackTimeChange?: (time: number) => void;
} & Pick<ComponentProps<typeof ReplayStage>,
  "seekRequest" | "mapMarkers" | "onWorldClick" | "onMarkerClick" | "commentMarkers" | "onCommentMarker" | "mobileCompact" | "defaultShowProduction" | "patchEra" | "onPlaybackStateChange" | "onStageSeek" | "banked" | "upgrades" | "clockLink">;

export function SegmentedReplayHost({ manifest, compact, segmentPath, anonymous = false, onPlaybackTimeChange: onHostTime, ...props }: Props) {
  const { userId } = useAuth();
  const scope = `${anonymous ? "public" : userId ?? ""}:${props.gameId}:${manifest.artifactId}`;
  const initialTime = clampReplayTime(props.initialTimeSec, manifest.gameLength) ?? 0;
  const [clock, setClock] = useState({ scope, time: initialTime, backwards: false });
  const time = clock.scope === scope ? clock.time : initialTime;
  const previous = useRef({ scope, time });
  const [speed, setSpeed] = useState(8);
  const { current, buffering, error, retry, castMarkers } = usePlaybackSegments({ manifest, gameId: props.gameId,
    time, speed, backwards: clock.scope === scope && clock.backwards, anonymous, segmentPath });
  const onPlaybackTimeChange = useCallback((next: number) => {
    const backwards = previous.current.scope === scope && next < previous.current.time;
    previous.current = { scope, time: next };
    setClock({ scope, time: next, backwards });
    onHostTime?.(next);
  }, [scope, onHostTime]);
  const loading = <div role={error ? "alert" : "status"} className="flex min-h-44 flex-col items-center justify-center gap-3 p-6 text-center">
    <p>{error || "Loading replay at this time…"}</p>
    {error && <Button variant="secondary" size="sm" onClick={retry}>Retry playback</Button>}
  </div>;
  if (!current) return <div className="rounded-lg border border-border bg-bg-elevated/40" aria-busy={!error}>{loading}</div>;
  const shared = { ...props, playback: current.playback, onPlaybackTimeChange, onPlaybackSpeedChange: setSpeed,
    castMarkers, buffering, playbackWindow: { start: current.entry.start, end: current.entry.end } };
  return <div className="relative" aria-busy={buffering && !error}>
    {compact ? <CompactReplayHost key={scope} {...shared} /> : <ReplayStage key={scope} {...shared} />}
    {buffering && (error ? <div className="absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-bg-surface/95">{loading}</div>
      : <div role="status" className="pointer-events-none absolute right-3 top-3 z-30 rounded-md bg-black/80 px-3 py-2 text-caption text-white">Loading next replay section…</div>)}
  </div>;
}
