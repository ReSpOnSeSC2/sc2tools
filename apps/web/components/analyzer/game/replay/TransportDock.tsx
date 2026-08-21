"use client";

/**
 * TransportDock — the bar under the stage.
 *
 * Skip-to-start · play/pause · speed cycle (1× → 4× → 8× → 16×) · a
 * real ``<input type="range">`` scrubber with a strip of clickable
 * event markers above it and the phase bands above that.
 *
 * The markers are real ``<button>``s, not decorated divs: each is
 * focusable, has an accessible name (``2:35 · Harass taken: 150
 * minerals``) and seeks on activation, so the timeline is usable from
 * the keyboard alone. They sit in their own strip rather than on top of
 * the range, so neither steals pointer events from the other.
 *
 * THE SCRUBBER stays a native range input — that is what makes it
 * keyboard- and AT-operable for free — but it wears
 * ``.replay-range`` (app/globals.css), which paints the played portion
 * from the ``--replay-progress`` custom property set here. A separate
 * progress element layered under a transparent input would have to
 * fight the input for pointer events; a gradient on the track cannot.
 *
 * The phase strip is BANDS, not floating labels: the old version drew
 * a bare left border and a dim caption, which on a short game left
 * three barely-legible words hanging over the timeline with nothing to
 * say which stretch each one covered.
 */

import { memo, type CSSProperties, type ReactNode } from "react";
import { Pause, Play, SkipBack } from "lucide-react";
import { formatClock, type TimelineMarker } from "@/lib/replayHud";
import type { PhaseBand } from "@/lib/replayHud";
import type { ReplayMusicApi } from "@/lib/replayMusic";
import { MusicControl } from "./MusicControl";
import { SIDE_COLOR } from "./replayTheme";

export const REPLAY_SPEEDS = [1, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function nextSpeed(speed: ReplaySpeed): ReplaySpeed {
  const i = REPLAY_SPEEDS.indexOf(speed);
  return REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length];
}

const MARKER_COLOR: Readonly<Record<TimelineMarker["kind"], string>> = {
  battle: "#f0a83c",
  cast: "#9b7bd4",
};

const DOCK_BUTTON_CLASS =
  "inline-flex h-9 min-w-[2.25rem] shrink-0 items-center justify-center rounded-md border border-border bg-bg-elevated px-2 text-caption font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan";

/** Clamp to [0, 100] so a marker past the last stats sample — or a
 *  ``gameLength`` of 0 — cannot escape the strip. */
function pct(t: number, gameLength: number): number {
  if (!(gameLength > 0)) return 0;
  return Math.min(100, Math.max(0, (t / gameLength) * 100));
}

function MarkerDots({
  markers,
  gameLength,
  onSeek,
}: {
  markers: readonly TimelineMarker[];
  gameLength: number;
  onSeek: (t: number) => void;
}) {
  return (
    <div
      className="relative h-3"
      role="group"
      aria-label="Notable moments on the timeline"
    >
      {markers.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onSeek(m.t)}
          title={m.title}
          aria-label={`${m.title}. Jump here.`}
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-black/50 transition-transform hover:scale-[1.6] focus-visible:scale-[1.6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
          style={{
            left: `${pct(m.t, gameLength)}%`,
            background: m.owner ? SIDE_COLOR[m.owner] : MARKER_COLOR[m.kind],
          }}
        />
      ))}
    </div>
  );
}

function PhaseStrip({
  phases,
  gameLength,
}: {
  phases: readonly PhaseBand[];
  gameLength: number;
}) {
  if (phases.length < 2) return null;
  return (
    <div className="relative h-3" aria-hidden>
      {phases.map((p, i) => (
        <span
          key={p.label}
          className="absolute top-0 flex h-full items-center overflow-hidden rounded-sm px-1"
          style={{
            left: `${pct(p.from, gameLength)}%`,
            width: `${Math.max(0, pct(p.to, gameLength) - pct(p.from, gameLength))}%`,
            // Alternating weight reads as "these are consecutive
            // stretches of the game" without needing three colours.
            background: i % 2 === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.09)",
            // A hard right edge so consecutive bands read as separate
            // stretches rather than one long strip.
            boxShadow: "inset -1px 0 0 rgba(7,10,15,0.9)",
          }}
        >
          <span className="truncate text-[0.5625rem] font-semibold uppercase leading-none tracking-[0.1em] text-text-dim">
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function TransportDockImpl({
  t,
  gameLength,
  playing,
  speed,
  markers,
  phases,
  onSeek,
  onPlayingChange,
  onSpeedChange,
  music,
  children,
}: {
  t: number;
  gameLength: number;
  playing: boolean;
  speed: ReplaySpeed;
  markers: readonly TimelineMarker[];
  phases: readonly PhaseBand[];
  onSeek: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
  /** Background-score state from ``useReplayMusic``. Omitted (the
   *  compact host, tests) and the dock simply has no music control. */
  music?: ReplayMusicApi;
  /** Settings popover and any other trailing controls. */
  children?: ReactNode;
}) {
  const progress = pct(t, gameLength);
  return (
    <div
      data-testid="replay-transport"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-surface/60 px-3 py-2"
    >
      <button
        type="button"
        onClick={() => onSeek(0)}
        aria-label="Skip to start"
        title="Skip to start"
        className={DOCK_BUTTON_CLASS}
      >
        <SkipBack className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => {
          // Restarting from the end is the obvious intent of pressing
          // play on a finished replay.
          if (!playing && t >= gameLength) onSeek(0);
          onPlayingChange(!playing);
        }}
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        title={playing ? "Pause" : "Play"}
        className={`${DOCK_BUTTON_CLASS} border-accent-cyan/50 bg-accent-cyan/15 hover:border-accent-cyan hover:bg-accent-cyan/25`}
      >
        {playing ? (
          <Pause className="h-4 w-4" aria-hidden />
        ) : (
          <Play className="h-4 w-4" aria-hidden />
        )}
      </button>
      <button
        type="button"
        onClick={() => onSpeedChange(nextSpeed(speed))}
        aria-label={`Playback speed ${speed} times. Click to cycle.`}
        title="Playback speed"
        className={`${DOCK_BUTTON_CLASS} tabular-nums`}
      >
        {speed}×
      </button>

      <div className="min-w-0 flex-1 pt-0.5">
        <PhaseStrip phases={phases} gameLength={gameLength} />
        <MarkerDots markers={markers} gameLength={gameLength} onSeek={onSeek} />
        <input
          type="range"
          min={0}
          max={Math.ceil(gameLength)}
          step={1}
          value={Math.round(Math.min(gameLength, Math.max(0, t)))}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Playback position"
          aria-valuetext={`${formatClock(t)} of ${formatClock(gameLength)}`}
          className="replay-range"
          style={{ "--replay-progress": `${progress}%` } as CSSProperties}
        />
      </div>

      {/* ONE text run on purpose: hosts and tests read this label as
          "8:42 / 21:07", and splitting the total into a child element
          would break that into two nodes. */}
      <span className="shrink-0 whitespace-nowrap text-caption font-semibold tabular-nums text-text">
        {formatClock(t)} / {formatClock(gameLength)}
      </span>
      {music ? <MusicControl music={music} /> : null}
      {children}
    </div>
  );
}

export const TransportDock = memo(TransportDockImpl);
