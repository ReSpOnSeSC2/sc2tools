"use client";

/**
 * MapReplayer — vespene.gg-style playback of one game on its map.
 *
 * Renders the agent-uploaded playback payload (unit waypoint tracks,
 * building placements, battle markers, spawns, per-side stats) on a
 * canvas with a scrubbable timeline: play/pause, 1×–16× speed, and a
 * live HUD (army value · workers · supply per side). The real map
 * layout render (``/v1/map-image?variant=layout``) draws under the
 * action, stretched to the playable bounds; buildings and units both
 * render as bare team-tinted icon art (no ring, box, or backing —
 * the art reads directly, washed toward the owner color), workers
 * presented on their hall's mineral-line arc while idle —
 * with deterministic cluster spreading so a stacked army reads as a
 * blob of distinguishable icons instead of one pixel (see
 * ``spreadClusters`` in lib/mapReplay.ts). Both layers degrade
 * gracefully: no layout render → flat dark background, no icon for a
 * name → the original dot/square marker.
 *
 * Colors: the streamer is cyan, the opponent red; workers dim, army
 * bright; battles pulse amber around their marker time. All real
 * data — games uploaded by agents without playback support show a
 * "re-sync" hint instead of an empty canvas (the parent handles the
 * 404 by not rendering this at all).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildingAliveAt,
  buildingPositionAt,
  isTownHall,
  isWorkerUnit,
  MINING_SNAP_RADIUS,
  miningArcPosition,
  nearestTownHall,
  patchesNearHall,
  patchMiningPosition,
  resourceAliveAt,
  projectX,
  projectY,
  spreadClusters,
  statsAt,
  unitAliveAt,
  unitMaxSpeed,
  unitPositionAt,
  worldProjection,
  type MapPlayback,
} from "@/lib/mapReplay";
import { getMapLayoutUrl } from "@/lib/map-images";
import { getIconPath, type IconKind } from "@/lib/sc2-icons";

const SPEEDS = [1, 4, 8, 16] as const;
const ME_ARMY = "#3ec0c7";
const ME_WORKER = "rgba(62,192,199,0.45)";
const OPP_ARMY = "#e05656";
const OPP_WORKER = "rgba(224,86,86,0.45)";
const BATTLE = "#e6b450";
/** How long a battle marker pulses around its timestamp. */
const BATTLE_WINDOW_SEC = 12;
/** Cluster cell + spacing in canvas px — the unit-spacing tuning.
 * Spacing is sized to the army icon (units overlap about half an icon
 * inside a cluster: dense enough to read as one army, loose enough to
 * count heads). */
const CLUSTER_CELL_PX = 10;
const CLUSTER_SPACING_PX = 6.5;
/** Marker sizes in canvas px. */
const ARMY_ICON_PX = 13;
const WORKER_ICON_PX = 9;
const BUILDING_ICON_PX = 13;
const TOWNHALL_ICON_PX = 19;
/** Canvas height ceiling — high enough that a square map fills the
 * column width instead of letterboxing (the "zoom"). */
const CANVAS_MAX_H_PX = 720;
/** Dark veil over the layout render so the cyan/red overlay language
 * stays readable on busy map art. */
const LAYOUT_VEIL = "rgba(6,9,14,0.42)";

/* ──────────────── icon + layout image caches ────────────────
 *
 * Module-level so every replayer instance (game page + macro
 * drilldown) shares one decoded image per icon. ``null`` marks a
 * failed load; entries are only drawn once fully decoded, so a frame
 * rendered before an icon arrives falls back to the dot/square marker
 * and picks the icon up on a later frame.
 */

const iconElementCache = new Map<string, HTMLImageElement | null>();
/** Memoized ``getIconPath`` — name→path resolution does string
 * normalization, too hot to repeat per marker per rAF frame. */
const iconPathCache = new Map<string, string | null>();
/** Bumped whenever an icon or layout render finishes (or fails)
 * loading. The draw loop uses it as a dirty flag so a PAUSED replay
 * stops re-rendering every frame — a real battery cost on mobile —
 * while still picking up late-decoding assets. */
