"use client";

import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useTrendsApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { clientTimezone } from "@/lib/timeseries";
import { ratingSparkline, type MatchupRatingSeries } from "@/lib/strengthAdjusted";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { TrendsRequestError } from "./TrendsRequestError";
import { formatDate, formatNumber } from "@/lib/i18n/format";

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
  const label = `${row.matchup} rating window`;
  return <section aria-label={`${row.matchup} performance rating`} className="min-w-0 rounded-lg border border-border bg-bg-elevated/30 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h4 className="font-semibold text-text">{row.matchup}</h4>
      <div className="text-right tabular-nums"><strong className="text-text">{row.perfRating == null ? "—" : formatNumber(Math.round(row.perfRating))}</strong><span className="ml-1 text-micro text-text-muted">{row.sampleGames}-game estimate</span></div>
    </div>
    <div className="mt-1 text-micro text-text-muted">{row.ratedGames ?? 0}/{row.sampleGames} paired replay ratings · {row.excludedNoMmr ?? 0} missing{(row.ratedGames ?? 0) < 10 ? " · thin sample" : ""}</div>
    <RatingPlot row={row} plot={plot} index={index} onChoose={setChosen} describedBy={`${id}-help ${id}-selection`} />
    {selected && <div className="mt-3 space-y-1">
      <label className="text-micro text-text-muted" htmlFor={`${id}-window`}>Inspect window</label>
      <select id={`${id}-window`} aria-label={label} aria-describedby={`${id}-help ${id}-selection`} className="min-h-11 w-full rounded border border-border bg-bg-surface px-2 text-caption text-text" value={index} onChange={event => setChosen(Number(event.target.value))}>{row.points.map((point, i) => <option key={i} value={i}>Game {i + 1} · {formatDate(new Date(point.date))}</option>)}</select>
      <div id={`${id}-selection`} role="status" aria-live="polite" aria-atomic="true" className="space-y-1 tabular-nums">
        <p className="text-caption font-semibold text-text">Games {Math.max(1, index - selected.games + 2)}–{index + 1} · ending {formatDate(new Date(selected.date))}</p>
        <p className="text-caption text-text">{selected.perfRating == null ? "No finite rating" : `${formatNumber(Math.round(selected.perfRating))} performance rating`} · {selected.ratedGames}/{selected.games} rated · {selected.excludedNoMmr} missing</p>
      </div>
      <p id={`${id}-help`} className="text-micro text-text-muted">{plot.markers.length ? "Tap or click the chart, use its arrow keys, or choose a window to inspect it." : "Choose a window to inspect it."} The {row.sampleGames}-game estimate above stays the same.</p>
    </div>}
  </section>;
}

function RatingPlot({ row, plot, index, onChoose, describedBy }: {
  row: MatchupRatingSeries; plot: ReturnType<typeof ratingSparkline>; index: number; onChoose: (index: number) => void; describedBy: string;
}) {
  const selected = row.points[index], marker = plot.markers.find(point => point.index === index);
  const cursorX = 5 + index / Math.max(1, row.points.length - 1) * 230;
  const choose = (next: number) => onChoose(Math.max(0, Math.min(next, row.points.length - 1)));
  const selectOnChart = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const x = (event.clientX - bounds.left) / bounds.width * 240;
    choose(Math.round((x - 5) / 230 * Math.max(1, row.points.length - 1)));
    event.currentTarget.focus({ preventScroll: true });
  };
  const selectWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: Record<string, number> = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: row.points.length - 1, PageDown: index - 10, PageUp: index + 10 };
    if (Object.hasOwn(next, event.key)) { event.preventDefault(); choose(next[event.key]); }
  };
  if (!plot.markers.length) return <p className="my-4 text-caption text-text-muted">No finite window estimate yet. Rated windows need both wins and losses.</p>;
  return <div className="my-3">
      <p className="text-micro text-text-muted">Performance rating</p>
      <div className="mt-1 grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2">
        <div aria-hidden="true" className="relative h-36 text-micro tabular-nums text-text-muted">
          {plot.ticks.map(tick => <span key={tick.y} data-rating-tick={tick.value} className="absolute right-0 -translate-y-1/2" style={{ top: `${tick.y / 60 * 100}%` }}>{formatNumber(Math.round(tick.value))}</span>)}
        </div>
        <div role="slider" tabIndex={0} aria-label={`${row.matchup} rating chart, select a game window`} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={row.points.length} aria-valuenow={index + 1} aria-valuetext={`Game ${index + 1} of ${row.points.length}${selected ? `, ${formatDate(new Date(selected.date))}, ${selected.perfRating == null ? "no finite rating" : `${formatNumber(Math.round(selected.perfRating))} performance rating`}` : ""}`} aria-describedby={describedBy} onClick={selectOnChart} onKeyDown={selectWithKeyboard} className="relative h-36 min-w-0 cursor-pointer rounded text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <svg viewBox="0 0 240 60" preserveAspectRatio="none" className="pointer-events-none absolute h-full w-full" aria-hidden="true" focusable="false">
            {plot.ticks.map(tick => <line key={tick.y} x1="5" x2="235" y1={tick.y} y2={tick.y} className="text-border" stroke="currentColor" vectorEffect="non-scaling-stroke" />)}
            <line data-rating-cursor={index} x1={cursorX} x2={cursorX} y1="4" y2="56" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            {plot.paths.map((path, i) => <path key={i} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
          </svg>
          {plot.markers.map(point => <span key={point.index} data-rating-point={point.index} aria-hidden="true" className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${point.x / 240 * 100}%`, top: `${point.y / 60 * 100}%` }} />)}
          {marker && <span data-rating-selection={index} aria-hidden="true" className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent" style={{ left: `${marker.x / 240 * 100}%`, top: `${marker.y / 60 * 100}%` }} />}
        </div>
        <div />
        <div className="flex justify-between gap-2 text-micro tabular-nums text-text-muted"><span>Game 1</span>{row.points.length > 1 && <span>Game {row.points.length}</span>}</div>
        <div />
        <p className="text-center text-micro text-text-muted">Game order →</p>
      </div>
    </div>;
}
