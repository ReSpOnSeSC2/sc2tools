"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REPLAY_SPEEDS, type ReplaySpeed } from "./replayControls";

export const REPLAY_PREFS_KEY = "sc2tools:replay-prefs:v1";
export type ReplayPreferences = {
  speed: ReplaySpeed;
  rails: { production: boolean; build: boolean };
  productionSide: "me" | "opp";
  buildFilter: "both" | "me" | "opp";
  showWorkers: boolean;
  autoScroll: boolean;
  panelTab: "production" | "build";
  panelOpen?: boolean;
  volume?: number;
};

/** Ignore malformed, oversized and unknown fields rather than trusting stored JSON. */
export function parseReplayPreferences(raw: string | null): Partial<ReplayPreferences> {
  if (!raw || raw.length > 4096) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const result: Partial<ReplayPreferences> = {};
    if (REPLAY_SPEEDS.includes(source.speed as ReplaySpeed)) result.speed = source.speed as ReplaySpeed;
    if (source.productionSide === "me" || source.productionSide === "opp") result.productionSide = source.productionSide;
    if (["both", "me", "opp"].includes(source.buildFilter as string)) result.buildFilter = source.buildFilter as ReplayPreferences["buildFilter"];
    if (source.panelTab === "production" || source.panelTab === "build") result.panelTab = source.panelTab;
    for (const key of ["showWorkers", "autoScroll", "panelOpen"] as const) if (typeof source[key] === "boolean") result[key] = source[key];
    if (typeof source.volume === "number" && Number.isFinite(source.volume) && source.volume >= 0 && source.volume <= 1) result.volume = source.volume;
    const rails = source.rails as Record<string, unknown> | null;
    if (rails && typeof rails.production === "boolean" && typeof rails.build === "boolean") result.rails = { production: rails.production, build: rails.build };
    return result;
  } catch { return {}; }
}

export function useReplayPreferences(defaultShowProduction: boolean) {
  const [preferences, setPreferences] = useState<ReplayPreferences>({ speed: 8, rails: { production: defaultShowProduction, build: true }, productionSide: "me", buildFilter: "both", showWorkers: false, autoScroll: true, panelTab: "production" });
  const [ready, setReady] = useState(false);
  const touched = useRef<Partial<ReplayPreferences>>({});
  useEffect(() => {
    let saved: Partial<ReplayPreferences> = {};
    try { saved = parseReplayPreferences(window.localStorage.getItem(REPLAY_PREFS_KEY)); } catch { /* Storage can be blocked. */ }
    setPreferences((current) => ({ ...current, ...saved, ...touched.current }));
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { window.localStorage.setItem(REPLAY_PREFS_KEY, JSON.stringify(preferences)); } catch { /* Playback still works without storage. */ }
  }, [preferences, ready]);
  const update = useCallback((patch: Partial<ReplayPreferences>) => {
    touched.current = { ...touched.current, ...patch };
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);
  return { preferences, update };
}
