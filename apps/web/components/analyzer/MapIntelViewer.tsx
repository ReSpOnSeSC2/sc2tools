"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ImageOff, RefreshCcw, RotateCw } from "lucide-react";
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
  emptyHint: string;
  color: string;
}> = [
  {
    key: "proxy",
    label: "My proxies",
    hint: "Where you forward-base",
    emptyHint:
      "No forward-base structures detected on this map yet. Proxies are buildings placed near the opponent's main; play a few aggressive openers and they'll show up here.",
    color: "#7c8cff",
  },
  {
    key: "opponent-proxies",
    label: "Opp. proxies",
    hint: "Where they proxy on you",
    emptyHint:
      "No opponent proxies detected on this map. This usually means opponents have been macro-only against you here — switch to Battles or Buildings to see other patterns.",
    color: "#ff8a3d",
  },
  {
    key: "battle",
    label: "Battles",
    hint: "Large engagements",
    emptyHint:
      "No engagements clustered tightly enough to mark on this map. Try long macro games — single-fight cheeses don't always meet the engagement threshold.",
    color: "#3ec07a",
  },
  {
    key: "death-zone",
    label: "Death zones",
    hint: "Where your army dies",
    emptyHint:
      "No standout death zones — either your wins outnumber the losses on this map, or the engagements were balanced enough that no zone surfaced as costly.",
    color: "#ff6b6b",
  },
  {
    key: "buildings",
    label: "Buildings",
    hint: "Your placed structures",
    emptyHint:
      "No building placements extracted yet on this map. Buildings need a deep parse — request a resync to backfill them.",
    color: "#a78bfa",
  },
];

type LayerKey = (typeof LAYERS)[number]["key"];

