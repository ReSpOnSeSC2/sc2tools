"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { formatGameClock } from "@/lib/macro";
import type { MapPlayback } from "@/lib/mapReplay";
import { replayAttention } from "@/lib/replayAttention";

export function AttentionCard({ playback, start, end }: { playback: MapPlayback; start?: number; end?: number }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"me" | "opp">("me");
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useMemo(() => open ? replayAttention(playback, side,
    start !== undefined && end !== undefined ? { start, end } : undefined) : null, [open, playback, side, start, end]);
  useEffect(() => {
    const context = ref.current?.getContext("2d");
    if (!context || !data) return;
    const peak = Math.max(1, ...data.grid);
    context.clearRect(0, 0, 64, 64);
    data.grid.forEach((value, index) => {
      if (value) {
        context.fillStyle = `rgba(255, 151, 53, ${0.18 + 0.82 * Math.sqrt(value / peak)})`;
        context.fillRect(index % 64, Math.floor(index / 64), 1, 1);
      }
    });
  }, [data]);
  if (!playback.camera) return <p className="text-caption text-text-muted">Camera data unavailable. <Link className="text-accent underline" href="/settings?tab=backups">Re-analyze with the updated desktop app</Link>.</p>;
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded-lg border border-border p-3">
    <summary className="min-h-9 cursor-pointer text-body font-semibold">Camera attention</summary>
    {open ? <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
      <div className="relative aspect-square w-40 overflow-hidden rounded">
        <MapArtwork mapName={playback.mapName} size="card" />
        {data ? <canvas ref={ref} width={64} height={64} className="absolute inset-0 h-full w-full" role="img" aria-label="Camera position density, brighter where the selected player spent more time" /> : null}
      </div>
      <div className="space-y-2 text-caption">
        <label className="flex items-center gap-2">Camera<select value={side} onChange={event => setSide(event.target.value === "opp" ? "opp" : "me")} className="min-h-11 rounded-md border border-border bg-bg-surface px-2">
          <option value="me">You</option><option value="opp">Opponent</option>
        </select></label>
        {start !== undefined && end !== undefined ? <p className="text-text-muted">Loaded replay section · {formatGameClock(start)}–{formatGameClock(end)}</p> : null}
        {data ? <>
          <p>{data.nearArmy}% near own army · {data.nearBase}% near own town halls</p>
          <p className="text-micro text-text-muted">{data.samples} camera samples, every {data.interval} s. Areas can overlap.</p>
          {data.fights.length ? <ul>{data.fights.map((fight, index) => <li key={index}>{formatGameClock(fight.time)} · {fight.lookedAway === null ? "Earlier camera position unavailable" : fight.lookedAway ? "Looked away in the prior 5 s" : "Looked near this fight in the prior 5 s"}</li>)}</ul> : null}
        </> : <p className="text-text-muted">No camera samples for this side in the loaded section.</p>}
      </div>
    </div> : null}
  </details>;
}
