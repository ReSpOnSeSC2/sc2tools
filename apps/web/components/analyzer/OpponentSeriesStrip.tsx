"use client";

import Link from "next/link";
import { currentAndBestStreak, chronological, decidedOnly, gameOutcome } from "@/lib/h2hSeries";
import { fmtAgo, fmtDay, fmtMonthYear } from "@/lib/format";
import type { DossierSeriesData } from "@/lib/dossierTypes";

export function OpponentSeriesStrip({ series }: { series: DossierSeriesData }) {
  const games = series.games.slice(0, 1000), decided = decidedOnly(games), streaks = currentAndBestStreak(games);
  const lower = series.truncated && streaks.current?.count === decided.length ? "≥" : "";
  const latest = chronological(decided.slice(0, 10));
  const sample = series.truncated ? `latest ${Math.min(games.length, series.sourceLimit)} meetings` : "all recorded meetings";
  return <section aria-label="All-time series" className="space-y-2 text-caption text-text-muted">
    <p className="flex flex-wrap gap-x-3 gap-y-1"><span>First met {fmtMonthYear(series.firstSeen)}</span><span>Last met {fmtAgo(series.lastSeen)}</span><span>Current: {streaks.current ? `${streaks.current.result}${lower}${streaks.current.count}` : "—"}</span><span>Best{series.truncated ? " in sample" : ""}: W{streaks.bestWin}</span></p>
    <p className="text-micro text-text-dim">All-time dates. Streaks use {sample}; dossier drill-down filters do not change this strip.</p>
    {latest.length ? <ol aria-label="Last 10 decided results, newest on the right" className="flex flex-wrap gap-1.5">{latest.map((game, index) => {
      const result = gameOutcome(game), name = `${result === "W" ? "Win" : "Loss"} on ${game.map || "unknown map"}, ${fmtDay(game.date)}`;
      const style = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-2 font-mono font-semibold ${result === "W" ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`;
      return <li key={`${game.id ?? "unknown"}:${index}`}>{game.id ? <Link href={`/app/game/${encodeURIComponent(game.id)}`} aria-label={name} title={name} className={`${style} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>{result}</Link> : <span title={`${name}; replay link unavailable`} aria-label={`${name}; replay link unavailable`} className={style}>{result}</span>}</li>;
    })}</ol> : <p className="text-micro">No decided meetings recorded yet.</p>}
  </section>;
}
