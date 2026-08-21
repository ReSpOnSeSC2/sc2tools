"use client";

/**
 * MapReplayer — playback of one game on its map, in 3D-rendered sprites.
 *
 * Renders the agent-uploaded playback payload (unit waypoint tracks,
 * building placements, battle markers, spawns, per-side stats) on a
 * canvas with a scrubbable timeline: play/pause, 1×–16× speed, and a
 * live HUD (army value · workers · supply per side).
 *
 * The action layer draws the real thing: 103 sprite sheets rendered
 * from the SC2 ``.m3`` models in Blender, 8 facings × 8 animation
 * frames per unit, at TRUE world scale — a Thor's cell is 8.1 world
 * units wide against a Marine's 1.3, so it draws 6.2× as large. Units
 * tween between their (≥2 s apart) waypoints on a clamped Catmull-Rom,
 * face the direction they are actually moving, and play Walk or Stand
 * accordingly; workers run a real hall → patch → hall mining cycle so
 * bases visibly bustle. Anything with no sheet (Larva, Egg, Broodling,
 * Interceptor, Changeling, Locust, creep tumours, …) falls back to the
 * old flat team-tinted icon, and then to a dot.
 *
 * The map layout render (``/v1/map-image?variant=layout``) draws under
 * the action at full colour, stretched to the playable bounds — the
 * SAME rect the sprites project into, so terrain and unit positions
 * share exactly one coordinate mapping (see ``worldProjection``).
 *
 * Colours: the streamer is cyan (blue sheets), the opponent red;
 * battles pulse amber around their marker time. All real data — games
 * uploaded by agents without playback support show a "re-sync" hint
 * instead of an empty canvas (the parent handles the 404 by not
 * rendering this at all).
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
  gasTappedAt,
  isGasStructure,
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
  worldProjection,
  type MapPlayback,
  type PlaybackBuilding,
} from "@/lib/mapReplay";
import {
  animFrameIndex,
  facingFromVelocity,
  miningCycleSample,
  motionSample,
  phaseOffset,
  sampleTrack,
  type MotionSample,
} from "@/lib/replayMotion";
import {
  beginSpriteFrame,
  drawSprite,
  hasWalk,
  resolveSprite,
  spriteAnim,
  spriteAssetsVersion,
  type SpriteAnimHandle,
  type SpriteColor,
} from "@/lib/spriteSheets";
import {
  computeLosses,
  morphConsumedIndices,
  statsHaveWorkers,
  tradeEfficiency,
  workerCountAt,
  type LossSummary,
} from "@/lib/mapReplayLosses";
import { drawSpellEffects, spellEffectsVersion } from "@/lib/spellEffects";
import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from "lucide-react";
import { getMapLayoutUrl } from "@/lib/map-images";
import { getIconPath, type IconKind } from "@/lib/sc2-icons";
import { REPLAY_SCOPE_CLASS } from "./replay/replayTheme";

const SPEEDS = [1, 4, 8, 16] as const;
/** The floating map-view controls. Glass over the canvas, so they read
 *  at any terrain colour without a hard panel cutting into the map. */
const VIEW_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3ee0d6]";
const ME_ARMY = "#3ec0c7";
const ME_WORKER = "rgba(62,192,199,0.45)";
const OPP_ARMY = "#e05656";
const OPP_WORKER = "rgba(224,86,86,0.45)";
/** Owner → team-coloured sheet variant. */
const ME_SHEET: SpriteColor = "blue";
const OPP_SHEET: SpriteColor = "red";
/** How long a battle marker pulses around its timestamp. */
const BATTLE_WINDOW_SEC = 12;
/* Map furniture, in WORLD units so it keeps its size relative to the
 * terrain at every stage size and zoom — the same rule the sprites
 * follow. (These were raw canvas px before, which meant a spawn ring
 * covered a third of a base on a small stage and a hair on a big one.)
 */
const RESOURCE_GLYPH_WORLD = 1.8;
const ROCKS_GLYPH_WORLD = 2.3;
const SPAWN_RING_WORLD = 6;
const BATTLE_RING_MIN_WORLD = 4.5;
const BATTLE_RING_GROW_WORLD = 6.5;
/** Floor for the furniture above, in on-screen CSS px, so a compact
 * stage doesn't render them sub-pixel. */
const MIN_FURNITURE_SCREEN_PX = 9;

/* ──────────────── stage sizing ────────────────
 *
 * The old ``CANVAS_MAX_H_PX = 720`` ceiling is gone: the replay is the
 * centrepiece of the page, so the stage is sized like a video player —
 * as wide as its column, as tall as the viewport comfortably allows,
 * and always at the MAP's own aspect so nothing is letterboxed and the
 * whole canvas is playable ground.
 */
/** Fraction of the viewport height a full-size stage may occupy. */
const STAGE_VIEWPORT_FRACTION = 0.78;
/** Absolute floor/ceiling so tiny and huge viewports both stay sane. */
const STAGE_MIN_H_PX = 260;
const STAGE_MAX_H_PX = 1080;
/** Padding, in canvas px, between the playable bounds and the canvas
 * edge. Tight: nearly every pixel of the stage shows map. */
const STAGE_PAD_PX = 4;

/* ──────────────── sprite scale ────────────────
 *
 * ONE transform drives everything. ``worldProjection`` yields ``k``
 * pixels per world unit for the current canvas; a sprite's draw width
 * is ``worldUnitsPerCell × k``, full stop. That is what makes relative
 * unit sizes correct — and it is why nothing here has a hard-coded
 * per-unit or town-hall size any more.
 */
/** Global gain on sprite size. 1.0 is geometrically exact. Raising it
 * trades scale fidelity for legibility on small stages; do not. */
const SPRITE_WORLD_GAIN = 1.0;
/** Floor on a sprite's on-SCREEN cell size, in CSS px. Only binds on
 * very small stages (a compact drilldown at k ≈ 3 would draw a Marine
 * 3.9 px wide); above it, relative scale is untouched. */
const MIN_SPRITE_SCREEN_PX = 9;
/** Cell size in world units for names with no sprite sheet, so the
 * fallback icons stay in scale with the sprites around them. */
const FALLBACK_UNIT_WORLD = 1.7;
const FALLBACK_WORKER_WORLD = 1.5;
const FALLBACK_BUILDING_WORLD = 3.7;
/** Top of the shared worldUnitsPerCell ladder (the Mothership's cell).
 * Used as the culling margin — no sprite can be wider than this. */
const WIDEST_SPRITE_WORLD = 13.7;

/* ──────────────── motion tuning ──────────────── */
/** Above this world-units/second a unit plays its Walk cycle. */
const WALK_SPEED_THRESHOLD = 0.45;
/** A worker parked at a base is presented MINING. The snap radius is
 * unchanged (``MINING_SNAP_RADIUS``); these feather the handover so a
 * worker crossing its own base walks through instead of teleporting
 * onto the mineral line and back. */
const MINING_FEATHER_WORLD = 3;
/** Worker speed above which it is clearly travelling, not mining. */
const MINING_IDLE_SPEED = 1.6;

/* ──────────────── cluster spreading ────────────────
 *
 * Expressed in WORLD units now, not canvas px, so the spread is the
 * same physical size at every zoom and stage size. Deliberately small:
 * at true sprite scale, co-located units already read as a crowd, and
 * a large spread pops when a unit crosses a cell boundary.
 */
const CLUSTER_CELL_WORLD = 1.2;
const CLUSTER_SPACING_WORLD = 0.75;

