"use client";
import { useEffect, useState } from "react";
import { DEFAULT_TIMELINE_METRIC, TIMELINE_METRICS, type TimelineMetric } from "./timelineMetrics";

export const TIMELINE_METRICS_STORAGE_KEY = "sc2tools:timeline-metrics:v1";
export function parseTimelineMetrics(raw: string | null): TimelineMetric[] {
  if (raw === null) return [DEFAULT_TIMELINE_METRIC];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [DEFAULT_TIMELINE_METRIC];
    const known = TIMELINE_METRICS.filter((metric) => parsed.includes(metric.key)).map((metric) => metric.key);
    return known.length || parsed.length === 0 ? known : [DEFAULT_TIMELINE_METRIC];
  } catch { return [DEFAULT_TIMELINE_METRIC]; }
}

/** Hydrate after the first render; storage failures never disable chart controls. */
export function useTimelineMetrics() {
  const [chosen, setChosen] = useState<TimelineMetric[]>([DEFAULT_TIMELINE_METRIC]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { setChosen(parseTimelineMetrics(localStorage.getItem(TIMELINE_METRICS_STORAGE_KEY))); } catch { /* Private/storage-disabled browser. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) try { localStorage.setItem(TIMELINE_METRICS_STORAGE_KEY, JSON.stringify(chosen)); } catch { /* Chart stays usable. */ }
  }, [chosen, ready]);
  return [chosen, setChosen] as const;
}
