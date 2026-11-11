"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { normalizePresence, type OverlayPresence } from "@/lib/overlayPresence";
import { useVisibleSurface } from "@/lib/useVisibleSurface";
type Health = { active: boolean; snapshot: OverlayPresence | null; enabledWidgets: readonly string[]; error?: ClientApiError; loading: boolean; refresh: () => void };
const Context = createContext<Health | null>(null);
export const useOverlayHealth = () => useContext(Context);

/** One owner-scoped resource serves the whole visible Settings section. */
export function OverlayHealthProvider({ token, enabled, enabledWidgets = [], children }: { token: string; enabled: boolean; enabledWidgets?: readonly string[]; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null), active = useVisibleSurface(host, enabled);
  const result = useApi<unknown>(active ? `/v1/overlay-tokens/${encodeURIComponent(token)}/presence` : null,
    { refreshInterval: 15_000, dedupingInterval: 5000, keepPreviousData: false, refreshWhenHidden: false, refreshWhenOffline: false, errorRetryInterval: 5000, errorRetryCount: 2 }, { timeoutMs: 10_000 });
  const snapshot = active ? normalizePresence(result.data) : null;
  const error = active ? result.error ?? (result.data !== undefined && !snapshot ? { status: 502, message: "Invalid source status" } : undefined) : undefined;
  return <Context.Provider value={{ active, snapshot, enabledWidgets, error, loading: active && result.isLoading, refresh: () => { if (active) void result.mutate(); } }}><div ref={host} className="min-w-0">{children}</div></Context.Provider>;
}
