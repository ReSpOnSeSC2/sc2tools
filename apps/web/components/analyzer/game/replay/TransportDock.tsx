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
 */

import { memo, type ReactNode } from "react";
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
  "inline-flex h-9 min-w-[2.25rem] items-center justify-center rounded-md border border-border bg-bg-elevated px-2 text-caption font-semibold text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

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
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40 transition-transform hover:scale-150 focus-visible:scale-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{
            left: `${Math.min(100, Math.max(0, (m.t / gameLength) * 100))}%`,
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
    <div className="relative h-3.5" aria-hidden>
      {phases.map((p) => (
        <span
          key={p.label}
          className="absolute top-0 truncate border-l border-border pl-1 text-[0.6rem] font-semibold uppercase leading-none tracking-wider text-text-dim"
          style={{
            left: `${(p.from / gameLength) * 100}%`,
            width: `${((p.to - p.from) / gameLength) * 100}%`,
          }}
        >
          {p.label}
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
  return (
    <div
      data-testid="replay-transport"
      className="flex items-center gap-2 border-t border-border px-3 py-2"
    >
      <button
        type="button"
        onClick={() => onSeek(0)}
        aria-label="Skip to start"
        title="Skip to start"
        className={DOCK_BUTTON_CLASS}
      >
        <span aria-hidden>⏮</span>
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
        className={DOCK_BUTTON_CLASS}
      >
        <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      </button>
      <button
        type="button"
        onClick={() => onSpeedChange(nextSpeed(speed))}
        aria-label={`Playback speed ${speed} times. Click to cycle.`}
        title="Playback speed"
        className={DOCK_BUTTON_CLASS}
      >
        {speed}×
      </button>

      <div className="min-w-0 flex-1">
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
          className="h-6 w-full cursor-pointer accent-[#3ec0c7]"
        />
      </div>

      <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-text-muted">
        {formatClock(t)} / {formatClock(gameLength)}
      </span>
      {music ? <MusicControl music={music} /> : null}
      {children}
    </div>
  );
}

export const TransportDock = memo(TransportDockImpl);