// After a successful resync, the agent typically re-uploads within a
// few minutes. Auto-revalidate the heatmap on a gentle cadence so the
// user sees data appear without having to refresh the page. Capped at
// MAX_AUTO_REFRESHES so we don't poll forever on stale tabs.
const AUTO_REFRESH_INTERVAL_MS = 12_000;
const MAX_AUTO_REFRESHES = 12;

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
 * After a "Request resync" the viewer auto-polls /v1/spatial/* on a
 * 12 s cadence (up to MAX_AUTO_REFRESHES) so newly-uploaded extracts
 * surface without the user having to reload the page. The polling
 * stops the moment data lands or the user navigates away.
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
  const [recomputeTone, setRecomputeTone] = useState<"info" | "error">("info");
  const [imageError, setImageError] = useState(false);
  // Cache-buster suffix bumped manually whenever we want SWR to drop
  // its cached heatmap and re-issue. Two triggers feed into it: the
  // user-clicked Refresh button and the post-resync auto-revalidator.
  const [refreshTick, setRefreshTick] = useState(0);
  const params = filtersToQuery({ ...filters, map: mapName });
  const cacheKey = `${dbRev}-${mapName}-${refreshTick}`;

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

  const hasSpatial = !!summary?.hasSpatial;
  const hasCells = !!cells && cells.length > 0;

  // Auto-revalidate after a Request resync so the user doesn't have to
  // refresh the page when the agent finishes re-uploading. The poller
  // bumps refreshTick on a fixed cadence (forcing SWR to refetch)
  // until either the heatmap returns cells or we hit MAX_AUTO_REFRESHES.
  // Cleanup runs on unmount, on a successful data arrival, and when
  // `recomputing` toggles — so a second Request resync resets the timer.
  const pollerRef = useRef<{ tickCount: number; intervalId: number } | null>(
    null,
  );
  useEffect(() => {
    if (recomputing) return;
    if (!recomputeMsg || recomputeTone !== "info") return;
    if (hasCells || hasSpatial) {
      // Data already arrived — clear the message so the user knows the
      // resync worked, and stop any in-flight poller.
      if (pollerRef.current) {
        window.clearInterval(pollerRef.current.intervalId);
        pollerRef.current = null;
      }
      return;
    }
    if (pollerRef.current) return; // already polling
    const id = window.setInterval(() => {
      const cur = pollerRef.current;
      if (!cur) return;
      cur.tickCount += 1;
      setRefreshTick((t) => t + 1);
      if (cur.tickCount >= MAX_AUTO_REFRESHES) {
        window.clearInterval(cur.intervalId);
        pollerRef.current = null;
      }
    }, AUTO_REFRESH_INTERVAL_MS);
    pollerRef.current = { tickCount: 0, intervalId: id };
    return () => {
      if (pollerRef.current) {
        window.clearInterval(pollerRef.current.intervalId);
        pollerRef.current = null;
      }
    };
  }, [recomputing, recomputeMsg, recomputeTone, hasCells, hasSpatial]);

  const requestRecompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputing(true);
    setRecomputeMsg(null);
    setRecomputeTone("info");
    try {
      // Force=true backfill on the macro service. The cloud also emits
      // a dedicated `resync:request` socket event in the same handler
      // (see services/perGameCompute.js), so agents whose
      // ``path_by_game_id`` index is empty (e.g. uploaded before that
      // index was added) still pick the request up and run a full
      // re-upload sweep — which produces the spatial extracts.
      await apiCall<{ ok: boolean }>(
        getToken,
        "/v1/macro/backfill/start",
        {
          method: "POST",
          body: JSON.stringify({
            force: true,
            reason: "map_intel_request_resync",
          }),
        },
      );
      setRecomputeMsg(
        "Resync requested. Your agent will re-parse replays and upload spatial extracts — heatmaps will populate here automatically as data arrives (usually within a few minutes).",
      );
      setRecomputeTone("info");
      // Reset the poller — the effect above re-arms because
      // refreshTick changes invalidate the cache and recomputing
      // flips back to false a tick later.
      setRefreshTick((t) => t + 1);
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(
        e?.message ||
          "Couldn't request a resync. Check that your desktop agent is running and try again.",
      );
      setRecomputeTone("error");
    } finally {
      window.setTimeout(() => setRecomputing(false), 1500);
    }
  }, [getToken, recomputing]);

  const handleRefresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  const body = (
    <div className="space-y-3">
      <SummaryRow
        summary={summary}
        hasSpatial={hasSpatial}
        recomputing={recomputing}
        onRecompute={requestRecompute}
        onRefresh={handleRefresh}
        isLoading={isLoading}
      />

      {recomputeMsg ? (
        <p
          role="status"
          className={[
            "rounded-lg border px-3 py-2 text-caption",
            recomputeTone === "error"
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-border bg-bg-elevated/40 text-text-muted",
          ].join(" ")}
        >
          {recomputeMsg}
        </p>
      ) : null}

      <LayerTabs current={layer} onChange={setLayer} />

      <HeatmapCanvas
        mapName={mapName}
        layer={layer}
        layerColor={layerMeta.color}
        layerLabel={layerMeta.label}
        layerEmptyHint={layerMeta.emptyHint}
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
        color={layerMeta.color}
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
  onRefresh,
  isLoading,
}: {
  summary: MapEntry | null;
  hasSpatial: boolean;
  recomputing: boolean;
  onRecompute: () => void;
  onRefresh: () => void;
  isLoading: boolean;
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

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {hasSpatial ? (
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
            spatial extracts ready
          </span>
        ) : (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
            no spatial extracts on this map yet
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          iconLeft={<RotateCw className="h-3.5 w-3.5" aria-hidden />}
          title="Refresh heatmap data"
        >
          Refresh
        </Button>
        <Button
          variant={hasSpatial ? "ghost" : "secondary"}
          size="sm"
          loading={recomputing}
          onClick={onRecompute}
          iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          title={
            hasSpatial
              ? "Re-extract spatial data from your replays"
              : "Ask your agent to extract spatial data from your replay history"
          }
        >
          {recomputing
            ? "Requesting…"
            : hasSpatial
              ? "Re-extract"
              : "Request resync"}
        </Button>
      </div>
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
              style={{ background: l.color, boxShadow: `0 0 4px ${l.color}` }}
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
  layer,
  layerColor,
  layerLabel,
  layerEmptyHint,
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
  layer: LayerKey;
  layerColor: string;
  layerLabel: string;
  layerEmptyHint: string;
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
          <span className="text-caption">{mapName} minimap unavailable</span>
        </div>
      ) : (
        <img
          src={`${API_BASE}/v1/map-image?map=${encodeURIComponent(mapName)}`}
          alt={`${mapName} minimap`}
          className="absolute inset-0 h-full w-full object-cover opacity-50"
          onError={onImageError}
        />
      )}

      {/* Subtle vignette ring keeps the heatmap punchy near the edges
          even on light minimaps. Pure CSS, no extra DOM cost. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [box-shadow:inset_0_0_60px_rgba(0,0,0,0.45)]"
      />

      {isLoading ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-bg/40 backdrop-blur-[1px]"
          aria-live="polite"
        >
          <span className="rounded-md bg-bg-elevated/90 px-3 py-1.5 text-caption text-text-muted">
            Loading {layerLabel.toLowerCase()}…
          </span>
        </div>
      ) : hasCells ? (
        <HeatmapOverlay
          cells={cells!}
          grid={grid}
          color={layerColor}
          layerKey={layer}
        />
      ) : (
        <NoSamplesOverlay
          layerLabel={layerLabel}
          layerEmptyHint={layerEmptyHint}
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
  layerEmptyHint,
  hasSpatial,
  onRecompute,
  recomputing,
}: {
  layerLabel: string;
  layerEmptyHint: string;
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
          {hasSpatial ? layerEmptyHint : (
            <>
              Your agent hasn&apos;t extracted spatial data on this map yet.
              Click <span className="text-text">Request resync</span> below
              and the agent will re-parse your replay history with the
              latest extractor.
            </>
          )}
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
  color,
}: {
  hint: string;
  points: number;
  grid: number;
  color: string;
}) {
  const sampleLabel = `${points.toLocaleString()} sample${points === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-dim">
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 4px ${color}` }}
        />
        {hint} · {sampleLabel}
      </span>
      <span className="font-mono">
        grid {grid}×{grid}
      </span>
    </div>
  );
}

/**
 * Render the heatmap cells as soft radial dots. We use SVG so the
 * dots scale with the container and stay crisp on every device pixel
 * ratio, plus they composite cleanly on top of the minimap image
 * with `mix-blend-mode: screen` (warmer, additive look that survives
 * dark map backgrounds).
 *
 * The radius scales inversely with grid density so a 64×64 grid gets
 * a punchy dot and a 128×128 grid still shows readable density
 * without overlapping into mush. Opacity also scales with cell
 * intensity so the densest clusters stand out against the noise.
 */
