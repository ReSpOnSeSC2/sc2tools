"use client";
import { useId } from "react";
import { formatGameClock } from "@/lib/macro";
import { GameClockLink } from "./GameClockLink";

export function GameClockControls({ time, duration, onSeek, getHref }: { time: number; duration?: number | null; onSeek: (time: number) => void; getHref: () => string }) {
  const id = useId();
  return <div role="group" aria-label="Game clock" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg-surface p-3">
    <label htmlFor={id} className="text-caption font-semibold text-text">Game time</label><output className="font-mono text-caption tabular-nums" data-testid="game-clock-readout">{formatGameClock(time)}</output>
    <input id={id} type="range" min={0} max={Math.max(1, duration || time || 1)} step={1} value={time} onChange={(event) => onSeek(Number(event.target.value))} aria-label="Scrub game time" aria-valuetext={formatGameClock(time)} className="h-11 min-w-24 flex-1 accent-[rgb(var(--accent))]" />
    <GameClockLink time={time} getHref={getHref} />
  </div>;
}
