"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE } from "./clientApi";
import { decodePlaybackSegment, PlaybackSegmentCache, readBoundedSegment, segmentAt, type PlaybackManifest, type PlaybackSegmentEntry } from "./segmentedPlayback";
import type { MapPlayback } from "./mapReplay";
import { replayCastMarkers, mergeMarkers, type TimelineMarker } from "./replayHud";

type Loaded = { scope: string; entry: PlaybackSegmentEntry; playback: MapPlayback };

/** One foreground read and one abortable neighbor prefetch; no SWR heavy cache. */
export function usePlaybackSegments({ manifest, gameId, time, speed, backwards, anonymous, segmentPath }: {
  manifest: PlaybackManifest; gameId: string; time: number; speed: number; backwards: boolean;
  anonymous: boolean; segmentPath?: (artifactId: string, index: number) => string;
}) {
  const { getToken, userId } = useAuth();
  const scope = `${anonymous ? "public" : userId ?? ""}:${gameId}:${manifest.artifactId}`;
  const store = useRef({ scope, cache: new PlaybackSegmentCache(), casts: new Map<number, TimelineMarker[]>() });
  if (store.current.scope !== scope) store.current = { scope, cache: new PlaybackSegmentCache(), casts: new Map() };
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState({ scope: "", index: -1, message: "" });
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  const desired = segmentAt(manifest, time);
  const tokenGetter = useRef(getToken); tokenGetter.current = getToken;
  const key = (index: number) => `${manifest.artifactId}:${index}`;
  const cached = store.current.cache.get(key(desired.index));
  const current = cached ? { scope, entry: desired, playback: cached } : loaded?.scope === scope ? loaded : null;
  const buffering = current?.entry.index !== desired.index;
  const prefetchIndex = backwards && desired.index > 0 ? desired.index - 1
    : time > desired.end - Math.max(8, 3 * speed) ? desired.index + 1 : -1;

  const load = useCallback(async (entry: PlaybackSegmentEntry, controller: AbortController) => {
    const saved = store.current.cache.get(`${manifest.artifactId}:${entry.index}`);
    if (saved) return saved;
    let headers: Record<string, string> | undefined;
    if (!anonymous) {
      if (!userId) throw new Error("Sign in again to load this replay.");
      const token = await tokenGetter.current(); controller.signal.throwIfAborted();
      if (!token) throw new Error("Sign in again to load this replay.");
      headers = { authorization: `Bearer ${token}` };
    }
    const path = segmentPath ? segmentPath(manifest.artifactId, entry.index)
      : `/v1/games/${encodeURIComponent(gameId)}/map-playback/artifacts/${manifest.artifactId}/segments/${entry.index}`;
    const response = await fetch(`${API_BASE}${path}`, { headers, cache: "default", signal: controller.signal });
    const bytes = await readBoundedSegment(response, entry.sizeBytes);
    const playback = await decodePlaybackSegment(bytes, manifest, entry);
    controller.signal.throwIfAborted();
    if (store.current.scope !== scope) throw new DOMException("Replay changed", "AbortError");
    store.current.cache.set(`${manifest.artifactId}:${entry.index}`, playback);
    // The existing marker merger caps each segment's presentation index. Keep
    // only these small cast markers when a heavy segment is evicted.
    store.current.casts.set(entry.index, replayCastMarkers(playback.casts ?? []));
    setRevision(value => value + 1);
    return playback;
  }, [manifest, anonymous, userId, segmentPath, gameId, scope]);

  useEffect(() => {
    const controller = new AbortController(); let cancelled = false;
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    setFailure({ scope, index: desired.index, message: "" });
    void load(desired, controller).then(playback => {
      if (!cancelled) setLoaded({ scope, entry: desired, playback });
    }).catch(error => {
      if (!cancelled && store.current.scope === scope) setFailure({ scope, index: desired.index,
        message: controller.signal.aborted ? "Playback download timed out. Try this section again." : error?.message || "Could not load this part of the replay." });
    }).finally(() => window.clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [scope, desired, attempt, load]);

  useEffect(() => {
    const entry = manifest.segments[prefetchIndex];
    if (!entry || store.current.cache.get(`${manifest.artifactId}:${entry.index}`)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    void load(entry, controller).catch(() => undefined).finally(() => window.clearTimeout(timer));
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [scope, manifest, prefetchIndex, load]);

  const casts = useRef({ scope: "", revision: -1, value: [] as TimelineMarker[] });
  if (casts.current.scope !== scope || casts.current.revision !== revision) {
    casts.current = { scope, revision, value: mergeMarkers([...store.current.casts.values()].flat().sort((a, b) => a.t - b.t)) };
  }
  return { scope, current, buffering, castMarkers: casts.current.value,
    error: failure.scope === scope && failure.index === desired.index ? failure.message : "",
    retry: () => setAttempt(value => value + 1) };
}
