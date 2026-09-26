"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE } from "@/lib/clientApi";
import { decodePlaybackSegment, PlaybackSegmentCache, readBoundedSegment, segmentAt,
  type PlaybackManifest, type PlaybackSegmentEntry } from "@/lib/segmentedPlayback";
import type { MapPlayback } from "@/lib/mapReplay";
import { clampReplayTime } from "@/lib/replayLink";
import { CompactReplayHost } from "./CompactReplayHost";
import { ReplayStage } from "./ReplayStage";

type Props = {
  gameId: string; manifest: PlaybackManifest; compact?: boolean; maxHeightPx?: number;
  initialTimeSec?: number | null; myName?: string | null; oppName?: string | null;
  myRace?: string | null; oppRace?: string | null; buildName?: string | null; buildMatchPct?: number | null;
};

export function SegmentedReplayHost({ manifest, compact, ...props }: Props) {
  const { getToken, userId } = useAuth();
  const scope = `${userId ?? ""}:${props.gameId}:${manifest.artifactId}`;
  const initialTime = clampReplayTime(props.initialTimeSec, manifest.gameLength) ?? 0;
  const [clock, setClock] = useState({ scope, time: initialTime });
  const time = clock.scope === scope ? clock.time : initialTime;
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<{ scope: string; entry: PlaybackSegmentEntry; playback: MapPlayback } | null>(null);
  const cache = useRef({ scope, value: new PlaybackSegmentCache(3) });
  if (cache.current.scope !== scope) cache.current = { scope, value: new PlaybackSegmentCache(3) };
  const desired = segmentAt(manifest, time);
  const current = loaded?.scope === scope ? loaded : null;
  const buffering = !current || current.entry.index !== desired.index;
  const tokenGetter = useRef(getToken);
  tokenGetter.current = getToken;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const key = `${manifest.artifactId}:${desired.index}`;
    const cached = cache.current.value.get(key);
    setError("");
    if (cached) {
      setLoaded({ scope, entry: desired, playback: cached });
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    const load = async () => {
      try {
        if (!userId) throw new Error("Sign in again to load this replay.");
        const token = await tokenGetter.current();
        controller.signal.throwIfAborted();
        if (!token) throw new Error("Sign in again to load this replay.");
        const path = `/v1/games/${encodeURIComponent(props.gameId)}/map-playback/artifacts/${manifest.artifactId}/segments/${desired.index}`;
        const response = await fetch(`${API_BASE}${path}`, {
          headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
        const bytes = await readBoundedSegment(response, desired.sizeBytes);
        const playback = await decodePlaybackSegment(bytes, manifest, desired);
        if (cancelled || cache.current.scope !== scope) return;
        cache.current.value.set(key, playback);
        setLoaded({ scope, entry: desired, playback });
      } catch (failure) {
        if (cancelled || cache.current.scope !== scope) return;
        setError(controller.signal.aborted ? "Playback download timed out. Try this section again." :
          (failure as { message?: string })?.message || "Could not load this part of the replay.");
      } finally { window.clearTimeout(timer); }
    };
    void load();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [scope, userId, props.gameId, manifest, desired, attempt]);

  const onPlaybackTimeChange = useCallback((next: number) => setClock({ scope, time: next }), [scope]);
  const loading = <div role={error ? "alert" : "status"} className="flex min-h-44 flex-col items-center justify-center gap-3 p-6 text-center">
    <p>{error || "Loading replay at this time…"}</p>
    {error && <button type="button" className="rounded-md border border-border px-3 py-2" onClick={() => setAttempt(value => value + 1)}>Retry playback</button>}
  </div>;
  if (!current) return <div className="rounded-lg border border-border bg-bg-elevated/40" aria-busy={!error}>{loading}</div>;
  const shared = { ...props, playback: current.playback, onPlaybackTimeChange, buffering,
    playbackWindow: { start: current.entry.start, end: current.entry.end } };
  return <div className="relative" aria-busy={buffering && !error}>
    {compact ? <CompactReplayHost key={scope} {...shared} /> : <ReplayStage key={scope} {...shared} />}
    {buffering && <div className="absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-bg-surface/95">{loading}</div>}
  </div>;
}
