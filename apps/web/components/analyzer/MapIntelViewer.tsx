"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { RefreshCcw } from "lucide-react";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import type { MapEntry } from "./MapIntelTab";

type HeatCell = { x: number; y: number; intensity: number; value?: number };

type HeatmapResp = {
  ok?: boolean;
  kind?: string;
  map?: string;
  grid?: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  points?: number;
  cells?: HeatCell[];
};

type BuildingsResp = {
  ok?: boolean;
  cells?: HeatCell[];
  bounds?: HeatmapResp["bounds"];
  points?: number;
  grid?: number;
};

const LAYERS: ReadonlyArray<{
  key: "proxy" | "battle" | "death-zone" | "buildings" | "opponent-proxies";
  label: string;
  hint: string;
  color: string;
}> = [
  { key: "proxy", label: "My proxies", hint: "Where you forward-base", color: "#7c8cff" },
  { key: "opponent-proxies", label: "Opp. proxies", hint: "Where they proxy on you", color: "#ff8a3d" },
  { key: "battle", label: "Battles", hint: "Large engagements", color: "#3ec07a" },
  { key: "death-zone", label: "Death zones", hint: "Where your army dies", color: "#ff6b6b" },
  { key: "buildings", label: "Buildings", hint: "Your placed structures", color: "#a78bfa" },
];

type LayerKey = (typeof LAYERS)[number]["key"];

/**
 * Heatmap viewer for a single selected map. Calls the `/v1/spatial/*`
 * endpoints lazily as the user toggles layers, overlays cells on the
 * map minimap, and falls back to a clear empty state when the map has
 * no spatial extracts (the layer list still renders so the user can
 * see why nothing is shown).
 *
 * When `embedded` is true, the viewer renders bare (no outer Card)
 * so a parent Modal can host the chrome. Otherwise it wraps itself
 * in a Card for the legacy inline-on-page presentation.
 */
export function MapIntelViewer({
  mapName,
  summary,
  embedded = false,
}: {
  mapName: string;
  summary: MapEntry | null;
  embedded?: boolean;
}) {
  const { filters, dbRev } = useFilters();
  const { getToken } = useAuth();
  const [layer, setLayer] = useState<LayerKey>("proxy");
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const params = filtersToQuery({ ...filters, map: mapName });
  const cacheKey = `${dbRev}-${mapName}`;

  const heat = useApi<HeatmapResp>(
    layer !== "buildings"
      ? `/v1/spatial/${layer}${params}#${cacheKey}-${layer}`
      : null,
  );
  const buildings = useApi<BuildingsResp>(
    layer === "buildings"
      ? `/v1/spatial/buildings${params}#${cacheKey}-buildings`
      : null,
  );

  const isLoading = heat.isLoading || buildings.isLoading;
  const layerMeta = LAYERS.find((l) => l.key === layer)!;
  const cells = layer === "buildings" ? buildings.data?.cells : heat.data?.cells;
  const grid =
    (layer === "buildings" ? buildings.data?.grid : heat.data?.grid) || 64;
  const points =
    layer === "buildings" ? buildings.data?.points : heat.data?.points;

  const requestRecompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      // Mass-recompute is the closest fit to "re-extract spatial
      // data": it tells the agent to re-parse every replay missing
      // structured outputs, which now includes the spatial extracts.
      await apiCall<{ ok: boolean }>(
        getToken,
        "/v1/macro/backfill/start",
        { method: "POST", body: JSON.stringify({ force: true }) },
      );
      setRecomputeMsg(
        "Resync requested. If your desktop agent is online, it will re-upload heatmap data shortly. Otherwise open the agent and click Resync.",
      );
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e?.message || "Couldn't request a resync.");
    } finally {
      window.setTimeout(() => setRecomputing(false), 1500);
    }
  }, [getToken, recomputing]);

  const body = (
    <>
      {summary ? (
        <div className="-mt-2 mb-3 flex flex-wrap items-center gap-2 text-xs text-text-dim">
          <span>
            {summary.total} games · {summary.wins}W &ndash; {summary.losses}L
          </span>
          {summary.hasSpatial ? null : (
            <>
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                No spatial extracts yet — agent needs to re-analyse replays
              </span>
              <Button
                variant="ghost"
                size="sm"
                loading={recomputing}
                onClick={requestRecompute}
                iconLeft={<RefreshCcw className="h-3 w-3" aria-hidden />}
              >
                {recomputing ? "Requesting…" : "Request resync"}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {recomputeMsg ? (
        <p
          role="status"
          className="mb-2 rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-caption text-text-muted"
        >
          {recomputeMsg}
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1">
        {LAYERS.map((l) => (
          <button
            key={l.key}
            type="button"
            onClick={() => setLayer(l.key)}
            title={l.hint}
            className={`rounded px-2 py-1 text-xs ${
              layer === l.key
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-bg-elevated text-text-muted hover:text-text"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Skeleton rows={3} />
      ) : (
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded border border-border bg-bg-elevated">
          <img
            src={`${API_BASE}/v1/map-image?map=${encodeURIComponent(mapName)}`}
            alt={`${mapName} minimap`}
            className="absolute inset-0 h-full w-full object-cover opacity-60"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          {cells && cells.length > 0 ? (
            <HeatmapOverlay
              cells={cells}
              grid={grid}
              color={layerMeta.color}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState
                title={`No ${layerMeta.label.toLowerCase()} samples`}
                sub={
                  summary?.hasSpatial
                    ? "No samples for this layer on this map yet."
                    : "Agent hasn't extracted spatial data for this map."
                }
              />
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-text-dim">
        <span>
          {layerMeta.hint} · {points || 0} sample
          {(points || 0) === 1 ? "" : "s"}
        </span>
        <span className="font-mono">grid {grid}×{grid}</span>
      </div>
    </>
  );

  if (embedded) return body;
  return <Card title={`${mapName} · heatmaps`}>{body}</Card>;
}

function HeatmapOverlay({
  cells,
  grid,
  color,
}: {
  cells: HeatCell[];
  grid: number;
  color: string;
}) {
  const radius = Math.max(0.6, 100 / grid / 1.4);
  return (
    <svg
      viewBox={`0 0 ${grid} ${grid}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
    >
      {cells.map((c, i) => {
        const a = clamp01(c.intensity);
        if (a <= 0) return null;
        return (
          <circle
            key={`${c.x}-${c.y}-${i}`}
            cx={c.x + 0.5}
            cy={c.y + 0.5}
            r={radius}
            fill={color}
            fillOpacity={0.25 + a * 0.6}
          />
        );
      })}
    </svg>
  );
}

function clamp01(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}