let assetsVersion = 0;

function resolveIconPath(name: string, kind: IconKind): string | null {
  const key = `${kind}:${name}`;
  let path = iconPathCache.get(key);
  if (path === undefined) {
    path = getIconPath(name, kind);
    iconPathCache.set(key, path);
  }
  return path;
}

function readyIcon(name: string, kind: IconKind): HTMLImageElement | null {
  const path = resolveIconPath(name, kind);
  if (!path) return null;
  let img = iconElementCache.get(path);
  if (img === undefined) {
    if (typeof Image === "undefined") return null; // non-DOM test envs
    img = new Image();
    img.decoding = "async";
    img.onload = () => {
      assetsVersion += 1;
    };
    img.onerror = () => {
      iconElementCache.set(path, null);
      assetsVersion += 1;
    };
    img.src = path;
    iconElementCache.set(path, img);
  }
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/** Team-tinted unit icons — the bare unit art (the PNGs carry real
 * transparency) washed toward the owner color via source-atop, with
 * no ring, box, or backing shape around it. Pre-rendered once per
 * (icon, tint, size, dpr) so the rAF loop draws one cached bitmap
 * per unit. */
const unitTokenCache = new Map<string, HTMLCanvasElement>();
/** How strongly the owner color washes the icon art. High enough to
 * read the side at a glance, low enough that the unit stays
 * recognizable. */
const TINT_ALPHA = 0.42;

function iconToken(
  name: string,
  kind: IconKind,
  tint: string,
  sizePx: number,
  dpr: number,
): HTMLCanvasElement | null {
  const icon = readyIcon(name, kind);
  if (!icon) return null;
  const path = resolveIconPath(name, kind);
  const key = `${path}|${tint}|${sizePx}|${dpr}`;
  const cached = unitTokenCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sizePx * dpr));
  c.height = c.width;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);
  g.drawImage(icon, 0, 0, sizePx, sizePx);
  // source-atop confines the fill to the icon's own alpha, so only
  // the unit art itself takes the team color.
  g.globalCompositeOperation = "source-atop";
  g.globalAlpha = TINT_ALPHA;
  g.fillStyle = tint;
  g.fillRect(0, 0, sizePx, sizePx);
  unitTokenCache.set(key, c);
  return c;
}