/* ──────────────── fog of war ──────────────── */
const FOG_ALPHA = 0.5;
/** Sight radii in world cells, loosely matching in-game vision. */
const SIGHT_UNIT = 11;
const SIGHT_WORKER = 9;
const SIGHT_HALL = 13;
const SIGHT_BUILDING = 10;
/**
 * Fog is a soft mask, so it is rendered at a FRACTION of stage
 * resolution and upscaled on composite — invisible on a gradient,
 * and it cuts the fog's fill rate by 1/scale². The reveal discs are
 * the single largest fill in the frame (a 500-unit frame stamps ~14
 * megapixels of soft disc at full resolution), so this is the
 * difference between fog being free and fog being the frame.
 */
const FOG_RENDER_SCALE = 0.4;
/** Ceiling on the fog buffer's device-pixel ratio, on top of the
 * render scale — a 4K stage gains nothing from a 4K fog. */
const FOG_MAX_DPR = 2;

/**
 * Margin, in world units, on the cheap "is this unit's whole track off
 * screen?" reject. It must cover everything that can put a unit's
 * PIXELS or its VISION on screen when its waypoints are not:
 *
 *   • the widest sprite cell on the ladder (13.7, the Mothership);
 *   • the mining cycle pulling a parked worker up to
 *     MINING_SNAP_RADIUS (12) toward its hall, whose SIGHT_WORKER (9)
 *     reveal then reaches a further 9 — 21 in total;
 *   • a unit's own SIGHT_UNIT (11) reveal.
 *
 * The mining case dominates, so the margin is the max of the three.
 */
const CULL_MARGIN_WORLD = Math.max(
  WIDEST_SPRITE_WORLD,
  MINING_SNAP_RADIUS + SIGHT_WORKER,
  SIGHT_UNIT,
);
/**
 * Sight sources are deduped on a spatial grid. The cell is a fraction
 * of the reveal RADIUS rather than a fixed pixel count, so the dedupe
 * gets no weaker as the stage grows or the view zooms.
 *
 * The fraction is bounded: two sources sharing a cell of side ``c``
 * are at most ``c·√2`` apart, and the kept source is fully opaque out
 * to ``FOG_MASK_INNER · r``. So any fraction ≤ 0.55/√2 = 0.389
 * guarantees a dropped source still sits inside a kept source's solid
 * core and the union is visually unchanged. 0.35 keeps margin.
 */
const FOG_DEDUPE_RADIUS_FRACTION = 0.35;
/** Resolution of the cached reveal mask. The falloff is smooth, so a
 * 128 px stamp scales to any sight radius invisibly — and blitting a
 * stamp costs a fraction of building a radial gradient per reveal
 * (measured: ~2.5 ms/frame on a 600-source frame). */
const FOG_MASK_PX = 128;
/** Where the reveal starts fading, as a fraction of the radius. */
const FOG_MASK_INNER = 0.55;

/** Edge vignette. Replaces the old flat ``LAYOUT_VEIL`` global dim:
 * the terrain now shows at full colour, and only the outer edge is
 * darkened so the stage separates from the page chrome. */
const VIGNETTE_ALPHA = 0.42;
/** Fraction of the half-diagonal at which the vignette starts. */
const VIGNETTE_INNER = 0.62;

/* ──────────────── fallback icon caches ────────────────
 *
 * Module-level so every replayer instance (game page + macro
 * drilldown) shares one decoded image per icon. ``null`` marks a
 * failed load; entries are only drawn once fully decoded, so a frame
 * rendered before an icon arrives falls back to the dot marker and
 * picks the icon up on a later frame. Only names with NO sprite sheet
 * reach this path.
 */

const iconElementCache = new Map<string, HTMLImageElement | null>();
/** Memoized ``getIconPath`` — name→path resolution does string
 * normalization, too hot to repeat per marker per rAF frame. */
const iconPathCache = new Map<string, string | null>();
/** Bumped whenever an icon or the layout render finishes (or fails)
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

/** Team-tinted flat icons — the fallback for names with no sprite
 * sheet. Bare unit art (the PNGs carry real transparency) washed
 * toward the owner colour via source-atop, no ring, box, or backing.
 * Pre-rendered once per (icon, tint, size, dpr). */
const unitTokenCache = new Map<string, HTMLCanvasElement>();
/** How strongly the owner colour washes the icon art. */
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
  // the unit art itself takes the team colour.
  g.globalCompositeOperation = "source-atop";
  g.globalAlpha = TINT_ALPHA;
  g.fillStyle = tint;
  g.fillRect(0, 0, sizePx, sizePx);
  unitTokenCache.set(key, c);
  return c;
}

