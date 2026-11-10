"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * MapIntelPanel — where things happen on one map, from the owner's own games.
 *
 * One heat layer at a time over the map's top-down layout: their proxies,
 * fights, fights you lost, or your buildings. The layout image is stretched
 * to the playable bounds and the canvas covers the same box, so heat and
 * terrain share MapReplayer's mapping (lib/mapIntel.ts). Every number the
 * heat shows is also text: the sample caption ("Fights in 12 of 37 analysed
 * games"), a legend with words, and the top hot zones as a numbered list
 * that matches the numbered rings on the map. Below the layer's minimum
 * sample the heat is withheld and the count is shown instead.
 *
 * Private: the API reads only the signed-in owner's games.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { getMapLayoutUrl } from "@/lib/map-images";
import { QueryState } from "@/components/ui/QueryState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import {
  MAP_INTEL_LAYERS,
  belowMinimumText,
  cellRect,
  heatAlpha,
  layerForKind,
  mapIntelLayer,
  mapIntelPath,
  sampleCaption,
  stageAspect,
  worldToStage,
  zoneDetail,
  zoneLabel,
  type MapIntelLayer,
  type MapIntelResponse,
} from "@/lib/mapIntel";

type OppRace = "all" | "P" | "T" | "Z";

const RACE_OPTIONS: ReadonlyArray<{ value: OppRace; label: string; ariaLabel?: string }> = [
  { value: "all", label: "All" },
  { value: "P", label: "vs P", ariaLabel: "Versus Protoss" },
  { value: "T", label: "vs T", ariaLabel: "Versus Terran" },
  { value: "Z", label: "vs Z", ariaLabel: "Versus Zerg" },
];

export interface MapIntelPanelProps {
  /** Map name: the API's map and the layout image. */
  map: string;
  /** Exact edition names grouped under this map. */
  aliases?: readonly string[];
  /** The page's filter query string ("?since=…"). */
  filterQuery?: string;
  /** Data revision; a new value refetches. */
  dbRev?: number;
  /** A dossier opponent: only their games. */
  opponent?: { pulseId: string; mergeLinked?: boolean } | null;
  /** Layers offered, in order. Defaults to all four. */
  layers?: readonly MapIntelLayer[];
  /** Show the opponent-race control (map-wide view). */
  matchupControl?: boolean;
}

export function MapIntelPanel({ map, aliases, filterQuery, dbRev = 0, opponent = null, layers, matchupControl = false }: MapIntelPanelProps) {
  const offered = layers?.length ? MAP_INTEL_LAYERS.filter((spec) => layers.includes(spec.id)) : MAP_INTEL_LAYERS;
  const [layer, setLayer] = useState<MapIntelLayer>(offered[0].id);
  const [oppRace, setOppRace] = useState<OppRace>("all");
  const [opacity, setOpacity] = useState(80);
  const ids = useId();
  const path = mapIntelPath(layer, map, {
    aliases,
    filterQuery,
    opponent: opponent?.pulseId,
    mergeLinked: opponent?.mergeLinked,
    oppRace: oppRace === "all" ? null : oppRace,
  });
  const intel = useApi<MapIntelResponse>(`${path}#${dbRev}`, { keepPreviousData: true, revalidateOnFocus: false });
  const spec = mapIntelLayer(layer);

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <span id={`${ids}-layer`} className="text-micro font-semibold uppercase tracking-wider text-text-dim">Layer</span>
        <SegmentedControl labelledBy={`${ids}-layer`} value={layer} onChange={setLayer}
          options={offered.map((option) => ({ value: option.id, label: option.label }))} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        {matchupControl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span id={`${ids}-race`} className="text-micro font-semibold uppercase tracking-wider text-text-dim">Opponent race</span>
            <SegmentedControl labelledBy={`${ids}-race`} value={oppRace} onChange={setOppRace} options={RACE_OPTIONS} />
          </div>
        ) : null}
        <label className="flex min-h-11 items-center gap-3 text-caption text-text-muted">
          Heat opacity
          <input type="range" min={20} max={100} step={10} value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
            aria-valuetext={`${opacity}%`}
            className="h-11 w-36 accent-[rgb(var(--accent))]" />
          <span className="w-10 tabular-nums text-text">{opacity}%</span>
        </label>
      </div>
      <p className="text-caption text-text-muted">{spec.description}</p>
      <QueryState q={intel} skeleton={<SkeletonRows rows={5} label="Loading map intel" />}
        isEmpty={(data) => data.scanned === 0 || !data.bounds}
        empty={<NoSpatialData />}>
        {(data, { isPreviousData }) => (
          <IntelView data={data} map={map} layer={layer} opacity={opacity / 100} stale={isPreviousData} />
        )}
      </QueryState>
    </div>
  );
}

function NoSpatialData() {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border p-4 text-caption text-text-muted">
      <p className="font-medium text-text">No spatial data for this map yet — re-analyze in the desktop app</p>
      <p className="mt-1">Map positions come from replays the desktop app analyzed. <LazyHelpLink slug="map-intel" anchor="empty-maps">Why a map is empty</LazyHelpLink></p>
    </div>
  );
}

