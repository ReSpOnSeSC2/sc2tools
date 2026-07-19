"use client";

/**
 * MapReplayer — vespene.gg-style playback of one game on its map.
 *
 * Renders the agent-uploaded playback payload (unit waypoint tracks,
 * building placements, battle markers, spawns, per-side stats) on a
 * canvas with a scrubbable timeline: play/pause, 1×–16× speed, and a
 * live HUD (army value · workers · supply per side). Buildings appear
 * as squares when placed, units as dots interpolated along their real
 * movement tracks — with deterministic cluster spreading so a stacked
 * army reads as a blob of distinguishable dots instead of one pixel
 * (see ``spreadClusters`` in lib/mapReplay.ts).
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
  unitPositionAt,
  worldProjection,
  type MapPlayback,
} from "@/lib/mapReplay";

const SPEEDS = [1, 4, 8, 16] as const;
const ME_ARMY = "#3ec0c7";
const ME_WORKER = "rgba(62,192,199,0.45)";
const OPP_ARMY = "#e05656";
const OPP_WORKER = "rgba(224,86,86,0.45)";
const BATTLE = "#e6b450";
/** How long a battle marker pulses around its timestamp. */
const BATTLE_WINDOW_SEC = 12;
/** Cluster cell + spacing in canvas px — the unit-spacing tuning. */
const CLUSTER_CELL_PX = 10;
const CLUSTER_SPACING_PX = 4.5;

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
      renderFrame(ctx, canvas, playback, timeRef.current);
    };
    let lastReactSync = -1;
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
      const h = Math.max(220, Math.min(560, w * aspect));
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
        <button
          type="button"
          onClick={() => {
            if (!playing && timeRef.current >= gameLength) setTime(0);
            setPlaying((p) => !p);
          }}
          className="rounded-md border border-border bg-bg-elevated px-3 py-1 text-caption font-semibold text-text hover:border-accent"
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            aria-pressed={speed === s}
            className={`rounded-md border px-2 py-1 text-micro font-semibold ${
              speed === s
                ? "border-accent bg-accent/15 text-text"
                : "border-border bg-bg-elevated text-text-muted hover:border-accent"
            }`}
          >
            {s}×
          </button>
        ))}
        <span className="ml-auto text-caption tabular-nums text-text-muted">
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

      <input
        type="range"
        min={0}
        max={Math.ceil(gameLength)}
        step={1}
        value={Math.round(timeSec)}
        onChange={(e) => setTime(Number(e.target.value))}
        aria-label="Playback position"
        className="w-full accent-[#3ec0c7]"
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-caption tabular-nums">
        <span>
          <b style={{ color: ME_ARMY }}>You</b>{" "}
          <span className="text-text-muted">
            army {Math.round(me.army)} · {Math.round(me.workers)} workers ·{" "}
            {Math.round(me.supply)} supply
          </span>
        </span>
        <span>
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
) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const { bounds } = playback;
  const proj = worldProjection(bounds, w, h);

  ctx.clearRect(0, 0, w, h);

  // Spawn anchors — subtle rings labeled by side color.
  for (const s of playback.spawns) {
    ctx.beginPath();
    ctx.arc(projectX(bounds, proj, s.x), projectY(bounds, proj, s.y), 12, 0, Math.PI * 2);
    ctx.strokeStyle = s.owner === "me" ? "rgba(62,192,199,0.35)" : "rgba(224,86,86,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Buildings placed by now — squares, town halls bigger.
  for (const b of playback.buildings) {
    if (b.t > t) continue;
    const size = isTownHall(b.name) ? 9 : 5;
    ctx.fillStyle = b.owner === "me" ? "rgba(62,192,199,0.75)" : "rgba(224,86,86,0.75)";
    ctx.fillRect(
      projectX(bounds, proj, b.x) - size / 2,
      projectY(bounds, proj, b.y) - size / 2,
      size,
      size,
    );
  }

  // Battle pulses near their marker time.
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

  // Units alive now — interpolate, then spread clusters so armies read
  // as blobs of dots instead of a single pixel.
  const alive: Array<{ idx: number; x: number; y: number }> = [];
  playback.units.forEach((u, idx) => {
    if (!unitAliveAt(u, t)) return;
    const pos = unitPositionAt(u.wp, t);
    if (!pos) return;
    alive.push({
      idx,
      x: projectX(bounds, proj, pos.x),
      y: projectY(bounds, proj, pos.y),
    });
  });
  const spread = spreadClusters(alive, CLUSTER_CELL_PX, CLUSTER_SPACING_PX);
  spread.forEach((pos, i) => {
    const unit = playback.units[alive[i].idx];
    const worker = isWorkerUnit(unit.name);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, worker ? 1.6 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle =
      unit.owner === "me"
        ? worker
          ? ME_WORKER
          : ME_ARMY
        : worker
          ? OPP_WORKER
          : OPP_ARMY;
    ctx.fill();
  });
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
