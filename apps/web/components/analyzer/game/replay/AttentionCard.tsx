"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { formatGameClock } from "@/lib/macro";
import type { MapPlayback } from "@/lib/mapReplay";
import { Button } from "@/components/ui/Button";
import { fullReplayAttention, replayAttention, type ReadAttentionSections } from "@/lib/replayAttention";

export function AttentionCard({ playback, start, end, readAll }: { playback: MapPlayback; start?: number; end?: number; readAll?: ReadAttentionSections }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"me" | "opp">("me");
  const ref = useRef<HTMLCanvasElement>(null);
  const [full, setFull] = useState<Awaited<ReturnType<typeof fullReplayAttention>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const data = useMemo(() => !open ? null : full ? full[side] : replayAttention(playback, side,
    start !== undefined && end !== undefined ? { start, end } : undefined), [open, full, playback, side, start, end]);

  async function analyzeReplay() {
    if (!readAll || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(false);
    const timeout = window.setTimeout(() => { setError(true); request.abort(); }, 90_000);
    try {
      const result = await fullReplayAttention(readAll(request.signal), playback.gameLength, request.signal);
      setFull(result);
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      window.clearTimeout(timeout);
      controller.current = null;
      setLoading(false);
    }
  }
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
  if (!playback.camera && !full) return <p className="text-caption text-text-muted">Camera data unavailable. <Link className="text-accent underline" href="/settings?tab=backups">Re-analyze with the updated desktop app</Link>.</p>;
  return <details open={open} onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) controller.current?.abort();
  }} className="rounded-lg border border-border p-3">
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
        {full ? <p className="text-text-muted">Full replay</p> : start !== undefined && end !== undefined
          ? <p className="text-text-muted">Loaded replay section · {formatGameClock(start)}–{formatGameClock(end)}</p> : null}
        {readAll && !full ? <div className="flex flex-wrap items-center gap-2">
          {loading ? <><p role="status">Loading replay sections…</p><Button variant="ghost" size="sm" onClick={() => controller.current?.abort()}>Cancel</Button></>
            : <Button variant="secondary" size="sm" onClick={() => void analyzeReplay()}>Analyze full replay</Button>}
          {error ? <p role="alert">Couldn&apos;t load the full replay. The current section is still available.</p> : null}
        </div> : null}
        {data ? <>
          <p>{data.nearArmy}% near own army · {data.nearBase}% near own town halls</p>
          <p className="text-micro text-text-muted">{data.samples} camera samples, every {data.interval} s. Areas can overlap.</p>
          {data.fights.length ? <ul>{data.fights.map((fight, index) => <li key={index}>{formatGameClock(fight.time)} · {fight.lookedAway === null ? "Earlier camera position unavailable" : fight.lookedAway ? "Looked away in the prior 5 s" : "Looked near this fight in the prior 5 s"}</li>)}</ul> : null}
        </> : <p className="text-text-muted">{full ? "No camera samples for this side in this replay." : "No camera samples for this side in the loaded section."}</p>}
      </div>
    </div> : null}
  </details>;
}
