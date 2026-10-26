import { parseOpeningForecast } from "@/lib/openingForecast";

/** Compact, stream-safe projection shared by the live brief and overlay. */
export function ForecastStats({ value, compact = false, compactOnPhone = false }: { value: unknown; compact?: boolean; compactOnPhone?: boolean }) {
  const data = parseOpeningForecast(value);
  if (!data) return <p className="text-caption text-text-muted">Opening forecast unavailable.</p>;
  if (data.partial) return <p role="status" className="text-caption text-warning">Forecast unavailable: the latest 1,000 metadata rows do not contain a complete matching source window. No older estimate is substituted.</p>;
  if (!data.top.length) return <p className="text-caption text-text-muted">Not enough eligible opening history for this matchup.</p>;
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-caption"><span className="font-semibold">Opening forecast{data.matchup ? ` · ${data.matchup}` : ""}</span><span className="rounded-full border border-border px-2 py-1">{data.confidence} confidence</span><span className="text-text-muted">effective n={data.effectiveN.toFixed(1)}</span></div>
    <ul className="space-y-2">{data.top.slice(0, compact ? 1 : 3).map((row, index) => <li key={row.name} className={`min-w-0 break-words text-body ${compactOnPhone && index > 0 ? "hidden sm:list-item" : ""}`}><span className="font-semibold tabular-nums">{Math.round(row.probability * 100)}%</span> · {row.name}{!compact ? <ul className={`mt-1 space-y-1 text-caption text-text-muted ${compactOnPhone ? "hidden sm:block" : ""}`}>{row.why.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}</li>)}</ul>
    {!compact ? <p className={`text-caption text-text-muted ${compactOnPhone ? "hidden sm:block" : ""}`}>{data.sampleSize} eligible observations in the latest {data.sourceWindowSize} matching metadata rows (up to 50). {data.map ? `${data.map} gets extra weight.` : "All-map weighting."}{data.otherProbability > .0001 ? ` Other or unlabelled openings: ${Math.round(data.otherProbability * 100)}%.` : ""}{data.ratingBasis === "last_matchup_replay" ? " Ladder band uses your last recorded matchup rating." : ""}</p> : null}
  </div>;
}
