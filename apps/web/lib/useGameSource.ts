"use client";

import { useMemo, useSyncExternalStore } from "react";
import { safeGameSource, type GameSource } from "./gameNavigation";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => { window.removeEventListener("popstate", onChange); window.removeEventListener("hashchange", onChange); };
}
const readSource = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const serverSource = () => "";

/** Hydration-safe source, refreshed on history changes and list rerenders. */
export function useGameSource(label?: string): GameSource | null {
  const href = useSyncExternalStore(subscribe, readSource, serverSource);
  return useMemo(() => safeGameSource(href, label), [href, label]);
}
