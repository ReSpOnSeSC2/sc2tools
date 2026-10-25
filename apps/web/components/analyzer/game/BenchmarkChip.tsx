import { percentileOf, type MetricBenchmark } from "@/lib/benchmarks";

export function BenchmarkChip({ table, value, league, matchup, updatedAt }: {
  table: MetricBenchmark | null | undefined;
  value: number | null | undefined;
  league: string;
  matchup: string;
  updatedAt: string;
}) {
  const percentile = percentileOf(table, value);
  if (!percentile) return null;
  const parsed = new Date(updatedAt);
  const date = Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "unknown";
  return <span className="inline-flex flex-wrap items-center gap-x-1 rounded bg-bg-elevated px-2 py-1 text-caption text-text-muted"
    title={`Band = opponent's league (${league} ${matchup}); a proxy for the game's bracket. n=${table!.n}; updated ${date}. Percentile describes the distribution, not a target.`}>
    <span>{percentile.label} percentile · {league} {matchup}</span><span className="text-text-muted">n={table!.n} · updated {date}</span>
  </span>;
}
