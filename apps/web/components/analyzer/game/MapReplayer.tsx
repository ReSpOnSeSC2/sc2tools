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
 * follow recorded positions with bounded interpolation and face the
 * observed direction of travel. Missing movement is held at the last
 * observation; no mining routes or builder units are synthesized. Anything with no sheet (Larva, Egg, Broodling,
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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { statsAt, worldProjection, type MapPlayback } from "@/lib/mapReplay";

import { spriteAssetsVersion } from "@/lib/spriteSheets";
import { computeLosses, morphConsumedIndices, statsHaveWorkers, tradeEfficiency, workerCountAt, type LossSummary } from "@/lib/mapReplayLosses";
import type { PatchEra } from "@/lib/meta";
import { spellEffectsVersion } from "@/lib/spellEffects";



import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from "lucide-react";
import { getMapLayoutUrl } from "@/lib/map-images";
import { getIconPath } from "@/lib/sc2-icons";
import { REPLAY_SCOPE_CLASS } from "./replay/replayTheme";
import { markerAt, type ReplayMapMarker } from "@/lib/replayMarkers";

import { renderFrame } from "./replay/mapCanvasRenderer";
import { ME_ARMY, OPP_ARMY, STAGE_VIEWPORT_FRACTION, STAGE_MIN_H_PX, STAGE_MAX_H_PX, STAGE_PAD_PX, derivedOf, assetsVersion, bumpReplayAssetsVersion } from "./replay/mapCanvasAssets";

export type { ReplayMapMarker };

const SPEEDS = [1, 4, 8, 16] as const;

/** A pointer that travelled further than this is a drag, not a tap. */
const TAP_SLOP_PX = 6;
/** The floating map-view controls. Glass over the canvas, so they read
 *  at any terrain colour without a hard panel cutting into the map. */
const VIEW_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3ee0d6]";
export function MapReplayer({
  playback,
  playbackWindow,
  buffering = false,
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
  /* ── Optional host interaction (review pins) ────────────────────
   * ``onWorldClick`` receives the WORLD point under a tap/click (never
   * a drag or pinch) plus the exact clock time, ``markers`` draws
   * numbered pins, ``onMarkerClick`` fires when a pin is tapped. All
   * three live in refs, so neither the rAF loop nor the pointer
   * listeners re-bind when a host passes fresh arrays. */
  onWorldClick,
  markers,
  onMarkerClick,
  /** The game's patch era (lib/ladderPulse ``patchEraForGame``). It
   * prices the units-lost panels; omitted, the live 12-worker game.
   * MapPlayback carries no game version, so the host passes it. */
  patchEra,
}: {
  playback: MapPlayback;
  /** The loaded segment. The clock waits at its end until the next arrives. */
  playbackWindow?: { start: number; end: number };
  buffering?: boolean;
  maxHeightPx?: number;
  time?: number;
  onTimeChange?: (t: number) => void;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  speed?: (typeof SPEEDS)[number];
  onSpeedChange?: (speed: (typeof SPEEDS)[number]) => void;
  hideControls?: boolean;
  fill?: boolean;
  onWorldClick?: (x: number, y: number, t: number) => void;
  markers?: readonly ReplayMapMarker[];
  onMarkerClick?: (id: string) => void;
  patchEra?: PatchEra | null;
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
  const onWorldClickRef = useRef(onWorldClick);
  onWorldClickRef.current = onWorldClick;
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
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
  const windowRef = useRef(playbackWindow);
  const bufferingRef = useRef(buffering);
  windowRef.current = playbackWindow;
  bufferingRef.current = buffering;
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
  const [zoomHint, setZoomHint] = useState(false);
  const mapControlsId = useId();

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
    canvas.style.touchAction = z <= 1 ? "pan-y" : "none";
  }, []);

  const resetView = useCallback(() => {
    viewRef.current = { z: 1, ox: 0, oy: 0 };
    if (canvasRef.current) canvasRef.current.style.touchAction = "pan-y";
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
        bumpReplayAssetsVersion();
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

  // Apply controlled seeks before the next animation frame can emit an old
  // position. External seek (a marker click in the host's transport dock). Skips
  // the host echoing our own tick back, so a controlled clock advances
  // in the loop and is never dragged backwards by a 4 Hz round trip.
  useLayoutEffect(() => {
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
      if (lastTs !== null && playingRef.current && !bufferingRef.current) {
        const dt = ((ts - lastTs) / 1000) * speedRef.current;
        const segmentEnd = windowRef.current?.end ?? gameLength;
        const next = Math.min(segmentEnd, timeRef.current + dt);
        if (next >= gameLength) {
          timeRef.current = gameLength;
          emitTime(gameLength);
          emitPlaying(false);
        } else {
          timeRef.current = next;
          // Throttle React state to ~4 Hz — the canvas doesn't need it,
          // only the time label / scrubber do.
          if (Math.abs(next - lastReactSync) > 0.25 || (next === segmentEnd && next !== lastReactSync)) {
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
        view.oy !== drawn.oy ||
        markersRef.current !== drawn.mk;
      if (dirty) {
        renderFrame(ctx, canvas, playback, timeRef.current, layoutImageRef.current, view, markersRef.current);
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
          mk: markersRef.current,
        };
      }
    };
    let lastReactSync = -1;
    let drawn: {
      t: number; v: number; sv: number; cw: number; ch: number; z: number; ox: number; oy: number;
      mk: readonly ReplayMapMarker[] | undefined;
    } = { t: -1, v: -1, sv: -1, cw: 0, ch: 0, z: 1, ox: 0, oy: 0, mk: undefined };
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
    // Tap detection for host clicks: a gesture that pans, pinches or
    // wanders past TAP_SLOP_PX is not a click on the map.
    let tapStart: { x: number; y: number } | null = null;
    let tapMoved = false;

    const local = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let lastHint = 0;
    const onWheel = (e: WheelEvent) => {
      if (!fullscreenRef.current && !e.ctrlKey && !e.metaKey && document.activeElement !== canvas) {
        if (Date.now() - lastHint > 1500) {
          lastHint = Date.now(); setZoomHint(true);
          clearTimeout(hintTimer); hintTimer = setTimeout(() => setZoomHint(false), 1500);
        }
        return;
      }
      e.preventDefault();
      const pt = local(e);
      applyZoom(pt.x, pt.y, Math.pow(1.0015, -e.deltaY));
    };
    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) {
        tapStart = local(e);
        tapMoved = false;
      } else {
        tapMoved = true;
      }
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
      if (tapStart && Math.hypot(now.x - tapStart.x, now.y - tapStart.y) > TAP_SLOP_PX) tapMoved = true;
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
    const onClick = (e: MouseEvent) => {
      canvas.focus({ preventScroll: true });
      const moved = tapMoved;
      tapStart = null;
      tapMoved = false;
      if (moved || e.detail > 1) return; // drag, pinch, or the 2nd click of a dblclick
      const pt = local(e);
      const v = viewRef.current;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const cw = canvas.width / dpr;
      const ch = canvas.height / dpr;
      const b = playbackRef.current.bounds;
      const proj = worldProjection(b, cw, ch, STAGE_PAD_PX);
      if (!(proj.k > 0)) return;
      // Pins first, in screen px (they are drawn at a constant size).
      const hitMarker = onMarkerClickRef.current
        ? markerAt(markersRef.current ?? [], b, proj, v, pt, timeRef.current)
        : undefined;
      if (hitMarker && onMarkerClickRef.current) {
        onMarkerClickRef.current(hitMarker.id);
        return;
      }
      const handler = onWorldClickRef.current;
      if (!handler) return;
      // Exact inverse of renderFrame: undo zoom/pan, then the projection
      // (world Y points up; the canvas flips it).
      const sx = (pt.x - v.ox) / v.z;
      const sy = (pt.y - v.oy) / v.z;
      const worldX = b.minX + (sx - proj.ox) / proj.k;
      const worldY = b.maxY - (sy - proj.oy) / proj.k;
      if (worldX < b.minX || worldX > b.maxX || worldY < b.minY || worldY > b.maxY) return;
      handler(worldX, worldY, timeRef.current);
    };

    const releaseFocus = () => { if (document.activeElement === canvas) canvas.blur(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") releaseFocus(); };
    let gestureScale = 1;
    const onGestureStart = (event: Event) => { event.preventDefault(); gestureScale = 1; };
    const onGestureChange = (event: Event) => {
      event.preventDefault(); const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      if (Number.isFinite(gesture.scale) && gesture.scale > 0) {
        const pt = local(gesture); applyZoom(pt.x, pt.y, gesture.scale / gestureScale); gestureScale = gesture.scale;
      }
    };
    canvas.addEventListener("pointerleave", releaseFocus);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, { passive: false });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("click", onClick);
      clearTimeout(hintTimer);
      canvas.removeEventListener("pointerleave", releaseFocus);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
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
    () => computeLosses(playback.units, "me", timeSec, consumed, patchEra),
    [playback, timeSec, consumed, patchEra],
  );
  const oppLosses = useMemo(
    () => computeLosses(playback.units, "opp", timeSec, consumed, patchEra),
    [playback, timeSec, consumed, patchEra],
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
          <p id={mapControlsId} className="sr-only">Hold Ctrl or Command while scrolling to zoom, or click the map first. Drag when zoomed. Escape releases map focus. Double-click resets the view.</p>
          {zoomHint ? <span aria-hidden className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded bg-black/80 px-3 py-2 text-caption text-white">{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Hold ⌘ to zoom" : "Hold Ctrl to zoom"}</span> : null}
          <canvas
            ref={canvasRef}
            tabIndex={0}
            style={{ touchAction: "pan-y" }}
            aria-describedby={mapControlsId}
            className="block h-full w-full rounded-lg bg-[#0a0d13] shadow-[0_10px_40px_-16px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-white/[0.14]"
            aria-label={`Map playback of ${playback.mapName || "this game"}`}
          />
          <div
            className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded-md border border-white/10 bg-black/70 px-2 py-1 text-[10px] leading-snug text-white/80"
            role="note"
            aria-label="Replay accuracy"
          >
            {playback.fidelity?.positions === "engine"
              ? "Recorded game playback"
              : playback.v >= 6 ? "Limited position data · gaps hold last position" : "Older replay data · re-sync for accurate positions"}
            {playback.fidelity?.complete === false ? " · partial recording" : ""}
            {playback.fidelity?.positions === "engine" && playback.fidelity.attacks !== "observed" ? " · regenerate for attacks" : ""}
            {!playback.creep && derivedOf(playback).creepSources.length > 0 ? " · estimated creep" : ""}
          </div>
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
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
