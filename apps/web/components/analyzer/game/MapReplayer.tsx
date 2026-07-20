"use client";

/**
 * MapReplayer — vespene.gg-style playback of one game on its map.
 *
 * Renders the agent-uploaded playback payload (unit waypoint tracks,
 * building placements, battle markers, spawns, per-side stats) on a
 * canvas with a scrubbable timeline: play/pause, 1×–16× speed, and a
 * live HUD (army value · workers · supply per side). The real map
 * layout render (``/v1/map-image?variant=layout``) draws under the
 * action, stretched to the playable bounds; buildings render their
 * in-game icons framed in the side color, units render as bare
 * team-tinted icons (no ring, box, or backing — the unit art reads
 * directly, washed toward the owner color) —
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
  isTownHall,
  isWorkerUnit,
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
const CLUSTER_CELL_PX = 12;
const CLUSTER_SPACING_PX = 8;
/** Marker sizes in canvas px. */
const ARMY_ICON_PX = 16;
const WORKER_ICON_PX = 11;
const BUILDING_ICON_PX = 16;
const TOWNHALL_ICON_PX = 24;
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

function unitToken(
  name: string,
  tint: string,
  sizePx: number,
  dpr: number,
): HTMLCanvasElement | null {
  const icon = readyIcon(name, "unit");
  if (!icon) return null;
  const path = resolveIconPath(name, "unit");
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
      const dirty =
        playingRef.current ||
        timeRef.current !== drawn.t ||
        assetsVersion !== drawn.v ||
        canvas.width !== drawn.cw ||
        canvas.height !== drawn.ch;
      if (dirty) {
        renderFrame(ctx, canvas, playback, timeRef.current, layoutImageRef.current);
        drawn = {
          t: timeRef.current,
          v: assetsVersion,
          cw: canvas.width,
          ch: canvas.height,
        };
      }
    };
    let lastReactSync = -1;
    let drawn = { t: -1, v: -1, cw: 0, ch: 0 };
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

      <div ref={wrapRef} className="min-w-0">
        <canvas
          ref={canvasRef}
          className="block w-full rounded-lg border border-border bg-[#0a0d13]"
          aria-label={`Map playback of ${playback.mapName || "this game"}`}
        />
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

function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  playback: MapPlayback,
  t: number,
  layout: HTMLImageElement | null,
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const { bounds } = playback;
  // Tight padding: nearly every canvas pixel shows map.
  const proj = worldProjection(bounds, w, h, 4);

  ctx.clearRect(0, 0, w, h);

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

  // Spawn anchors — subtle rings labeled by side color.
  for (const s of playback.spawns) {
    ctx.beginPath();
    ctx.arc(projectX(bounds, proj, s.x), projectY(bounds, proj, s.y), 12, 0, Math.PI * 2);
    ctx.strokeStyle = s.owner === "me" ? "rgba(62,192,199,0.35)" : "rgba(224,86,86,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Buildings placed by now — in-game icons on a dark backing tile,
  // framed in the side color; town halls bigger. Squares only when no
  // icon ships for the name (or it hasn't decoded yet).
  for (const b of playback.buildings) {
    if (b.t > t) continue;
    const x = projectX(bounds, proj, b.x);
    const y = projectY(bounds, proj, b.y);
    const townHall = isTownHall(b.name);
    const icon = readyIcon(b.name, "building");
    if (icon) {
      const size = townHall ? TOWNHALL_ICON_PX : BUILDING_ICON_PX;
      ctx.fillStyle = "rgba(8,11,17,0.85)";
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.drawImage(icon, x - size / 2, y - size / 2, size, size);
      ctx.strokeStyle = b.owner === "me" ? ME_ARMY : OPP_ARMY;
      ctx.lineWidth = townHall ? 1.75 : 1.25;
      ctx.strokeRect(x - size / 2 + 0.5, y - size / 2 + 0.5, size - 1, size - 1);
    } else {
      const size = townHall ? 9 : 5;
      ctx.fillStyle = b.owner === "me" ? "rgba(62,192,199,0.75)" : "rgba(224,86,86,0.75)";
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }

  // Units alive now — interpolate, then spread clusters so armies read
  // as blobs of distinguishable icons instead of a single pixel.
  const alive: Array<{ idx: number; x: number; y: number }> = [];
  playback.units.forEach((u, idx) => {
    if (!unitAliveAt(u, t)) return;
    // Speed-capped interpolation: a unit HOLDS its last known anchor
    // (mining, building, sieged) and departs at the last moment that
    // still arrives on time — instead of drifting across the map for
    // the whole gap between sparse waypoints.
    const pos = unitPositionAt(u.wp, t, unitMaxSpeed(u.name));
    if (!pos) return;
    alive.push({
      idx,
      x: projectX(bounds, proj, pos.x),
      y: projectY(bounds, proj, pos.y),
    });
  });
  // Seed the spread with each unit's payload index — stable for the
  // whole game — so a death doesn't reshuffle the survivors' spots.
  const spread = spreadClusters(
    alive,
    CLUSTER_CELL_PX,
    CLUSTER_SPACING_PX,
    alive.map((a) => a.idx),
  );
  spread.forEach((pos, i) => {
    const unit = playback.units[alive[i].idx];
    const worker = isWorkerUnit(unit.name);
    const mine = unit.owner === "me";
    // Bare team-tinted icons — nothing drawn around the unit art, so
    // the unit type reads directly; workers dim slightly.
    const size = worker ? WORKER_ICON_PX : ARMY_ICON_PX;
    const token = unitToken(unit.name, mine ? ME_ARMY : OPP_ARMY, size, dpr);
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
  });

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
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
