"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ImageOff, RefreshCcw } from "lucide-react";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
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
 * no spatial extracts.
 *
 * The viewer is split into:
 *   - Header strip: summary stats + a prominent "Request resync" button
 *     when no spatial data exists yet on this map.
 *   - Layer toggle row: 5 chips for the heatmap layers.
 *   - Minimap canvas: ALWAYS shows the minimap image (loaded from
 *     `/v1/map-image`) regardless of whether spatial data exists, so
 *     the user gets visual context. When cells are present they
 *     overlay; otherwise a non-blocking pill in the corner explains.
 *   - Legend strip: per-layer hint, sample count, grid size.
 *
 * When `embedded` is true the viewer renders without an outer Card so
 * a parent Modal hosts the chrome. Otherwise it wraps itself in a Card.
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
  const [imageError, setImageError] = useState(false);
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
    (layer === "buildings" ? buildings.data?.points : heat.data?.points) || 0;

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
        "Resync requested. If your desktop agent is online, heatmap data will refresh shortly. Otherwise open the agent and click Resync.",
      );
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e?.message || "Couldn't request a resync.");
    } finally {
      window.setTimeout(() => setRecomputing(false), 1500);
    }
  }, [getToken, recomputing]);

  const hasSpatial = !!summary?.hasSpatial;
  const hasCells = !!cells && cells.length > 0;

  const body = (
    <div className="space-y-3">
      <SummaryRow
        summary={summary}
        hasSpatial={hasSpatial}
        recomputing={recomputing}
        onRecompute={requestRecompute}
      />

      {recomputeMsg ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-caption text-text-muted"
        >
          {recomputeMsg}
        </p>
      ) : null}

      <LayerTabs current={layer} onChange={setLayer} />

      <HeatmapCanvas
        mapName={mapName}
        layerColor={layerMeta.color}
        layerLabel={layerMeta.label}
        cells={cells}
        grid={grid}
        isLoading={isLoading}
        hasCells={hasCells}
        hasSpatial={hasSpatial}
        imageError={imageError}
        onImageError={() => setImageError(true)}
        onRecompute={requestRecompute}
        recomputing={recomputing}
      />

      <LegendBar
        hint={layerMeta.hint}
        points={points}
        grid={grid}
      />
    </div>
  );

  if (embedded) return body;
  return <Card title={`${mapName} · heatmaps`}>{body}</Card>;
}

function SummaryRow({
  summary,
  hasSpatial,
  recomputing,
  onRecompute,
}: {
  summary: MapEntry | null;
  hasSpatial: boolean;
  recomputing: boolean;
  onRecompute: () => void;
}) {
  if (!summary) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption">
      <span className="text-text-muted tabular-nums">
        {summary.total} games
      </span>
      <span aria-hidden className="text-text-dim">
        ·
      </span>
      <span className="text-success tabular-nums">{summary.wins}W</span>
      <span aria-hidden className="text-text-dim">
        ·
      </span>
      <span className="text-danger tabular-nums">{summary.losses}L</span>
      {hasSpatial ? (
        <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
          spatial extracts ready
        </span>
      ) : (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
            no spatial extracts on this map yet
          </span>
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          >
            {recomputing ? "Requesting…" : "Request resync"}
          </Button>
        </div>
      )}
    </div>
  );
}