function HeatmapOverlay({
  cells,
  grid,
  color,
  layerKey,
}: {
  cells: HeatCell[];
  grid: number;
  color: string;
  layerKey: LayerKey;
}) {
  // Per-layer gradient ID. Stable across renders so React doesn't
  // churn the <defs>; unique per layer so two viewers on the same
  // page can't share a gradient by colour-hash collision.
  const gradientId = `heat-${layerKey}`;
  const radius = Math.max(0.55, 64 / grid);
  return (
    <svg
      viewBox={`0 0 ${grid} ${grid}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${cells.length} ${layerKey} heatmap cells`}
      className="absolute inset-0 h-full w-full mix-blend-screen"
    >
      <defs>
        <radialGradient id={gradientId}>
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="55%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>
      {cells.map((c, i) => {
        const a = clamp01(c.intensity);
        if (a <= 0) return null;
        // Radius punches up with intensity. Opacity also scales so
        // a low-intensity outlier doesn't read as solidly as a hot
        // cluster — same energy as the legacy SPA's KDE rendering.
        const r = radius * (0.85 + a * 0.7);
        const opacity = 0.35 + a * 0.65;
        return (
          <circle
            key={`${c.x}-${c.y}-${i}`}
            cx={c.x + 0.5}
            cy={c.y + 0.5}
            r={r}
            fill={`url(#${gradientId})`}
            opacity={opacity}
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
