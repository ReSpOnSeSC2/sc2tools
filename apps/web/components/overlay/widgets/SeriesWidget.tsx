"use client";

import { useContext, useMemo } from "react";
import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
import { normalizeSeriesSnapshot, SERIES_SAMPLE, type SeriesSnapshot } from "@/lib/streamSeries";
import { RaceIcon, WidgetShell } from "../WidgetShell";
import styles from "./SeriesWidget.module.css";

export function SeriesScoreboard({ series, preview = false }: { series: SeriesSnapshot; preview?: boolean }) {
  const needed = Math.ceil(series.format / 2);
  const finished = series.status === "complete";
  return <div className={`${styles.root} min-w-0 space-y-3`} aria-label={`Bo${series.format} series score`}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"><span>BEST OF {series.format}</span><span>{preview ? "SAMPLE" : finished ? series.score.you > series.score.opponent ? "SERIES WON" : "SERIES LOST" : series.status === "paused" ? "AUTO-SCORING PAUSED" : series.status === "ended" ? "ENDED" : "IN PROGRESS"}</span></div>
    <div className={styles.scoreboard}>
      <div className={styles.you}><span className="flex items-center gap-2 font-semibold"><RaceIcon race={series.playerRace ?? "U"} />You</span><Pips score={series.score.you} needed={needed} label="Your wins" /></div>
      <strong className={`${styles.score} text-h2 tabular-nums`}>{series.score.you}–{series.score.opponent}</strong>
      <div className={styles.opponent}><span className="flex min-w-0 items-center justify-end gap-2 font-semibold"><span className={styles.opponentName} title={series.opponentName}>{series.opponentName}</span><RaceIcon race={series.opponentRace ?? "U"} /></span><Pips score={series.score.opponent} needed={needed} label="Opponent wins" /></div>
    </div>
    {series.currentMap ? <p className="break-words text-caption"><span className="text-text-muted">{finished || series.status === "ended" ? "Last map" : "Current map"}: </span>{series.currentMap}{series.nextMap && !finished && series.status !== "ended" ? <span className="text-text-muted"> · Next: {series.nextMap}</span> : null}</p> : <p className="text-caption text-text-muted">No map order set</p>}
    <p className="text-caption text-text-muted">{series.headToHead ? `Recorded lifetime H2H: ${series.headToHead.wins}W–${series.headToHead.losses}L${series.headToHead.draws ? `–${series.headToHead.draws}D` : ""}` : "Recorded lifetime H2H unavailable"}</p>
  </div>;
}
function Pips({ score, needed, label }: { score: number; needed: number; label: string }) {
  return <span className="mt-2 inline-flex gap-1" aria-label={`${label}: ${score} of ${needed}`} role="img">{Array.from({ length: needed }, (_, index) => <span key={index} className={`h-2.5 w-2.5 rounded-full border border-current ${index < score ? "bg-accent text-accent" : "text-text-muted/40"}`} />)}</span>;
}
export function SeriesWidget({ rawSeries, preview = false, visible = true, composite = false }: { rawSeries: unknown; preview?: boolean; visible?: boolean; composite?: boolean }) {
  const localPreview = useContext(OverlayPreviewContext);
  const series = useMemo(() => preview || localPreview ? SERIES_SAMPLE : normalizeSeriesSnapshot(rawSeries), [rawSeries, preview, localPreview]);
  if (!series || series.status === "ended") return null;
  return <WidgetShell slot="top-left-series" visible={visible} width={composite ? 360 : 520} accent={series.status === "complete" ? series.score.you > series.score.opponent ? "green" : "red" : "cyan"}><SeriesScoreboard series={series} preview={preview || localPreview} /></WidgetShell>;
}