export function MapReplayer({
  playback,
  /** Cap on the stage height in CSS px. Hosts that embed the replay in
   * a panel (the macro drilldown) pass a smaller one; the default
   * sizes to the viewport like a video player. */
  maxHeightPx,
  /* ── Optional controlled playback ──────────────────────────────
   * A host that draws its own chrome around the stage (the HUD shell
   * with its production / build-order rails and transport dock) needs
   * ONE clock shared by the canvas and the panels. Passing any of
   * ``time`` / ``playing`` / ``speed`` makes that channel controlled;
   * omitting it keeps the internal state, so every existing call site
   * — which passes none of these — behaves exactly as before.
   *
   * The clock still lives in ``timeRef`` and advances in the rAF loop;
   * ``onTimeChange`` fires at the same ~4 Hz React throttle the time
   * label already used. A controlled host MUST echo the value back
   * verbatim (no rounding), or the seek-sync effect below will read it
   * as an external scrub and stutter the clock. */
  time,
  onTimeChange,
  playing: playingProp,
  onPlayingChange,
  speed: speedProp,
  onSpeedChange,
  /** Hide the built-in transport chrome — play/speed row, time label,
   * scrubber, the per-side stat line and the units-lost panels — for
   * hosts that render their own. The canvas, its zoom buttons and the
   * screen-reader summary always stay. */
  hideControls = false,
  /** Fill the host's box instead of sizing to the viewport.
   *
   * ``ReplayStage`` lays the replay out like a video player: a
   * fixed-height column whose middle band is the map. In that mode the
   * HOST owns the available box and the canvas measures it directly —
   * which is also the only way to break the feedback loop that used to
   * pin the map at its 240 px floor (see the sizing effect below). */
  fill = false,
}: {
  playback: MapPlayback;
  maxHeightPx?: number;
  time?: number;
  onTimeChange?: (t: number) => void;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  speed?: (typeof SPEEDS)[number];
  onSpeedChange?: (speed: (typeof SPEEDS)[number]) => void;
  hideControls?: boolean;
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** The box that hugs the canvas exactly, so the overlay toolbar sits
   *  on the MAP's corner rather than the (often wider) wrapper's. */
  const frameRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [playingState, setPlayingState] = useState(false);
  const [speedState, setSpeedState] = useState<(typeof SPEEDS)[number]>(8);
  const [timeState, setTimeState] = useState(0);
  const playing = playingProp ?? playingState;
  const speed = speedProp ?? speedState;
  const timeSec = time ?? timeState;
  // Host callbacks in refs: the rAF loop binds once per payload, so it
  // must not close over a stale ``onTimeChange``.
  const onTimeChangeRef = useRef(onTimeChange);
  onTimeChangeRef.current = onTimeChange;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const onSpeedChangeRef = useRef(onSpeedChange);
  onSpeedChangeRef.current = onSpeedChange;
  // Last value we published, so the sync effect can tell the host
  // echoing our own tick apart from a real external seek.
  const lastEmitRef = useRef<number | null>(null);
  // One writer per channel — identity-stable, so nothing re-binds.
  const emitTime = useCallback((next: number) => {
    lastEmitRef.current = next;
    setTimeState(next);
    onTimeChangeRef.current?.(next);
  }, []);
  const emitPlaying = useCallback((next: boolean) => {
    setPlayingState(next);
    onPlayingChangeRef.current?.(next);
  }, []);
  const emitSpeed = useCallback((next: (typeof SPEEDS)[number]) => {
    setSpeedState(next);
    onSpeedChangeRef.current?.(next);
  }, []);
  // Refs mirror the interactive state so the rAF loop never re-binds.
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef<number>(8);
  playingRef.current = playing;
  speedRef.current = speed;

  const gameLength = Math.max(1, playback.gameLength);
  // Real map layout render, drawn under the action once loaded.
  // crossOrigin IS set: cells are re-rasterised through offscreen
  // canvases, and a tainted stage would block the screenshot/clip
  // export we want later. The map-image route serves permissive CORS;
  // on any load failure the ref stays null and the flat background
  // shows, exactly as before.
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

  /* ── Fullscreen ────────────────────────────────────────────────
   * The stage, not the canvas. A host that draws chrome around the
   * replay (``ReplayStage``: top bar, rails, transport dock) marks its
   * outermost element ``data-replay-stage``; we go fullscreen on that
   * so the whole HUD comes with it. With no such host — the compact
   * drilldown, or a bare ``MapReplayer`` — the component's own root is
   * the stage.
   *
   * State is read from the document, never assumed from the click:
   * Esc, the browser's own chrome and the F11 key all leave fullscreen
   * without firing anything on the button.
   */
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  /** Something containing this replayer is the fullscreen element —
   *  either its own root or a ``ReplayStage`` around it. Drives the
   *  button's label/pressed state and the sizing cap. */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** THIS component's root is the fullscreen element (no stage host).
   *  Only then does the root need to paint its own backdrop: a
   *  fullscreen element is viewport-sized and transparent by default. */
  const [isOwnFullscreen, setIsOwnFullscreen] = useState(false);
  // Set by the sizing effect below; called again whenever fullscreen
  // flips, because the canvas takes its size from its container and the
  // viewport cap, and neither change is guaranteed to reach the
  // ResizeObserver.
  const remeasureRef = useRef<(() => void) | null>(null);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = isFullscreen;

  const fullscreenTarget = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) return null;
    const stage = root.closest<HTMLElement>("[data-replay-stage]");
    return stage ?? root;
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Feature detection, not UA sniffing. ``fullscreenEnabled`` is
    // false inside an iframe without allowfullscreen, which is exactly
    // when the button must not be offered.
    const root = document.documentElement;
    const supported =
      typeof root.requestFullscreen === "function" &&
      typeof document.exitFullscreen === "function" &&
      document.fullscreenEnabled !== false;
    setFullscreenAvailable(supported);
    if (!supported) return;
    const onChange = () => {
      const el = document.fullscreenElement;
      const mine = !!el && !!rootRef.current && el.contains(rootRef.current);
      setIsFullscreen(mine);
      setIsOwnFullscreen(!!el && el === rootRef.current);
      fullscreenRef.current = mine;
      // Synchronously and again after the browser has settled the new
      // viewport — otherwise the canvas keeps its pre-fullscreen
      // backing store and the map draws into a corner.
      remeasureRef.current?.();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => remeasureRef.current?.());
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    // Only OUR fullscreen is ours to exit. If some other element owns
    // the screen, requesting ours replaces it, which is what the click
    // asked for.
    if (fullscreenRef.current && document.fullscreenElement) {
      void Promise.resolve(document.exitFullscreen()).catch(() => {});
      return;
    }
    const target = fullscreenTarget();
    if (!target || typeof target.requestFullscreen !== "function") return;
    // A rejected request (no user activation, blocked by policy) must
    // not surface as an unhandled rejection; the button simply stays
    // in its current state because ``fullscreenchange`` never fires.
    void Promise.resolve(target.requestFullscreen()).catch(() => {});
  }, [fullscreenTarget]);

  useEffect(() => {
    layoutImageRef.current = null;
    const url = getMapLayoutUrl(playback.mapName);
    if (!url || typeof Image === "undefined") return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
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
      emitTime(clamped);
    },
    [gameLength, emitTime],
  );

  // External seek (a marker click in the host's transport dock). Skips
  // the host echoing our own tick back, so a controlled clock advances
  // in the loop and is never dragged backwards by a 4 Hz round trip.
  useEffect(() => {
    if (time === undefined || time === lastEmitRef.current) return;
    timeRef.current = Math.min(gameLength, Math.max(0, time));
  }, [time, gameLength]);

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
          emitTime(gameLength);
          emitPlaying(false);
        } else {
          timeRef.current = next;
          // Throttle React state to ~4 Hz — the canvas doesn't need it,
          // only the time label / scrubber do.
          if (Math.abs(next - lastReactSync) > 0.25) {
            lastReactSync = next;
            emitTime(next);
          }
        }
      }
      lastTs = ts;
      // Dirty-check: a paused replay re-renders only when the scrub
      // time, canvas size, or asset readiness actually changed —
      // otherwise a static frame would burn battery at 60 fps.
      const view = viewRef.current;
      // Sum of two monotonic counters: differs iff either bumped, so the
      // spell layer signals dirtiness (its toggle) the same way sheets do.
      const spriteV = spriteAssetsVersion() + spellEffectsVersion();
      const dirty =
        playingRef.current ||
        timeRef.current !== drawn.t ||
        assetsVersion !== drawn.v ||
        spriteV !== drawn.sv ||
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
          // The version captured BEFORE the render, not after: a sheet
          // that finished decoding mid-frame must still mark the NEXT
          // frame dirty, or the last sprite to arrive never appears on
          // a paused replay.
          sv: spriteV,
          cw: canvas.width,
          ch: canvas.height,
          z: view.z,
          ox: view.ox,
          oy: view.oy,
        };
      }
    };
    let lastReactSync = -1;
    let drawn = { t: -1, v: -1, sv: -1, cw: 0, ch: 0, z: 1, ox: 0, oy: 0 };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playback, gameLength, emitTime, emitPlaying]);

  // ── Stage sizing ────────────────────────────────────────────────
  //
  // THE BUG THIS REPLACES. The old pass measured ``wrapRef`` — the box
  // that CONTAINS the canvas — while the canvas was a normal in-flow
  // child of a shrink-to-fit flex item. The wrapper's width therefore
  // came from the canvas, and the canvas's width came from the
  // wrapper: a circular measurement that settled on the ``max(240, 0)``
  // floor on the very first pass and never grew again. That is why the
  // map rendered as a ~240 px postage stamp in the middle of a 700 px
  // column no matter how large the window was.
  //
  // THE FIX. The canvas is ABSOLUTELY POSITIONED (see the markup), so
  // it contributes nothing to its container's size and the measurement
  // can never feed back into itself. What is measured depends on the
  // mode:
  //
  //   fill      the host (``ReplayStage``) owns a definite box —
  //             ``flex-1 min-h-0 min-w-0`` inside a fixed-height
  //             column — so BOTH axes are read from it and the map
  //             genuinely fills the space it is given, fullscreen
  //             included.
  //   default   width from the (block-level, ``w-full``) wrapper,
  //             height from ``maxHeightPx`` or the viewport fraction,
  //             exactly as hosts embedding a bare replayer expect.
  //             The wrapper's own height is then SET from the result.
  //
  // Either way the canvas keeps the map's aspect: it narrows rather
  // than letterboxing, so every canvas pixel is playable ground.
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
      const viewportH = typeof window !== "undefined" ? window.innerHeight : 900;
      const viewportCap = viewportH * STAGE_VIEWPORT_FRACTION;

      // In fill mode the container IS the cap, on both axes. jsdom (and
      // a not-yet-laid-out box) reports 0 — fall back to the viewport
      // rule there rather than collapsing to the floor.
      const measuredH = fill ? rect.height : 0;
      const capH =
        measuredH > 1
          ? Math.max(STAGE_MIN_H_PX, measuredH)
          : fullscreenRef.current
            ? // Fullscreen ignores the host's height cap AND the 1080
              // ceiling — the point of it is to use the screen, and a
              // compact host's 420 px cap following the stage into
              // fullscreen is exactly the stale-size bug this control
              // has to avoid. Same viewport FRACTION, so the
              // surrounding chrome still fits.
              Math.max(STAGE_MIN_H_PX, viewportCap)
            : Math.max(
                STAGE_MIN_H_PX,
                Math.min(STAGE_MAX_H_PX, maxHeightPx ?? viewportCap),
              );

      const availW = Math.max(240, rect.width);
      const w = Math.min(availW, capH / aspect);
      const h = w * aspect;

      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      // The frame hugs the canvas so the overlay toolbar rides the
      // map's corner; it is absolutely positioned and centred, so this
      // never feeds back into ``rect``.
      const frame = frameRef.current;
      if (frame) {
        frame.style.width = `${w}px`;
        frame.style.height = `${h}px`;
      }
      // Outside fill mode nothing else gives the wrapper a height —
      // the canvas is out of flow — so it takes the canvas's.
      if (!fill) wrap.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    apply();
    // Published so the fullscreen listener can re-measure: entering
    // fullscreen changes the viewport, not necessarily the wrapper's
    // observed box, so the ResizeObserver alone is not enough.
    remeasureRef.current = apply;
    const obs =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    obs?.observe(wrap);
    if (typeof window !== "undefined") window.addEventListener("resize", apply);
    return () => {
      if (remeasureRef.current === apply) remeasureRef.current = null;
      obs?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", apply);
    };
  }, [playback, maxHeightPx, fill]);

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
  // Payloads synced before engine 1.5.3 carry an all-zero workers
  // column (the engine read a nonexistent attribute) — the worker
  // units themselves were always in the payload, so count the live
  // ones instead of showing 0 for the whole game.
  const workersReliable = useMemo(
    () => ({
      me: statsHaveWorkers(playback.stats.me),
      opp: statsHaveWorkers(playback.stats.opp),
    }),
    [playback],
  );
  const meWorkers = workersReliable.me
    ? me.workers
    : workerCountAt(playback.units, "me", timeSec);
  const oppWorkers = workersReliable.opp
    ? opp.workers
    : workerCountAt(playback.units, "opp", timeSec);
  // Units lost up to the scrub time, priced in real minerals/gas.
  // Deaths that are actually tech spending — Drones morphed into
  // structures, Templar merged into Archons — never count as losses.
  const consumed = useMemo(
    () => morphConsumedIndices(playback.units, playback.buildings, playback.v),
    [playback],
  );
  const meLosses = useMemo(
    () => computeLosses(playback.units, "me", timeSec, consumed),
    [playback, timeSec, consumed],
  );
  const oppLosses = useMemo(
    () => computeLosses(playback.units, "opp", timeSec, consumed),
    [playback, timeSec, consumed],
  );

  return (
    <div
      ref={rootRef}
      /* ``h-full`` + a stage background (and the replay colour scope,
         so the chrome inside is legible on it) only when the replayer
         itself is the fullscreen element: a fullscreen div is
         viewport-sized and transparent by default, which would
         otherwise show a white page behind a letterboxed canvas. */
      className={[
        "min-w-0",
        // ``w-full`` is load-bearing, not cosmetic: the replayer is a
        // flex ITEM in both hosts, and a flex item defaults to
        // shrink-to-fit. Without it the root sized itself to the
        // canvas it was supposed to be sizing.
        fill ? "flex h-full w-full flex-col" : "w-full space-y-2",
        isOwnFullscreen
          ? `${REPLAY_SCOPE_CLASS} h-full overflow-auto bg-[#070a0f] p-3`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="map-replayer"
    >
      {!hideControls && (
      <div className="flex flex-wrap items-center gap-2">
        {/* Fixed width so ▶ Play / ❚❚ Pause toggling never shifts the
            row; taller touch targets below the sm breakpoint. */}
        <button
          type="button"
          onClick={() => {
            if (!playing && timeRef.current >= gameLength) setTime(0);
            emitPlaying(!playing);
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
              onClick={() => emitSpeed(s)}
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
      )}

      <div
        ref={wrapRef}
        /* The measured box. In fill mode the stage hands it a definite
           height (``flex-1`` inside a fixed-height column with
           ``min-h-0``), so content can never grow it and the sizing
           pass has a stable number to read. */
        className={`relative min-w-0 ${
          fill ? "min-h-0 flex-1 overflow-hidden" : "w-full"
        }`}
      >
        {/* Absolutely positioned and centred: the canvas is OUT OF FLOW,
            which is what stops its size feeding back into the box being
            measured. Its width/height come from the sizing effect. */}
        <div
          ref={frameRef}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <canvas
            ref={canvasRef}
            className="block h-full w-full touch-none rounded-lg bg-[#0a0d13] shadow-[0_10px_40px_-16px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-white/[0.14]"
            aria-label={`Map playback of ${playback.mapName || "this game"}`}
          />
          <div
            className="absolute right-2 top-2 flex flex-col gap-1 rounded-lg border border-white/10 bg-black/55 p-1 backdrop-blur-sm"
            role="group"
            aria-label="Map view controls"
          >
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => {
                const c = canvasRef.current;
                if (c) applyZoom(c.clientWidth / 2, c.clientHeight / 2, 1.4);
              }}
              className={VIEW_BUTTON_CLASS}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => {
                const c = canvasRef.current;
                if (c) applyZoom(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.4);
              }}
              className={VIEW_BUTTON_CLASS}
            >
              <Minus className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              title="Reset zoom"
              data-testid="replay-reset-zoom"
              onClick={resetView}
              className={VIEW_BUTTON_CLASS}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
            {fullscreenAvailable ? (
              <button
                type="button"
                aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                aria-pressed={isFullscreen}
                title={isFullscreen ? "Exit full screen" : "Full screen"}
                data-testid="replay-fullscreen"
                onClick={toggleFullscreen}
                className={VIEW_BUTTON_CLASS}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" aria-hidden />
                ) : (
                  <Maximize2 className="h-4 w-4" aria-hidden />
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* The canvas carries no text, so the same state is spelled out
          for screen readers here and kept in sync with the scrubber. */}
      <p className="sr-only">
        {`At ${formatTime(timeSec)} of ${formatTime(gameLength)} on ${
          playback.mapName || "this map"
        }: you have ${Math.round(me.army)} army value, ${Math.round(
          meWorkers,
        )} workers and ${Math.round(me.supply)} supply, having lost ${
          meLosses.count
        } units worth ${meLosses.minerals} minerals and ${meLosses.gas} gas. The opponent has ${Math.round(
          opp.army,
        )} army value, ${Math.round(oppWorkers)} workers and ${Math.round(
          opp.supply,
        )} supply, having lost ${oppLosses.count} units worth ${
          oppLosses.minerals
        } minerals and ${oppLosses.gas} gas.`}
      </p>

      {!hideControls && (<>
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
            army {Math.round(me.army)} · {Math.round(meWorkers)} workers ·{" "}
            {Math.round(me.supply)} supply
          </span>
        </span>
        <span className="whitespace-nowrap">
          <b style={{ color: OPP_ARMY }}>Opponent</b>{" "}
          <span className="text-text-muted">
            army {Math.round(opp.army)} · {Math.round(oppWorkers)} workers ·{" "}
            {Math.round(opp.supply)} supply
          </span>
        </span>
      </div>

      {/* Units lost — live with the scrubber. Efficiency is the value
          the opponent lost per resource this side lost (>1 = traded
          up); each side lists WHAT died, priced in minerals/gas. */}
      <div className="grid gap-2 sm:grid-cols-2">
        <LossPanel
          label="You"
          color={ME_ARMY}
          losses={meLosses}
          efficiency={tradeEfficiency(meLosses, oppLosses)}
        />
        <LossPanel
          label="Opponent"
          color={OPP_ARMY}
          losses={oppLosses}
          efficiency={tradeEfficiency(oppLosses, meLosses)}
        />
      </div>
      </>)}
    </div>
  );
}

/** How many lost-unit rows a panel lists before folding into "+N". */
const LOSS_ROWS_MAX = 8;

function LossPanel({
  label,
  color,
  losses,
  efficiency,
}: {
  label: string;
  color: string;
  losses: LossSummary;
  efficiency: number | null;
}) {
  const shown = losses.byUnit.slice(0, LOSS_ROWS_MAX);
  const folded = losses.byUnit.length - shown.length;
  return (
    <div
      className="rounded-md border border-border bg-bg-elevated/60 p-2"
      data-testid={`loss-panel-${label.toLowerCase()}`}
    >
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="whitespace-nowrap">
          <b style={{ color }}>{label}</b>{" "}
          <span className="text-text-muted">units lost</span>
        </span>
        <span
          className="whitespace-nowrap tabular-nums text-text-muted"
          title="Resources the opponent lost per resource this side lost — above 1.00× means this side traded up"
        >
          trade {formatEfficiency(efficiency)}
        </span>
      </div>
      <div className="mt-1 text-caption tabular-nums text-text">
        {losses.count} units · {losses.minerals.toLocaleString()} minerals ·{" "}
        {losses.gas.toLocaleString()} gas
      </div>
      {shown.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {shown.map((g) => {
            const icon = getIconPath(g.name, "unit");
            return (
              <li
                key={g.name}
                className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-micro tabular-nums text-text-muted"
                title={`${g.count}× ${g.name} — ${g.minerals.toLocaleString()} minerals, ${g.gas.toLocaleString()} gas`}
              >
                {icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={icon} alt="" aria-hidden className="h-3.5 w-3.5" />
                ) : null}
                <span>
                  {g.count}× {g.name}
                </span>
              </li>
            );
          })}
          {folded > 0 && (
            <li className="inline-flex items-center rounded px-1 py-0.5 text-micro text-text-dim">
              +{folded} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function formatEfficiency(eff: number | null): string {
  if (eff === null) return "—";
  if (!Number.isFinite(eff)) return "∞";
  return `${eff.toFixed(2)}×`;
}

/* ──────────────── resource glyphs ────────────────
 *
 * Procedural resource glyphs (mineral crystals, geysers, rocks,
 * towers) cached per (kind, dpr) — small enough to read at map scale,
 * matching the classic minimap language: blue crystals, green gas,
 * gray rocks.
 */
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

/* ──────────────── per-payload derived data ──────────────── */

interface Derived {
  /** Worker unit name per side, for the builder-at-the-site cameo. */
  workerName: Record<"me" | "opp", string | null>;
  /** Track bounding box per unit, in world units — lets a zoomed-in
   * frame skip interpolating a unit that can never be on screen. */
  trackBox: Float32Array;
  /** Per-unit facing, carried across frames so the hysteresis in
   * ``facingFromVelocity`` has something to be sticky about. */
  facings: Int8Array;
  /** Per-unit animation phase, so a pack of Zerglings never marches
   * in lockstep. Deterministic in the payload index. */
  phase: Float32Array;
  /** Sheet handles resolved ONCE per payload. Name → sheet resolution
   * and URL building are string work; doing them per unit per frame
   * would be 60 000 string operations a second for nothing. Null means
   * no sheet ships for that name → the flat-icon fallback. */
  unitStand: Array<SpriteAnimHandle | null>;
  unitWalk: Array<SpriteAnimHandle | null>;
  unitWorker: Uint8Array;
  buildingStand: Array<SpriteAnimHandle | null>;
  buildingHall: Uint8Array;
  buildingPhase: Float32Array;
  /** Just the vespene structures, so the per-frame "is this geyser
   *  tapped?" guard rescans ~1% of the building list instead of all of
   *  it, once per gas node, every frame. */
  gasBuildings: PlaybackBuilding[];
}

const derivedCache = new WeakMap<MapPlayback, Derived>();

function derivedOf(playback: MapPlayback): Derived {
  let d = derivedCache.get(playback);
  if (!d) {
    const workerName: Record<"me" | "opp", string | null> = { me: null, opp: null };
    const n = playback.units.length;
    const trackBox = new Float32Array(n * 4);
    const phase = new Float32Array(n);
    const unitStand: Array<SpriteAnimHandle | null> = new Array(n);
    const unitWalk: Array<SpriteAnimHandle | null> = new Array(n);
    const unitWorker = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const u = playback.units[i];
      const worker = isWorkerUnit(u.name);
      unitWorker[i] = worker ? 1 : 0;
      if (worker && !workerName[u.owner]) workerName[u.owner] = u.name;
      const sprite = resolveSprite(u.name, "unit");
      unitStand[i] = sprite ? spriteAnim(sprite, "Stand") : null;
      // Carrier, SiegeTank and Tempest have no walk cycle; spriteAnim
      // already falls back to Stand, so this is never null when the
      // sprite exists and the Walk/Stand switch is a plain pick.
      unitWalk[i] = sprite ? spriteAnim(sprite, hasWalk(sprite) ? "Walk" : "Stand") : null;
      phase[i] = phaseOffset(i);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const wp = u.wp;
      for (let j = 1; j + 1 < wp.length; j += 3) {
        const x = wp[j];
        const y = wp[j + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      trackBox[i * 4] = minX;
      trackBox[i * 4 + 1] = minY;
      trackBox[i * 4 + 2] = maxX;
      trackBox[i * 4 + 3] = maxY;
    }
    const bn = playback.buildings.length;
    const buildingStand: Array<SpriteAnimHandle | null> = new Array(bn);
    const buildingHall = new Uint8Array(bn);
    const buildingPhase = new Float32Array(bn);
    const gasBuildings: PlaybackBuilding[] = [];
    for (let i = 0; i < bn; i += 1) {
      const b = playback.buildings[i];
      const sprite = resolveSprite(b.name, "building");
      buildingStand[i] = sprite ? spriteAnim(sprite, "Stand") : null;
      buildingHall[i] = isTownHall(b.name) ? 1 : 0;
      buildingPhase[i] = phaseOffset(i * 2654435761);
      if (isGasStructure(b.name)) gasBuildings.push(b);
    }
    d = {
      workerName,
      trackBox,
      facings: new Int8Array(n),
      phase,
      unitStand,
      unitWalk,
      unitWorker,
      buildingStand,
      buildingHall,
      buildingPhase,
      gasBuildings,
    };
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
/** One cached reveal stamp, blitted at whatever radius each sight
 * source needs. The falloff profile is a ratio, so it is the same
 * shape for every radius and every zoom — one canvas covers all. */
let fogMaskCanvas: HTMLCanvasElement | null = null;

function fogMask(): HTMLCanvasElement | null {
  if (fogMaskCanvas) return fogMaskCanvas;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = FOG_MASK_PX;
  c.height = FOG_MASK_PX;
  const g = c.getContext("2d");
  if (!g) return null;
  const r = FOG_MASK_PX / 2;
  const grad = g.createRadialGradient(r, r, r * FOG_MASK_INNER, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  fogMaskCanvas = c;
  return c;
}

interface ViewTransform {
  z: number;
  ox: number;
  oy: number;
}

/* ──────────────── draw entities ────────────────
 *
 * Units and buildings go into ONE list and are painted back-to-front
 * by their ground point's screen Y, so a Marine standing in front of a
 * Barracks draws over it — the whole reason the sprites read as 3D.
 * The list is a pooled array of mutable records: a 500-unit frame
 * allocates nothing after the first.
 */
interface DrawEntity {
  x: number;
  y: number;
  cellPx: number;
  handle: SpriteAnimHandle | null;
  color: SpriteColor;
  facing: number;
  frame: number;
  /** Fallback icon path data when ``handle`` is null. */
  name: string;
  iconKind: IconKind;
  tint: string;
  dot: string;
  alpha: number;
  worker: boolean;
}

const entityPool: DrawEntity[] = [];
let entityCount = 0;
const drawOrder: number[] = [];

function pushEntity(): DrawEntity {
  let e = entityPool[entityCount];
  if (!e) {
    e = {
      x: 0, y: 0, cellPx: 0, handle: null, color: "red", facing: 0, frame: 0,
      name: "", iconKind: "unit", tint: "", dot: "", alpha: 1, worker: false,
    };
    entityPool[entityCount] = e;
  }
  entityCount += 1;
  return e;
}

/** Scratch motion samples — module-level so the hot loop allocates
 * nothing per unit per frame. */
const trackSample: MotionSample = motionSample();
const cycleSample: MotionSample = motionSample();
/** Reused hall bookkeeping. */
interface Hall {
  x: number;
  y: number;
  slots: Array<{ x: number; y: number }>;
}
const spreadInput: DrawEntity[] = [];
const spreadSeeds: number[] = [];
/** Fog reveal sources, pooled the same way as the entity list. */
const fogX: number[] = [];
const fogY: number[] = [];
const fogR: number[] = [];
let fogCount = 0;

function pushFog(x: number, y: number, r: number): void {
  fogX[fogCount] = x;
  fogY[fogCount] = y;
  fogR[fogCount] = r;
  fogCount += 1;
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
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const { bounds } = playback;

  /* ── THE transform ──────────────────────────────────────────────
   * ``worldProjection`` is the single authority for world → canvas.
   * ``k`` is PIXELS PER WORLD UNIT; every length on screen derives
   * from it — terrain rect, sprite cell width, cluster spacing, fog
   * radii, mining geometry. Nothing in this file may size anything in
   * raw pixels that represents a world quantity.
   *
   *   canvasX = proj.ox + (worldX - bounds.minX) * k
   *   canvasY = proj.oy + (bounds.maxY - worldY) * k      (Y flipped)
   *   spriteCellPx = worldUnitsPerCell * k
   */
  const proj = worldProjection(bounds, w, h, STAGE_PAD_PX);
  const k = proj.k;

  // Device px per scene px this frame: the view zoom times the device
  // pixel ratio. Sprite atlases and icon tokens rasterise against it,
  // so they stay crisp under zoom instead of magnifying a 1× raster.
  const rasterScale = view.z * dpr;
  // Icon tokens keep the old power-of-two quantisation so their cache
  // stays tiny (≤3 sizes); sprite atlases bucket internally.
  const iconDpr = dpr * Math.min(4, Math.pow(2, Math.ceil(Math.log2(Math.max(1, view.z)))));
  beginSpriteFrame(rasterScale);

  // Visible scene rect, for culling. A scene point p is drawn at
  // ox + p*z, so the visible range is [-ox/z, (w-ox)/z].
  const cullX0 = -view.ox / view.z;
  const cullY0 = -view.oy / view.z;
  const cullX1 = cullX0 + w / view.z;
  const cullY1 = cullY0 + h / view.z;

  ctx.clearRect(0, 0, w, h);
  // Zoom/pan: scale the whole scene (sprites included — true zoom).
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.z, view.z);

  // Real map layout under everything, at FULL COLOUR, stretched to the
  // projected playable rect — the same rect every sprite projects into,
  // so terrain and unit positions share one coordinate mapping. The
  // old flat dark veil is gone; contrast comes from the edge vignette
  // drawn at the very end instead.
  const rectW = (bounds.maxX - bounds.minX) * k;
  const rectH = (bounds.maxY - bounds.minY) * k;
  if (layout) {
    ctx.drawImage(layout, proj.ox, proj.oy, rectW, rectH);
  }

  // Neutral terrain furniture (v2 payloads): mineral lines, geysers,
  // rocks, towers — mined-out patches and broken rocks disappear at
  // their recorded death time.
  const derived = derivedOf(playback);
  const minFurniturePx = MIN_FURNITURE_SCREEN_PX / view.z;
  const glyphPx = Math.max(minFurniturePx, RESOURCE_GLYPH_WORLD * k);
  const rocksPx = Math.max(minFurniturePx, ROCKS_GLYPH_WORLD * k);
  for (const r of playback.resources) {
    if (!resourceAliveAt(r, t)) continue;
    // A TAPPED geyser is not drawn at all: the structure standing on it
    // IS its presentation, exactly as in SC2, where a built
    // Refinery/Extractor/Assimilator hides the geyser completely.
    //
    // This is the gas-placement fix. The two are recorded at the same
    // map coordinate (measured: Δ = 0 on every gas structure in ten
    // real payloads), but they are PLACED by different conventions —
    // the glyph is centred on the coordinate, while the sprite is
    // anchored at its model's ground origin, which sits below the
    // bitmap's centre. The sprite's cell therefore lands ~0.5–0.7 world
    // units up-screen of the glyph (see the harness in
    // ``lib/__tests__/gasPlacement.test.ts``), and the green pool fringed
    // out from under the structure's downhill edge — most visibly in
    // the compact host, where ``MIN_FURNITURE_SCREEN_PX`` floors the
    // glyph at 9 px while an Assimilator is only 9.8 px wide.
    //
    // The anchor convention is not the thing to change: it is what puts
    // every unit's feet and every structure's footprint on its
    // coordinate. Removing the duplicate marker is.
    if (r.kind === "gas" && gasTappedAt(derived.gasBuildings, r, t)) continue;
    const glyph = resourceGlyph(r.kind, iconDpr);
    if (!glyph) continue;
    const size = r.kind === "rocks" ? rocksPx : glyphPx;
    ctx.drawImage(
      glyph,
      projectX(bounds, proj, r.x) - size / 2,
      projectY(bounds, proj, r.y) - size / 2,
      size,
      size,
    );
  }

  // Friendly town halls standing at time t — the anchors the mining
  // cycle runs between, with their live patch lists.
  const halls: Record<"me" | "opp", Hall[]> = { me: [], opp: [] };
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
          // Same test the draw pass above uses, so a geyser can never be
          // hidden-as-tapped here and still counted as untapped there.
          if (gasTappedAt(derived.gasBuildings, r, t, side)) slots.push(r, r, r);
        }
        hall.slots = slots;
      }
    }
  }

  const facings = derived.facings;
  const trackBox = derived.trackBox;
  entityCount = 0;
  fogCount = 0;
  spreadInput.length = 0;
  spreadSeeds.length = 0;

  const clusterCellPx = CLUSTER_CELL_WORLD * k;
  const clusterSpacingPx = CLUSTER_SPACING_WORLD * k;
  // Margin for the cheap track-bbox reject, in canvas px — see
  // CULL_MARGIN_WORLD for what it has to cover.
  const pad = CULL_MARGIN_WORLD * k;
  // A sprite's on-screen floor, expressed in scene px so the ctx zoom
  // turns it back into a constant screen size.
  const minCellScenePx = MIN_SPRITE_SCREEN_PX / view.z;

  /* ── Units ─────────────────────────────────────────────────────── */
  const units = playback.units;
  for (let idx = 0; idx < units.length; idx += 1) {
    const u = units[idx];
    if (!unitAliveAt(u, t)) continue;
    // Cheap reject: a unit whose whole track sits off screen can never
    // be visible, so skip the interpolation entirely. Generous margin
    // (the mining cycle can push a worker a few cells off its track).
    const bx0 = trackBox[idx * 4];
    if (bx0 !== Infinity) {
      const sx0 = projectX(bounds, proj, bx0) - pad;
      const sx1 = projectX(bounds, proj, trackBox[idx * 4 + 2]) + pad;
      // Y is flipped by the projection, so maxY maps to the smaller
      // canvas coordinate.
      const sy0 = projectY(bounds, proj, trackBox[idx * 4 + 3]) - pad;
      const sy1 = projectY(bounds, proj, trackBox[idx * 4 + 1]) + pad;
      if (sx1 < cullX0 || sx0 > cullX1 || sy1 < cullY0 || sy0 > cullY1) continue;
    }

    const pos = sampleTrack(u.wp, t, unitMaxSpeed(u.name), trackSample);
    if (!pos) continue;
    let wx = pos.x;
    let wy = pos.y;
    let vx = pos.vx;
    let vy = pos.vy;
    const worker = derived.unitWorker[idx] === 1;

    if (worker) {
      const hall = nearestTownHall(pos, halls[u.owner], MINING_SNAP_RADIUS) as Hall | null;
      if (hall) {
        // Feathered handover instead of a hard snap: fully mining when
        // parked well inside the radius, fully on its own track when
        // travelling or at the radius edge, blended in between — so a
        // worker crossing its base walks through rather than popping
        // onto the mineral line and back.
        const dist = Math.hypot(hall.x - wx, hall.y - wy);
        const speed = Math.hypot(vx, vy);
        const nearW = clamp01((MINING_SNAP_RADIUS - dist) / MINING_FEATHER_WORLD);
        const idleW = clamp01(1 - speed / MINING_IDLE_SPEED);
        const mix = nearW * idleW;
        if (mix > 0) {
          const hallSlots = hall.slots;
          const spot =
            hallSlots && hallSlots.length > 0
              ? patchMiningPosition(hallSlots[idx % hallSlots.length], hall, idx)
              : miningArcPosition(hall, bounds, idx);
          const c = miningCycleSample(hall, spot, t, idx, cycleSample);
          wx += (c.x - wx) * mix;
          wy += (c.y - wy) * mix;
          vx += (c.vx - vx) * mix;
          vy += (c.vy - vy) * mix;
        }
      }
    }

    const sx = projectX(bounds, proj, wx);
    const sy = projectY(bounds, proj, wy);
    pushFog(sx, sy, worker ? SIGHT_WORKER : SIGHT_UNIT);

    // Walk when actually moving, Stand otherwise. Both handles were
    // resolved up front; for a sprite with no walk cycle they are the
    // same object, so this needs no extra check.
    const walking = vx * vx + vy * vy > WALK_SPEED_THRESHOLD * WALK_SPEED_THRESHOLD;
    const handle = walking ? derived.unitWalk[idx] : derived.unitStand[idx];
    let cellPx = handle
      ? handle.anim.wupc * k * SPRITE_WORLD_GAIN
      : (worker ? FALLBACK_WORKER_WORLD : FALLBACK_UNIT_WORLD) * k;
    if (cellPx < minCellScenePx) cellPx = minCellScenePx;

    if (sx + cellPx < cullX0 || sx - cellPx > cullX1) continue;
    if (sy + cellPx < cullY0 || sy - cellPx > cullY1) continue;

    // Facing is stateful: the hysteresis in ``facingFromVelocity``
    // keeps the previous bucket unless the heading has clearly left it.
    const facing = facingFromVelocity(vx, vy, facings[idx]);
    facings[idx] = facing;

    const e = pushEntity();
    e.x = sx;
    e.y = sy;
    e.cellPx = cellPx;
    e.handle = handle;
    e.color = u.owner === "me" ? ME_SHEET : OPP_SHEET;
    e.facing = facing;
    e.frame = handle
      ? animFrameIndex(t, handle.anim.fps, handle.anim.frames, derived.phase[idx])
      : 0;
    e.name = u.name;
    e.iconKind = "unit";
    e.tint = u.owner === "me" ? ME_ARMY : OPP_ARMY;
    e.dot = u.owner === "me" ? (worker ? ME_WORKER : ME_ARMY) : worker ? OPP_WORKER : OPP_ARMY;
    e.alpha = handle ? 1 : worker ? 0.75 : 1;
    e.worker = worker;
    // Every unit takes part in cluster spreading, mining workers
    // included: they converge on a shared dock point at the hall, and
    // that is exactly where a stack needs breaking up. (The old static
    // presentation excluded them because their slots never moved.)
    spreadInput.push(e);
    spreadSeeds.push(idx);
  }

  // Spread co-located units onto a deterministic sunflower so a
  // 20-stalker ball reads as 20 units, not one. Seeded by payload
  // index so a death never reshuffles the survivors.
  if (spreadInput.length > 1 && clusterSpacingPx > 0.5) {
    const spread = spreadClusters(
      spreadInput,
      clusterCellPx,
      clusterSpacingPx,
      spreadSeeds,
    );
    for (let i = 0; i < spread.length; i += 1) {
      const e = spreadInput[i];
      e.x = spread[i].x;
      e.y = spread[i].y;
    }
  }

  /* ── Buildings ─────────────────────────────────────────────────── */
  const buildings = playback.buildings;
  for (let bi = 0; bi < buildings.length; bi += 1) {
    const b = buildings[bi];
    if (!buildingAliveAt(b, t)) continue;
    const bpos = buildingPositionAt(b, t);
    const sx = projectX(bounds, proj, bpos.x);
    const sy = projectY(bounds, proj, bpos.y);
    pushFog(sx, sy, derived.buildingHall[bi] === 1 ? SIGHT_HALL : SIGHT_BUILDING);

    // Buildings have facings: 1 — they never rotate — and their draw
    // size comes from the same worldUnitsPerCell ladder as units, so
    // the old hard-coded town-hall size bump is gone.
    const handle = derived.buildingStand[bi];
    let cellPx = handle
      ? handle.anim.wupc * k * SPRITE_WORLD_GAIN
      : FALLBACK_BUILDING_WORLD * k;
    if (cellPx < minCellScenePx) cellPx = minCellScenePx;
    if (sx + cellPx < cullX0 || sx - cellPx > cullX1) continue;
    if (sy + cellPx < cullY0 || sy - cellPx > cullY1) continue;

    const e = pushEntity();
    e.x = sx;
    e.y = sy;
    e.cellPx = cellPx;
    e.handle = handle;
    e.color = b.owner === "me" ? ME_SHEET : OPP_SHEET;
    e.facing = 0;
    e.frame = handle
      ? animFrameIndex(t, handle.anim.fps, handle.anim.frames, derived.buildingPhase[bi])
      : 0;
    e.name = b.name;
    e.iconKind = "building";
    e.tint = b.owner === "me" ? ME_ARMY : OPP_ARMY;
    e.dot = b.owner === "me" ? "rgba(62,192,199,0.75)" : "rgba(224,86,86,0.75)";
    e.alpha = 1;
    e.worker = false;

    // Builder-at-the-site presentation: an SCV stays for the whole
    // construction, a probe warps and leaves, a drone becomes the
    // building. Skip the opening town hall (t=0 has no builder).
    if (b.t > 1) {
      const workerName = derived.workerName[b.owner];
      const windowSec = builderWindowSec(workerName);
      if (workerName && windowSec > 0 && t >= b.t && t <= b.t + windowSec) {
        const wsprite = resolveSprite(workerName, "unit");
        const whandle = wsprite ? spriteAnim(wsprite, "Stand") : null;
        const wcell = Math.max(
          minCellScenePx,
          (whandle ? whandle.anim.wupc : FALLBACK_WORKER_WORLD) * k * SPRITE_WORLD_GAIN,
        );
        const we = pushEntity();
        we.x = sx + cellPx * 0.32;
        we.y = sy + cellPx * 0.06;
        we.cellPx = wcell;
        we.handle = whandle;
        // Face the structure it is building (west, index 6).
        we.facing = 6;
        we.color = e.color;
        we.frame = whandle
          ? animFrameIndex(t, whandle.anim.fps, whandle.anim.frames, derived.buildingPhase[bi])
          : 0;
        we.name = workerName;
        we.iconKind = "unit";
        we.tint = e.tint;
        we.dot = e.dot;
        we.alpha = 0.9;
        we.worker = true;
      }
    }
  }

  /* ── Fog of war ────────────────────────────────────────────────
   * Union of BOTH sides' vision (matching the replay viewer
   * convention) — a dark layer with soft reveals punched out around
   * every unit and standing building. Unscouted map stays dim. Drawn
   * over terrain but UNDER the entities, so units are never hidden.
   */
  const mask = fogCount > 0 ? fogMask() : null;
  if (typeof document !== "undefined" && mask) {
    if (!fogCanvas) fogCanvas = document.createElement("canvas");
    const fscale = Math.min(FOG_MAX_DPR, dpr) * FOG_RENDER_SCALE;
    const fw = Math.max(1, Math.round(w * fscale));
    const fh = Math.max(1, Math.round(h * fscale));
    if (fogCanvas.width !== fw || fogCanvas.height !== fh) {
      fogCanvas.width = fw;
      fogCanvas.height = fh;
    }
    const fg = fogCanvas.getContext("2d");
    if (fg) {
      // Fog is built in SCREEN space, not scene space: the reveals are
      // projected through the view transform so the mask stays at a
      // constant fraction of screen resolution at every zoom (a
      // scene-space fog blurs 8× when you zoom 8×) and off-screen
      // sources cost nothing.
      fg.setTransform(fscale, 0, 0, fscale, 0, 0);
      fg.clearRect(0, 0, w, h);
      fg.globalCompositeOperation = "source-over";
      fg.fillStyle = `rgba(3,6,11,${FOG_ALPHA})`;
      fg.fillRect(0, 0, w, h);
      fg.globalCompositeOperation = "destination-out";
      // Integer grid keys (12 bits per axis, biased for negatives)
      // avoid 600 template strings per frame.
      const seen = new Set<number>();
      const z = view.z;
      for (let i = 0; i < fogCount; i += 1) {
        const worldR = fogR[i];
        const r = worldR * k * z;
        const cx = fogX[i] * z + view.ox;
        const cy = fogY[i] * z + view.oy;
        if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) continue;
        const cell = Math.max(6, r * FOG_DEDUPE_RADIUS_FRACTION);
        const gx = (Math.round(cx / cell) + 2048) & 0xfff;
        const gy = (Math.round(cy / cell) + 2048) & 0xfff;
        const key = (gx << 20) | (gy << 8) | (worldR & 0xff);
        if (seen.has(key)) continue;
        seen.add(key);
        fg.drawImage(mask, cx - r, cy - r, r * 2, r * 2);
      }
      // Composite in screen space too, then hand the transform back.
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(fogCanvas, 0, 0, w, h);
      ctx.restore();
    }
  }

  // Spawn anchors — subtle rings labeled by side colour.
  const spawnR = Math.max(minFurniturePx, SPAWN_RING_WORLD * k);
  for (const s of playback.spawns) {
    ctx.beginPath();
    ctx.arc(projectX(bounds, proj, s.x), projectY(bounds, proj, s.y), spawnR, 0, Math.PI * 2);
    ctx.strokeStyle = s.owner === "me" ? "rgba(62,192,199,0.35)" : "rgba(224,86,86,0.35)";
    ctx.lineWidth = 1.5 / view.z;
    ctx.stroke();
  }

  drawSpellEffects(ctx, playback, t, proj, view, w, h, "ground");

  /* ── Painter's pass ────────────────────────────────────────────
   * Back to front by ground-point Y. Sorting an index array keeps the
   * pooled entity records stable and allocates nothing after warmup.
   */
  drawOrder.length = entityCount;
  for (let i = 0; i < entityCount; i += 1) drawOrder[i] = i;
  drawOrder.sort((a, b) => entityPool[a].y - entityPool[b].y);

  let alpha = 1;
  for (let i = 0; i < entityCount; i += 1) {
    const e = entityPool[drawOrder[i]];
    if (e.alpha !== alpha) {
      ctx.globalAlpha = e.alpha;
      alpha = e.alpha;
    }
    if (
      e.handle &&
      drawSprite(ctx, e.handle, e.color, e.facing, e.frame, e.x, e.y, e.cellPx)
    ) {
      continue;
    }
    // No sheet for this name (or it hasn't decoded yet): the flat
    // team-tinted icon, then a bare dot.
    const size = e.cellPx;
    const token = iconToken(e.name, e.iconKind, e.tint, size, iconDpr);
    if (token) {
      ctx.drawImage(token, e.x - size / 2, e.y - size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1.4, size * 0.18), 0, Math.PI * 2);
      ctx.fillStyle = e.dot;
      ctx.fill();
    }
  }
  if (alpha !== 1) ctx.globalAlpha = 1;

  drawSpellEffects(ctx, playback, t, proj, view, w, h, "overlay");

  // Battle pulses near their marker time — drawn last so the amber
  // ring reads over the sprites it is calling attention to.
  for (const m of playback.battles) {
    const d = Math.abs(m.t - t);
    if (d > BATTLE_WINDOW_SEC) continue;
    const f = 1 - d / BATTLE_WINDOW_SEC;
    ctx.beginPath();
    ctx.arc(
      projectX(bounds, proj, m.x),
      projectY(bounds, proj, m.y),
      Math.max(minFurniturePx, (BATTLE_RING_MIN_WORLD + BATTLE_RING_GROW_WORLD * f) * k),
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = `rgba(230,180,80,${0.15 + 0.5 * f})`;
    ctx.lineWidth = 2 / view.z;
    ctx.stroke();
  }

  ctx.restore();

  // Edge vignette, OUTSIDE the view transform so it hugs the stage
  // rather than the map. This replaces the old global dark wash: the
  // terrain keeps its real colour, and only the border darkens enough
  // to separate the stage from the page.
  const vignette = vignetteFor(w, h, ctx);
  if (vignette) {
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Cached vignette gradient, per context — rebuilt only when the
 * stage resizes, so the per-frame cost is one fillRect. */
const vignetteCache = new WeakMap<
  CanvasRenderingContext2D,
  { w: number; h: number; grad: CanvasGradient }
>();

function vignetteFor(
  w: number,
  h: number,
  ctx: CanvasRenderingContext2D,
): CanvasGradient | null {
  const hit = vignetteCache.get(ctx);
  if (hit && hit.w === w && hit.h === h) return hit.grad;
  if (!(w > 0 && h > 0)) return null;
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.hypot(cx, cy);
  const grad = ctx.createRadialGradient(cx, cy, outer * VIGNETTE_INNER, cx, cy, outer);
  grad.addColorStop(0, "rgba(6,9,14,0)");
  grad.addColorStop(1, `rgba(6,9,14,${VIGNETTE_ALPHA})`);
  vignetteCache.set(ctx, { w, h, grad });
  return grad;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
