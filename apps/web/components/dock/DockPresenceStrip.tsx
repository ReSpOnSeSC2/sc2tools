"use client";
import { useRef } from "react";
import useSWR from "swr";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { presenceCount } from "@/lib/overlayPresence";
import { useVisibleSurface } from "@/lib/useVisibleSurface";
type Counts = { surfaces: Record<string, number>; totalSources: number; sampledAt: string };
/** A Dock bearer credential receives counts only, never connection identities. */
export function DockPresenceStrip({ token }: { token: string }) {
  const host = useRef<HTMLDivElement>(null), visible = useVisibleSurface(host);
  const { data, error } = useSWR<Counts>(visible ? ["dock-presence", token] : null, async ([, credential]: readonly [string, string]) => boundedApiRequest(async signal => {
    const response = await fetch(`${API_BASE}/v1/multichat/${encodeURIComponent(credential)}/presence`, { signal, cache: "no-store" });
    if (!response.ok) throw await buildApiError(response); return response.json();
  }, 8000), { refreshInterval: 15_000, refreshWhenHidden: false, refreshWhenOffline: false, keepPreviousData: false, dedupingInterval: 5000, errorRetryCount: 2, errorRetryInterval: 5000 });
  const stale = error || !data?.sampledAt || !Number.isFinite(Date.parse(data.sampledAt)) || Date.now() - Date.parse(data.sampledAt) > 35_000;
  const labels = [["all-in-one", "All-in-one"], ["widget", "Widgets"], ["scene", "Scenes"], ["dock", "Docks"], ["unknown", "Unknown"]];
  return <div ref={host} aria-label="Overlay source counts" className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption text-text-muted">{stale ? <span>Source counts {error ? "unavailable" : "not checked yet"}</span> : labels.filter(([id]) => id !== "unknown" || presenceCount(data.surfaces?.[id]) > 0).map(([id, label]) => <span key={id}>{label} {presenceCount(data.surfaces?.[id])}</span>)}</div>;
}