function LayerTabs({
  current,
  onChange,
}: {
  current: LayerKey;
  onChange: (key: LayerKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Heatmap layers"
      className="flex flex-wrap gap-1.5 overflow-x-auto pb-1"
    >
      {LAYERS.map((l) => {
        const active = current === l.key;
        return (
          <button
            key={l.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="heatmap-canvas"
            onClick={() => onChange(l.key)}
            title={l.hint}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs whitespace-nowrap transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              active
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-bg-elevated text-text-muted hover:bg-bg-elevated/70 hover:text-text",
            ].join(" ")}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: l.color }}
            />
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

function HeatmapCanvas({
  mapName,
  layerColor,
  layerLabel,
  cells,
  grid,
  isLoading,
  hasCells,
  hasSpatial,
  imageError,
  onImageError,
  onRecompute,
  recomputing,
}: {
  mapName: string;
  layerColor: string;
  layerLabel: string;
  cells: HeatCell[] | undefined;
  grid: number;
  isLoading: boolean;
  hasCells: boolean;
  hasSpatial: boolean;
  imageError: boolean;
  onImageError: () => void;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <div
      id="heatmap-canvas"
      role="tabpanel"
      className="relative aspect-square w-full max-h-[55vh] overflow-hidden rounded-lg border border-border bg-bg-elevated sm:aspect-[4/3]"
    >
      {imageError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-elevated text-text-muted">
          <ImageOff className="h-8 w-8 text-text-dim" aria-hidden />
          <span className="text-caption">
            {mapName} minimap unavailable
          </span>
        </div>
      ) : (
        <img
          src={`${API_BASE}/v1/map-image?map=${encodeURIComponent(mapName)}`}
          alt={`${mapName} minimap`}
          className="absolute inset-0 h-full w-full object-cover opacity-50"
          onError={onImageError}
        />
      )}

      {isLoading ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-bg/30 backdrop-blur-[1px]"
          aria-live="polite"
        >
          <span className="rounded-md bg-bg-elevated/90 px-3 py-1.5 text-caption text-text-muted">
            Loading {layerLabel.toLowerCase()}…
          </span>
        </div>
      ) : hasCells ? (
        <HeatmapOverlay cells={cells!} grid={grid} color={layerColor} />
      ) : (
        <NoSamplesOverlay
          layerLabel={layerLabel}
          hasSpatial={hasSpatial}
          onRecompute={onRecompute}
          recomputing={recomputing}
        />
      )}
    </div>
  );
}

function NoSamplesOverlay({
  layerLabel,
  hasSpatial,
  onRecompute,
  recomputing,
}: {
  layerLabel: string;
  hasSpatial: boolean;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="max-w-sm rounded-lg bg-bg-surface/90 p-4 text-center shadow-[var(--shadow-card)] ring-1 ring-border backdrop-blur supports-[backdrop-filter]:bg-bg-surface/75">
        <div className="text-caption font-semibold text-text">
          No {layerLabel.toLowerCase()} on this map yet
        </div>
        <p className="mt-1 text-[12px] text-text-muted">
          {hasSpatial
            ? "Other layers may have data. Try the toggles above, or play a few more games on this map."
            : "Your agent hasn't extracted spatial data here yet. Request a resync to backfill."}
        </p>
        {!hasSpatial ? (
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
            className="mt-3"
          >
            {recomputing ? "Requesting…" : "Request resync"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LegendBar({
  hint,
  points,
  grid,
}: {
  hint: string;
  points: number;
  grid: number;
}) {
  const sampleLabel = `${points.toLocaleString()} sample${points === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-dim">
      <span>
        {hint} · {sampleLabel}
      </span>
      <span className="font-mono">
        grid {grid}×{grid}
      </span>
    </div>
  );
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
  // Cell radius scales inversely with grid density so a 64×64 grid
  // gets crisp dots and a 128×128 grid still shows readable density
  // without overlapping into mush.
  const radius = Math.max(0.55, 64 / grid);
  return (
    <svg
      viewBox={`0 0 ${grid} ${grid}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${cells.length} heatmap cells`}
      className="absolute inset-0 h-full w-full"
    >
      <defs>
        <radialGradient id={`heat-${color.slice(1)}`}>
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="60%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>
      {cells.map((c, i) => {
        const a = clamp01(c.intensity);
        if (a <= 0) return null;
        return (
          <circle
            key={`${c.x}-${c.y}-${i}`}
            cx={c.x + 0.5}
            cy={c.y + 0.5}
            r={radius * (0.9 + a * 0.6)}
            fill={`url(#heat-${color.slice(1)})`}
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
