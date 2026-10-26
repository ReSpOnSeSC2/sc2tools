"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { clientTimezone } from "@/lib/timeseries";
import { ratingSparkline, type MatchupRatingSeries } from "@/lib/strengthAdjusted";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { TrendsRequestError } from "./TrendsRequestError";

type Response = { ratingSeries?: MatchupRatingSeries[] };

export function MatchupRatingCard() {
  const { filters, dbRev } = useFilters(); const { isGlobal } = useTrendsDataScope();
  const tz = useMemo(() => clientTimezone(), []);
  // Exactly the same resource as MatchupOverTimeChart; the rating samples
  // arrive in its bounded facet, with no additional request or game fetch.
  const params = useMemo(() => ({ ...filters, interval: "day", tz, group_by: "matchup" }), [filters, tz]);
  const { data, error, isLoading, isPreviousData, mutate } = useTrendsApi<Response>(`/v1/timeseries/matchups${filtersToQuery(params)}#${dbRev}`);
  if (error) return <TrendsRequestError title="Matchup rating" error={error} retry={mutate} />;
  if (isLoading || isPreviousData) return <Card title="Matchup rating"><Skeleton rows={3} /></Card>;
  const series = (data?.ratingSeries ?? []).filter(row => /^[PTZ]v[PTZ]$/.test(row.matchup) && row.sampleGames > 0);
  return <Card title="Matchup rating">
    <p className="mb-4 text-caption leading-relaxed text-text-muted">Performance given who {isGlobal ? "the selected players" : "you"} played. Each matchup uses its latest 50 decided ranked 1v1 {isGlobal ? "records" : "games"}, in game order. Lines show rolling ten-game estimates; early windows are shorter. Missing replay-time ratings are excluded, and 0% or 100% rated windows leave a gap. <Link href="/help/vs-expected" className="text-accent underline underline-offset-2">How it works</Link></p>
    {!series.length ? <EmptyState title="No eligible matchup games" sub="Upload ranked 1v1 replays with both played races recorded. Replay-time ratings are needed for performance estimates." /> : <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{series.map(row => <RatingPanel key={row.matchup} row={row} />)}</div>}
  </Card>;
}

function RatingPanel({ row }: { row: MatchupRatingSeries }) {
  const id = useId();
  const [chosen, setChosen] = useState(row.points.length - 1);
  const index = Math.max(0, Math.min(chosen, row.points.length - 1));
  const selected = row.points[index], plot = ratingSparkline(row.points);
  const marker = plot.markers.find(point => point.index === index);
  const cursorX = 5 + index / Math.max(1, row.points.length - 1) * 230;
  const label = `${row.matchup} rating window`;
  return <section aria-label={`${row.matchup} performance rating`} className="min-w-0 rounded-lg border border-border bg-bg-elevated/30 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h4 className="font-semibold text-text">{row.matchup}</h4>
      <div className="text-right tabular-nums"><strong className="text-text">{row.perfRating == null ? "—" : Math.round(row.perfRating).toLocaleString()}</strong><span className="ml-1 text-micro text-text-muted">{row.sampleGames}-game estimate</span></div>
    </div>
    <div className="mt-1 text-micro text-text-muted">{row.ratedGames ?? 0}/{row.sampleGames} paired replay ratings · {row.excludedNoMmr ?? 0} missing{(row.ratedGames ?? 0) < 10 ? " · thin sample" : ""}</div>
    {plot.markers.length ? <>
      <svg viewBox="0 0 240 60" className="my-2 block h-20 w-full text-accent" role="img" aria-label={`${row.matchup} rolling performance rating in game order`} aria-describedby={`${id}-selection`}>
        <line data-rating-cursor={index} x1={cursorX} x2={cursorX} y1="4" y2="56" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
        {plot.paths.map((path, i) => <path key={i} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />)}
        {plot.markers.map(point => <circle key={point.index} cx={point.x} cy={point.y} r="2" fill="currentColor"><title>{`${new Date(row.points[point.index].date).toLocaleDateString()}: ${Math.round(row.points[point.index].perfRating!)} rating, ${row.points[point.index].ratedGames} rated games`}</title></circle>)}
        {marker && <circle data-rating-selection={index} cx={marker.x} cy={marker.y} r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />}
      </svg>
      <p className="flex justify-between text-micro tabular-nums text-text-muted"><span>Range {Math.round(plot.low!).toLocaleString()}</span><span>{Math.round(plot.high!).toLocaleString()}</span></p>
    </> : <p className="my-4 text-caption text-text-muted">No finite window estimate yet. Rated windows need both wins and losses.</p>}
    {selected && <div className="mt-3 space-y-1">
      <label className="text-micro text-text-muted" htmlFor={`${id}-window`}>Inspect window</label>
      <select id={`${id}-window`} aria-label={label} aria-describedby={`${id}-help ${id}-selection`} className="min-h-11 w-full rounded border border-border bg-bg-surface px-2 text-caption text-text" value={index} onChange={event => setChosen(Number(event.target.value))}>{row.points.map((point, i) => <option key={i} value={i}>Game {i + 1} · {new Date(point.date).toLocaleDateString()}</option>)}</select>
      <div id={`${id}-selection`} role="status" aria-live="polite" aria-atomic="true" className="space-y-1 tabular-nums">
        <p className="text-caption font-semibold text-text">Games {Math.max(1, index - selected.games + 2)}–{index + 1} · ending {new Date(selected.date).toLocaleDateString()}</p>
        <p className="text-caption text-text">{selected.perfRating == null ? "No finite rating" : `${Math.round(selected.perfRating).toLocaleString()} performance rating`} · {selected.ratedGames}/{selected.games} rated · {selected.excludedNoMmr} missing</p>
      </div>
      <p id={`${id}-help`} className="text-micro text-text-muted">Select a rolling window to highlight it. The {row.sampleGames}-game estimate above stays the same.</p>
    </div>}
  </section>;
}