function IntelView({ data, map, layer: requested, opacity, stale }: { data: MapIntelResponse; map: string; layer: MapIntelLayer; opacity: number; stale: boolean }) {
  const bounds = data.bounds!;
  // While another layer loads, the previous answer keeps its own label and colour.
  const layer = layerForKind(data.kind) ?? requested;
  const spec = mapIntelLayer(layer);
  const zones = data.belowMinimum ? [] : data.zones;
  const caption = sampleCaption(data, layer);
  const aspect = stageAspect(bounds);
  return (
    <div className={`space-y-3 ${stale ? "opacity-60" : ""}`} aria-busy={stale || undefined}>
      <p className="text-caption font-medium text-text" aria-live="polite">{caption}</p>
      <MapStage data={data} map={map} rgb={spec.rgb} opacity={opacity} zones={zones} aspect={aspect}
        label={`${spec.label} on ${map}. ${caption}.${zones.length ? " The hot zones are listed below the map." : ""}`} />
      {data.belowMinimum ? (
        <p role="status" className="text-caption text-warning">{belowMinimumText(data, layer)}</p>
      ) : (
        <>
          <Legend label={spec.label} rgb={spec.rgb} />
          <ZoneList zones={zones} layer={layer} />
        </>
      )}
    </div>
  );
}

function MapStage({ data, map, rgb, opacity, zones, aspect, label }: {
  data: MapIntelResponse; map: string; rgb: readonly [number, number, number]; opacity: number;
  zones: MapIntelResponse["zones"]; aspect: number; label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutUrl = getMapLayoutUrl(map);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLayout = Boolean(layoutUrl && failedUrl !== layoutUrl);
  const bounds = data.bounds!;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawHeat(canvas, data.belowMinimum ? [] : data.cells, data.grid, rgb, opacity);
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [data, rgb, opacity]);

  return (
    <div className="space-y-1">
      <div role="img" aria-label={label}
        className="relative mx-auto overflow-hidden rounded-lg border border-border bg-black/80"
        style={{ aspectRatio: String(aspect), width: `min(100%, calc(68vh * ${aspect.toFixed(4)}))` }}>
        {showLayout ? (
          <img src={layoutUrl!} alt="" aria-hidden loading="lazy" decoding="async"
            className="absolute inset-0 h-full w-full object-fill"
            onError={() => setFailedUrl(layoutUrl)} />
        ) : null}
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
        {zones.map((zone, index) => {
          const at = worldToStage(bounds, 100, 100, zone.x, zone.y);
          return (
            <span key={`${zone.x}:${zone.y}`} aria-hidden
              className="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/75 text-micro font-bold text-white ring-2 ring-white"
              style={{ left: `${at.left}%`, top: `${at.top}%` }}>
              {index + 1}
            </span>
          );
        })}
      </div>
      {!showLayout ? <p className="text-micro text-text-dim">Map picture unavailable; positions are still drawn to scale.</p> : null}
    </div>
  );
}

function Legend({ label, rgb }: { label: string; rgb: readonly [number, number, number] }) {
  const color = rgb.join(", ");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
      <span className="font-semibold text-text">{label}:</span>
      <span>fewer</span>
      <span aria-hidden className="h-2.5 w-24 rounded-full ring-1 ring-border"
        style={{ background: `linear-gradient(to right, rgba(${color}, 0.18), rgba(${color}, 1))` }} />
      <span>more</span>
      <span>· Numbered rings match the hot zones below.</span>
    </div>
  );
}

function ZoneList({ zones, layer }: { zones: MapIntelResponse["zones"]; layer: MapIntelLayer }) {
  if (zones.length === 0) return null;
  return (
    <div>
      <p className="text-caption font-semibold text-text" aria-hidden>Top hot zones</p>
      <ol className="mt-1 space-y-1" aria-label={`Top ${zones.length} hot zones, ${mapIntelLayer(layer).label.toLowerCase()}`}>
        {zones.map((zone, index) => (
          <li key={`${zone.x}:${zone.y}`} className="flex items-baseline gap-2 text-caption">
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-bg-elevated text-micro font-bold text-text">{index + 1}</span>
            <span className="min-w-0 flex-1 text-text">{zoneLabel(zone)}</span>
            <span className="shrink-0 tabular-nums text-text-muted">{zoneDetail(zone)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Soft cells over a canvas that covers the stage at device resolution. */
function drawHeat(canvas: HTMLCanvasElement, cells: MapIntelResponse["cells"], grid: number, rgb: readonly [number, number, number], opacity: number) {
  const box = canvas.getBoundingClientRect();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const width = Math.max(1, Math.round(box.width * dpr));
  const height = Math.max(1, Math.round(box.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const color = rgb.join(", ");
  for (const cell of cells) {
    const rect = cellRect(cell, grid, width, height);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.max(rect.width, rect.height) * 1.5;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, `rgba(${color}, ${heatAlpha(cell.intensity, opacity)})`);
    gradient.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
}
