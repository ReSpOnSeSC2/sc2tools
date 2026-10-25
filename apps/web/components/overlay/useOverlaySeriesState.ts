"use client";
import { useCallback, useRef, useState } from "react";
import { newerSeries, normalizeSeriesSnapshot, type SeriesSnapshot } from "@/lib/streamSeries";

/** Piggybacks the existing overlay connection. No extra socket or GET. */
export function useOverlaySeriesState(token: string) {
  const scope = useRef({ token }); if (scope.current.token !== token) scope.current = { token };
  const identity = scope.current;
  const [snapshot, setSnapshot] = useState<{ identity: typeof identity; series: SeriesSnapshot | null } | null>(null);
  const receiveSeries = useCallback((raw: unknown) => {
    if (scope.current !== identity) return;
    const next = normalizeSeriesSnapshot(raw); if (next === undefined) return;
    setSnapshot(current => ({ identity, series: newerSeries(current?.identity === identity ? current.series : null, next) }));
  }, [identity]);
  return { series: snapshot?.identity === identity ? snapshot.series : null, receiveSeries };
}