export function MapReplayer({ playback }: { playback: MapPlayback }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(8);
  const [timeSec, setTimeSec] = useState(0);
  // Refs mirror the interactive state so the rAF loop never re-binds.
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef<number>(8);
  playingRef.current = playing;
  speedRef.current = speed;

  const gameLength = Math.max(1, playback.gameLength);
  // Real map layout render, drawn under the action once loaded. Loaded
  // WITHOUT crossOrigin: the map-image route guarantees embedding via
  // CORP but CORS depends on deployment allowlists, and a tainted
  // canvas costs nothing here (this canvas is never exported). On any
  // load failure the ref stays null and the flat background shows.
  const layoutImageRef = useRef<HTMLImageElement | null>(null);
  // Zoom/pan view transform (canvas CSS px). z=1 shows the whole map;
  // wheel/pinch zooms toward the pointer, drag pans, buttons/dblclick
  // reset. Held in a ref so the rAF loop reads it without re-binding.
  const viewRef = useRef({ z: 1, ox: 0, oy: 0 });

  const applyZoom = useCallback((cx: number, cy: number, factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = viewRef.current;
    const z = Math.min(8, Math.max(1, v.z * factor));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Keep the scene point under (cx, cy) fixed while scaling.
    let ox = cx - ((cx - v.ox) / v.z) * z;
    let oy = cy - ((cy - v.oy) / v.z) * z;
    ox = Math.min(0, Math.max(w - w * z, ox));
    oy = Math.min(0, Math.max(h - h * z, oy));
    viewRef.current = { z, ox, oy };
  }, []);

  const resetView = useCallback(() => {
    viewRef.current = { z: 1, ox: 0, oy: 0 };
  }, []);

  useEffect(() => {
    layoutImageRef.current = null;
    const url = getMapLayoutUrl(playback.mapName);
    if (!url || typeof Image === "undefined") return;
    let cancelled = false;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (!cancelled) {
        layoutImageRef.current = img;
        assetsVersion += 1;
      }
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [playback.mapName]);

  const setTime = useCallback(
    (t: number) => {
      const clamped = Math.min(gameLength, Math.max(0, t));
      timeRef.current = clamped;
      setTimeSec(clamped);
    },
    [gameLength],
  );

  // Playback clock + draw loop. One rAF loop for the lifetime of the
  // component; drawing reads refs so scrubbing while paused re-renders
  // through the same path.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // non-canvas environments (tests) keep controls only
    let raf = 0;
    let lastTs: number | null = null;
    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (lastTs !== null && playingRef.current) {
        const dt = ((ts - lastTs) / 1000) * speedRef.current;
        const next = timeRef.current + dt;
        if (next >= gameLength) {
          timeRef.current = gameLength;
          setTimeSec(gameLength);
          setPlaying(false);
        } else {
          timeRef.current = next;
          // Throttle React state to ~4 Hz — the canvas doesn't need it,
          // only the time label / scrubber do.
          if (Math.abs(next - lastReactSync) > 0.25) {
            lastReactSync = next;
            setTimeSec(next);
          }
        }
      }
      lastTs = ts;
      // Dirty-check: a paused replay re-renders only when the scrub
      // time, canvas size, or asset readiness actually changed —
      // otherwise a static frame would burn battery at 60 fps.
      const view = viewRef.current;
      const dirty =
        playingRef.current ||
        timeRef.current !== drawn.t ||
        assetsVersion !== drawn.v ||
        canvas.width !== drawn.cw ||
        canvas.height !== drawn.ch ||
        view.z !== drawn.z ||
        view.ox !== drawn.ox ||
        view.oy !== drawn.oy;
      if (dirty) {
        renderFrame(ctx, canvas, playback, timeRef.current, layoutImageRef.current, view);
        drawn = {
          t: timeRef.current,
          v: assetsVersion,
          cw: canvas.width,
          ch: canvas.height,
          z: view.z,
          ox: view.ox,
          oy: view.oy,
        };
      }
    };
    let lastReactSync = -1;
    let drawn = { t: -1, v: -1, cw: 0, ch: 0, z: 1, ox: 0, oy: 0 };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playback, gameLength]);

  // Resize the canvas bitmap to its CSS box (device-pixel aware).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const apply = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const aspect =
        (playback.bounds.maxY - playback.bounds.minY) /
        (playback.bounds.maxX - playback.bounds.minX);
      const w = Math.max(280, rect.width);
      const h = Math.max(220, Math.min(CANVAS_MAX_H_PX, w * aspect));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    apply();
    const obs =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    obs?.observe(wrap);
    return () => obs?.disconnect();
  }, [playback]);

  // Wheel zoom, drag pan, and two-pointer pinch. Native listeners so
  // wheel can preventDefault (React's is passive), pointer capture so
  // drags keep tracking outside the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;

    const local = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = local(e);
      applyZoom(pt.x, pt.y, Math.pow(1.0015, -e.deltaY));
    };
    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, local(e));
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const now = local(e);
      pointers.set(e.pointerId, now);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          applyZoom((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
        }
        pinchDist = dist;
        return;
      }
      const v = viewRef.current;
      if (v.z <= 1) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      viewRef.current = {
        z: v.z,
        ox: Math.min(0, Math.max(w - w * v.z, v.ox + (now.x - prev.x))),
        oy: Math.min(0, Math.max(h - h * v.z, v.oy + (now.y - prev.y))),
      };
    };
    const onPointerEnd = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    const onDblClick = () => resetView();

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("dblclick", onDblClick);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerEnd);
      canvas.removeEventListener("pointercancel", onPointerEnd);
      canvas.removeEventListener("dblclick", onDblClick);
    };
  }, [applyZoom, resetView]);

  const me = useMemo(() => statsAt(playback.stats.me, timeSec), [playback, timeSec]);
  const opp = useMemo(() => statsAt(playback.stats.opp, timeSec), [playback, timeSec]);

  return (
    <div className="space-y-2" data-testid="map-replayer">
      <div className="flex flex-wrap items-center gap-2">
        {/* Fixed width so ▶ Play / ❚❚ Pause toggling never shifts the
            row; taller touch targets below the sm breakpoint. */}
        <button
          type="button"
          onClick={() => {
            if (!playing && timeRef.current >= gameLength) setTime(0);
            setPlaying((p) => !p);
          }}
          className="inline-flex min-w-[5.5rem] items-center justify-center rounded-md border border-border bg-bg-elevated px-3 py-2 text-caption font-semibold text-text hover:border-accent sm:py-1"
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <div
          role="group"
          aria-label="Playback speed"
          className="flex items-center gap-1"
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`min-w-[2.5rem] rounded-md border px-2 py-2 text-micro font-semibold sm:min-w-0 sm:py-1 ${
                speed === s
                  ? "border-accent bg-accent/15 text-text"
                  : "border-border bg-bg-elevated text-text-muted hover:border-accent"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <span className="ml-auto whitespace-nowrap text-caption tabular-nums text-text-muted">
          {formatTime(timeSec)} / {formatTime(gameLength)}
        </span>
      </div>

      <div ref={wrapRef} className="relative min-w-0">
        <canvas
          ref={canvasRef}
          className="block w-full touch-none rounded-lg border border-border bg-[#0a0d13]"
          aria-label={`Map playback of ${playback.mapName || "this game"}`}
        />
        <div className="absolute right-2 top-2 flex flex-col gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => {
              const c = canvasRef.current;
              if (c) applyZoom(c.clientWidth / 2, c.clientHeight / 2, 1.4);
            }}
            className="h-8 w-8 rounded-md border border-border bg-bg-elevated/90 text-body font-semibold text-text hover:border-accent"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => {
              const c = canvasRef.current;
              if (c) applyZoom(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.4);
            }}
            className="h-8 w-8 rounded-md border border-border bg-bg-elevated/90 text-body font-semibold text-text hover:border-accent"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset view"
            onClick={resetView}
            className="h-8 w-8 rounded-md border border-border bg-bg-elevated/90 text-caption font-semibold text-text hover:border-accent"
          >
            ⤢
          </button>
        </div>
      </div>

      {/* h-6 keeps the native range comfortably draggable on touch. */}
      <input
        type="range"
        min={0}
        max={Math.ceil(gameLength)}
        step={1}
        value={Math.round(timeSec)}
        onChange={(e) => setTime(Number(e.target.value))}
        aria-label="Playback position"
        aria-valuetext={`${formatTime(timeSec)} of ${formatTime(gameLength)}`}
        className="h-6 w-full cursor-pointer accent-[#3ec0c7]"
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-caption tabular-nums">
        <span className="whitespace-nowrap">
          <b style={{ color: ME_ARMY }}>You</b>{" "}
          <span className="text-text-muted">
            army {Math.round(me.army)} · {Math.round(me.workers)} workers ·{" "}
            {Math.round(me.supply)} supply
          </span>
        </span>
        <span className="whitespace-nowrap">
          <b style={{ color: OPP_ARMY }}>Opponent</b>{" "}
          <span className="text-text-muted">
            army {Math.round(opp.army)} · {Math.round(opp.workers)} workers ·{" "}
            {Math.round(opp.supply)} supply
          </span>
        </span>
      </div>
    </div>
  );
}

/* ──────────────── canvas frame ──────────────── */

/* ──────────────── resource glyphs + fog + derived data ──────────────── */

/** Procedural resource glyphs (mineral crystals, geysers, rocks,
 * towers) cached per (kind, dpr) — small enough to read at map scale,
 * matching the classic minimap language: blue crystals, green gas,
 * gray rocks. */
const glyphCache = new Map<string, HTMLCanvasElement>();

function resourceGlyph(kind: string, dpr: number): HTMLCanvasElement | null {
  const key = `${kind}|${dpr}`;
  const cached = glyphCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const S = 14;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(S * dpr));
  c.height = c.width;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);
  const diamond = (cx: number, cy: number, w: number, h: number, fill: string, top: string) => {
    g.beginPath();
    g.moveTo(cx, cy - h / 2);
    g.lineTo(cx + w / 2, cy);
    g.lineTo(cx, cy + h / 2);
    g.lineTo(cx - w / 2, cy);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.beginPath();
    g.moveTo(cx, cy - h / 2);
    g.lineTo(cx + w / 2, cy);
    g.lineTo(cx - w / 2, cy);
    g.closePath();
    g.fillStyle = top;
    g.fill();
  };
  if (kind === "minerals" || kind === "gold") {
    const base = kind === "gold" ? "#c9992e" : "#3f7fd6";
    const glint = kind === "gold" ? "#ffd97a" : "#9cc8ff";
    diamond(4.4, 8.6, 6, 8, base, glint);
    diamond(9.8, 8.2, 6.5, 9, base, glint);
    diamond(7, 5.4, 5, 6.5, base, glint);
  } else if (kind === "gas") {
    g.beginPath();
    g.ellipse(7, 8, 5.6, 4.2, 0, 0, Math.PI * 2);
    g.fillStyle = "#3a4a41";
    g.fill();
    g.beginPath();
    g.ellipse(7, 7.4, 3.1, 2.3, 0, 0, Math.PI * 2);
    g.fillStyle = "#57c785";
    g.fill();
    g.beginPath();
    g.ellipse(6.2, 6.8, 1.1, 0.8, 0, 0, Math.PI * 2);
    g.fillStyle = "#b6f0cd";
    g.fill();
  } else if (kind === "rocks") {
    g.beginPath();
    g.moveTo(2.5, 9.5);
    g.lineTo(4.5, 4.5);
    g.lineTo(8, 3.4);
    g.lineTo(11.6, 5.6);
    g.lineTo(11.2, 10);
    g.lineTo(6.5, 11.4);
    g.closePath();
    g.fillStyle = "#6e6a5e";
    g.fill();
    g.beginPath();
    g.moveTo(4.5, 4.5);
    g.lineTo(8, 3.4);
    g.lineTo(9.4, 6.8);
    g.lineTo(5.6, 7.6);
    g.closePath();
    g.fillStyle = "#8d887a";
    g.fill();
  } else {
    // Xel'Naga tower: watch ring.
    g.beginPath();
    g.arc(7, 7, 4.4, 0, Math.PI * 2);
    g.strokeStyle = "#cfcab2";
    g.lineWidth = 1.4;
    g.stroke();
    g.beginPath();
    g.arc(7, 7, 1.5, 0, Math.PI * 2);
    g.fillStyle = "#cfcab2";
    g.fill();
  }
  glyphCache.set(key, c);
  return c;
}

/** Per-payload derived data (worker type per side), cached weakly so
 * the rAF loop never rescans the unit list. */
const derivedCache = new WeakMap<
  MapPlayback,
  { workerName: Record<"me" | "opp", string | null> }
>();

function derivedOf(playback: MapPlayback) {
  let d = derivedCache.get(playback);
  if (!d) {
    const workerName: Record<"me" | "opp", string | null> = { me: null, opp: null };
    for (const u of playback.units) {
      if (!workerName[u.owner] && isWorkerUnit(u.name)) workerName[u.owner] = u.name;
      if (workerName.me && workerName.opp) break;
    }
    d = { workerName };
    derivedCache.set(playback, d);
  }
  return d;
}

/** How long after placement a builder worker is shown at the site.
 * SCVs construct the whole build; probes warp and leave; drones morph
 * INTO the building (no extra worker to show). */
function builderWindowSec(workerName: string | null): number {
  if (workerName === "SCV") return 17;
  if (workerName === "Drone") return 0;
  return 2.5;
}

/** Reusable offscreen fog canvas — resized on demand, redrawn each
 * rendered frame (the draw loop is already dirty-checked). */
let fogCanvas: HTMLCanvasElement | null = null;

const FOG_ALPHA = 0.5;
/** Sight radii in world cells, loosely matching in-game vision. */
const SIGHT_UNIT = 11;
const SIGHT_WORKER = 9;
const SIGHT_HALL = 13;
const SIGHT_BUILDING = 10;

interface ViewTransform {
  z: number;
  ox: number;
  oy: number;
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  playback: MapPlayback,
  t: number,
  layout: HTMLImageElement | null,
  view: ViewTransform,
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  // Icon/glyph bitmaps rasterize at a zoom-quantized density so they
  // stay crisp under the view transform instead of magnifying a 1x
  // raster. Power-of-two steps keep the token cache tiny (≤3 sizes).
  const rasterDpr =
    dpr * Math.min(4, Math.pow(2, Math.ceil(Math.log2(Math.max(1, view.z)))));
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const { bounds } = playback;
  // Tight padding: nearly every canvas pixel shows map.
  const proj = worldProjection(bounds, w, h, 4);

  ctx.clearRect(0, 0, w, h);
  // Zoom/pan: scale the whole scene (markers included — true zoom).
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.z, view.z);

  // Real map layout under everything, stretched to the projected
  // playable rect (the same rect all markers project into, so terrain
  // and unit positions share one coordinate mapping). A dark veil on
  // top keeps the side-color overlay readable on busy map art.
  if (layout) {
    const rectW = (bounds.maxX - bounds.minX) * proj.k;
    const rectH = (bounds.maxY - bounds.minY) * proj.k;
    ctx.drawImage(layout, proj.ox, proj.oy, rectW, rectH);
    ctx.fillStyle = LAYOUT_VEIL;
    ctx.fillRect(proj.ox, proj.oy, rectW, rectH);
  }

  // Neutral terrain furniture (v2 payloads): mineral lines, geysers,
  // rocks, towers — mined-out patches and broken rocks disappear at
  // their recorded death time.
  for (const r of playback.resources) {
    if (!resourceAliveAt(r, t)) continue;
    const glyph = resourceGlyph(r.kind, rasterDpr);
    if (!glyph) continue;
    const size = r.kind === "rocks" ? 16 : 13;
    ctx.drawImage(
      glyph,
      projectX(bounds, proj, r.x) - size / 2,
      projectY(bounds, proj, r.y) - size / 2,
      size,
      size,
    );
  }

  // Friendly town halls standing at time t — the anchors the mining
  // presentation snaps workers onto, with their live patch lists.
  const halls: Record<
    "me" | "opp",
    Array<{ x: number; y: number; slots: Array<{ x: number; y: number }> }>
  > = { me: [], opp: [] };
  for (const b of playback.buildings) {
    if (isTownHall(b.name) && buildingAliveAt(b, t)) {
      // CURRENT position: a floated Command Center anchors mining at
      // the expansion it landed on, not its construction site.
      const pos = buildingPositionAt(b, t);
      halls[b.owner].push({ x: pos.x, y: pos.y, slots: [] });
    }
  }
  // Mining slots per hall: real patches when the payload carries
  // resources, plus 3 gas slots per geyser a friendly gas building
  // sits on. Older (v1) payloads leave slots empty → arc fallback.
  if (playback.resources.length > 0) {
    for (const side of ["me", "opp"] as const) {
      for (const hall of halls[side]) {
        const patches = patchesNearHall(playback.resources, hall, t);
        const slots: Array<{ x: number; y: number }> = [...patches];
        for (const r of playback.resources) {
          if (r.kind !== "gas") continue;
          if (Math.hypot(r.x - hall.x, r.y - hall.y) > 11) continue;
          const tapped = playback.buildings.some(
            (b) =>
              b.owner === side &&
              buildingAliveAt(b, t) &&
              Math.hypot(b.x - r.x, b.y - r.y) <= 1.5,
          );
          if (tapped) slots.push(r, r, r);
        }
        hall.slots = slots;
      }
    }
  }

  // Units alive now — interpolate, then spread clusters so armies read
  // as blobs of distinguishable icons instead of a single pixel.
  // Workers near a friendly hall are presented MINING: on their real
  // patch/geyser slot when the payload has resources, else on the
  // away-from-center arc. They hold deterministic spots and skip
  // cluster spreading.
  const alive: Array<{ idx: number; x: number; y: number; worker: boolean }> = [];
  const mining: Array<{ idx: number; x: number; y: number }> = [];
  playback.units.forEach((u, idx) => {
    if (!unitAliveAt(u, t)) return;
    // Speed-capped interpolation: a unit HOLDS its last known anchor
    // (mining, building, sieged) and departs at the last moment that
    // still arrives on time — instead of drifting across the map for
    // the whole gap between sparse waypoints.
    const pos = unitPositionAt(u.wp, t, unitMaxSpeed(u.name));
    if (!pos) return;
    if (isWorkerUnit(u.name)) {
      const hall = nearestTownHall(pos, halls[u.owner], MINING_SNAP_RADIUS);
      if (hall) {
        const hallSlots = (hall as { slots?: Array<{ x: number; y: number }> })
          .slots;
        const spot =
          hallSlots && hallSlots.length > 0
            ? patchMiningPosition(hallSlots[idx % hallSlots.length], hall, idx)
            : miningArcPosition(hall, bounds, idx);
        mining.push({
          idx,
          x: projectX(bounds, proj, spot.x),
          y: projectY(bounds, proj, spot.y),
        });
        return;
      }
    }
    alive.push({
      idx,
      x: projectX(bounds, proj, pos.x),
      y: projectY(bounds, proj, pos.y),
      worker: isWorkerUnit(u.name),
    });
  });

  // ── Fog of war: union of BOTH sides' vision (matching the replay
  // viewer convention) — a dark layer with soft reveals punched out
  // around every unit and standing building. Unscouted map stays dim.
  if (typeof document !== "undefined") {
    if (!fogCanvas) fogCanvas = document.createElement("canvas");
    const fw = Math.max(1, Math.round(w));
    const fh = Math.max(1, Math.round(h));
    if (fogCanvas.width !== fw || fogCanvas.height !== fh) {
      fogCanvas.width = fw;
      fogCanvas.height = fh;
    }
    const fg = fogCanvas.getContext("2d");
    if (fg) {
      fg.setTransform(1, 0, 0, 1, 0, 0);
      fg.clearRect(0, 0, fw, fh);
      fg.globalCompositeOperation = "source-over";
      fg.fillStyle = `rgba(3,6,11,${FOG_ALPHA})`;
      fg.fillRect(0, 0, fw, fh);
      fg.globalCompositeOperation = "destination-out";
      // Dedupe sight sources on a coarse grid — a 3-cell cell per
      // reveal keeps the gradient count low on 400-unit frames.
      const seen = new Set<string>();
      const reveal = (cx: number, cy: number, worldR: number) => {
        const gridKey = `${Math.round(cx / 14)}:${Math.round(cy / 14)}:${worldR}`;
        if (seen.has(gridKey)) return;
        seen.add(gridKey);
        const r = worldR * proj.k;
        const grad = fg.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
        grad.addColorStop(0, "rgba(0,0,0,1)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        fg.fillStyle = grad;
        fg.beginPath();
        fg.arc(cx, cy, r, 0, Math.PI * 2);
        fg.fill();
      };
      for (const b of playback.buildings) {
        if (!buildingAliveAt(b, t)) continue;
        const pos = buildingPositionAt(b, t);
        reveal(
          projectX(bounds, proj, pos.x),
          projectY(bounds, proj, pos.y),
          isTownHall(b.name) ? SIGHT_HALL : SIGHT_BUILDING,
        );
      }
      for (const a of alive) reveal(a.x, a.y, a.worker ? SIGHT_WORKER : SIGHT_UNIT);
      for (const m of mining) reveal(m.x, m.y, SIGHT_WORKER);
      ctx.drawImage(fogCanvas, 0, 0, w, h);
    }
  }

  // Spawn anchors — subtle rings labeled by side color.
  for (const s of playback.spawns) {
    ctx.beginPath();
    ctx.arc(projectX(bounds, proj, s.x), projectY(bounds, proj, s.y), 12, 0, Math.PI * 2);
    ctx.strokeStyle = s.owner === "me" ? "rgba(62,192,199,0.35)" : "rgba(224,86,86,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Buildings placed by now — bare team-tinted icon art, same
  // treatment as units (no tile, frame, or backing); town halls
  // bigger. Small squares only when no icon ships for the name (or it
  // hasn't decoded yet).
  const derived = derivedOf(playback);
  for (const b of playback.buildings) {
    if (!buildingAliveAt(b, t)) continue;
    const pos = buildingPositionAt(b, t);
    const x = projectX(bounds, proj, pos.x);
    const y = projectY(bounds, proj, pos.y);
    const townHall = isTownHall(b.name);
    const size = townHall ? TOWNHALL_ICON_PX : BUILDING_ICON_PX;
    const token = iconToken(
      b.name,
      "building",
      b.owner === "me" ? ME_ARMY : OPP_ARMY,
      size,
      rasterDpr,
    );
    if (token) {
      ctx.drawImage(token, x - size / 2, y - size / 2, size, size);
    } else {
      const sq = townHall ? 9 : 5;
      ctx.fillStyle = b.owner === "me" ? "rgba(62,192,199,0.75)" : "rgba(224,86,86,0.75)";
      ctx.fillRect(x - sq / 2, y - sq / 2, sq, sq);
    }
    // Builder-at-the-site presentation: an SCV stays for the whole
    // construction, a probe warps and leaves, a drone becomes the
    // building. Skip the opening town hall (t=0 has no builder).
    if (b.t > 1) {
      const workerName = derived.workerName[b.owner];
      const windowSec = builderWindowSec(workerName);
      if (workerName && windowSec > 0 && t >= b.t && t <= b.t + windowSec) {
        const wtoken = iconToken(
          workerName,
          "unit",
          b.owner === "me" ? ME_ARMY : OPP_ARMY,
          WORKER_ICON_PX,
          rasterDpr,
        );
        if (wtoken) {
          ctx.globalAlpha = 0.9;
          ctx.drawImage(
            wtoken,
            x + size / 2 - 2,
            y - size / 2 - 3,
            WORKER_ICON_PX,
            WORKER_ICON_PX,
          );
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // Seed the spread with each unit's payload index — stable for the
  // whole game — so a death doesn't reshuffle the survivors' spots.
  const spread = spreadClusters(
    alive,
    CLUSTER_CELL_PX,
    CLUSTER_SPACING_PX,
    alive.map((a) => a.idx),
  );
  const drawUnit = (unitIdx: number, pos: { x: number; y: number }) => {
    const unit = playback.units[unitIdx];
    const worker = isWorkerUnit(unit.name);
    const mine = unit.owner === "me";
    // Bare team-tinted icons — nothing drawn around the unit art, so
    // the unit type reads directly; workers dim slightly.
    const size = worker ? WORKER_ICON_PX : ARMY_ICON_PX;
    const token = iconToken(unit.name, "unit", mine ? ME_ARMY : OPP_ARMY, size, rasterDpr);
    if (token) {
      if (worker) ctx.globalAlpha = 0.75;
      ctx.drawImage(token, pos.x - size / 2, pos.y - size / 2, size, size);
      if (worker) ctx.globalAlpha = 1;
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, worker ? 1.6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = mine
        ? worker
          ? ME_WORKER
          : ME_ARMY
        : worker
          ? OPP_WORKER
          : OPP_ARMY;
      ctx.fill();
    }
  };
  spread.forEach((pos, i) => drawUnit(alive[i].idx, pos));
  mining.forEach((m) => drawUnit(m.idx, m));

  // Battle pulses near their marker time — drawn last so the amber
  // ring reads over the unit icons it is calling attention to.
  for (const m of playback.battles) {
    const d = Math.abs(m.t - t);
    if (d > BATTLE_WINDOW_SEC) continue;
    const f = 1 - d / BATTLE_WINDOW_SEC;
    ctx.beginPath();
    ctx.arc(
      projectX(bounds, proj, m.x),
      projectY(bounds, proj, m.y),
      10 + 14 * f,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = `rgba(230,180,80,${0.15 + 0.5 * f})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.restore();
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
