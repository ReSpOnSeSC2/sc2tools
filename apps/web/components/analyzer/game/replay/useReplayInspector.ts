"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MapPlayback } from "@/lib/mapReplay";
import {
  createHitBuffer, hitTest, nextNearest, resolveEntity, sameEntity, type ReplayEntityRef,
} from "@/lib/replayInspect";

/**
 * Click-to-inspect state for one ``MapReplayer``: the hit buffer the
 * renderer fills each frame, the selected entity, and whether the
 * camera follows it. Refs mirror the state so the rAF loop and the
 * native pointer listeners read the latest values without re-binding.
 */
export function useReplayInspector(playback: MapPlayback, enabled: boolean) {
  const hitsRef = useRef(createHitBuffer());
  const [selected, setSelectedState] = useState<ReplayEntityRef | null>(null);
  const [following, setFollowingState] = useState(false);
  const selectedRef = useRef<ReplayEntityRef | null>(null);
  const followingRef = useRef(false);
  const lastTapRef = useRef<{ ref: ReplayEntityRef | null; x: number; y: number } | null>(null);

  const setSelected = useCallback((ref: ReplayEntityRef | null) => {
    if (!sameEntity(ref, selectedRef.current)) {
      followingRef.current = false;
      setFollowingState(false);
    }
    selectedRef.current = ref;
    setSelectedState(ref);
  }, []);
  const setFollowing = useCallback((next: boolean) => {
    const value = next && !!selectedRef.current;
    followingRef.current = value;
    setFollowingState(value);
  }, []);

  // A segmented host swaps payloads as playback crosses a boundary; a
  // selection survives when the entity's stable replay id is present.
  const playbackRef = useRef(playback);
  useLayoutEffect(() => {
    const previous = playbackRef.current;
    playbackRef.current = playback;
    if (previous === playback || !selectedRef.current) return;
    const carried = resolveEntity(previous, playback, selectedRef.current);
    const keepFollowing = followingRef.current && !!carried;
    selectedRef.current = carried;
    setSelectedState(carried);
    followingRef.current = keepFollowing;
    setFollowingState(keepFollowing);
    lastTapRef.current = null;
  }, [playback]);

  /** A tap at canvas CSS px; returns whether it selected something. */
  const tap = useCallback((x: number, y: number): boolean => {
    if (!enabled) return false;
    const ref = hitTest(hitsRef.current, x, y, lastTapRef.current);
    lastTapRef.current = { ref, x, y };
    setSelected(ref);
    return ref !== null;
  }, [enabled, setSelected]);

  /** Keyboard inspection: the next entity outward from (x, y). */
  const inspectNext = useCallback((x: number, y: number) => {
    if (!enabled) return;
    setSelected(nextNearest(hitsRef.current, x, y, selectedRef.current));
  }, [enabled, setSelected]);

  /** Escape releases a follow first, then closes the details. */
  const escape = useCallback((): boolean => {
    if (followingRef.current) { setFollowing(false); return true; }
    if (selectedRef.current) { setSelected(null); return true; }
    return false;
  }, [setFollowing, setSelected]);

  return { hitsRef, selected, selectedRef, following, followingRef, setSelected, setFollowing, tap, inspectNext, escape };
}
