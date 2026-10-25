export const BENCHMARK_MIN_SAMPLE = 50;
export const BENCHMARK_METRICS = ["macroScore", "apm", "spq", "durationSec"] as const;
export type BenchmarkMetric = typeof BENCHMARK_METRICS[number];
export type MetricBenchmark = { n: number; deciles: number[] | null };
export type LeagueBenchmark = {
  leagueId: number;
  league: string;
  matchup: string;
  n: number;
  updatedAt: string;
  metrics: Partial<Record<BenchmarkMetric | "myMmr", MetricBenchmark>>;
};
export type PersonalBenchmark = { n: number; median: number | null; p25: number | null; p75: number | null };
export type GameContext = {
  matchup: string | null;
  personal: {
    n: number;
    limit: number;
    metrics: Record<BenchmarkMetric, PersonalBenchmark>;
    expansionTimings: Partial<Record<"Nexus" | "Hatchery" | "CommandCenter", number>>;
    expansionSample: number;
    expansionLimit: number;
    expansionMinSample: number;
    build: string | null;
  };
  league: { table: LeagueBenchmark; percentiles: Partial<Record<BenchmarkMetric, number | null>> } | null;
};
export type Percentile = { value: number; label: string };

export function ordinal(value: number): string {
  const n = Math.round(value), tail = n % 100;
  return `${n}${tail >= 11 && tail <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

/** Interpolate only the measured decile range; tail labels do not imply a
 * precision the stored p10..p90 table cannot provide. */
export function percentileOf(table: MetricBenchmark | null | undefined, value: number | null | undefined): Percentile | null {
  if (!table || table.n < BENCHMARK_MIN_SAMPLE || !Number.isFinite(table.n) || typeof value !== "number" || !Number.isFinite(value)) return null;
  const d = table.deciles;
  if (!Array.isArray(d) || d.length !== 9 || d.some((n, i) => !Number.isFinite(n) || (i > 0 && n < d[i - 1]))) return null;
  if (value < d[0]) return { value: 10, label: "<10th" };
  if (value > d[8]) return { value: 90, label: ">90th" };
  // Tied quantiles occupy an interval; use its midpoint instead of claiming
  // the lowest rank for a distribution whose every value happens to tie.
  const first = d.indexOf(value), last = d.lastIndexOf(value);
  if (first >= 0) {
    const rank = 10 * ((first + last) / 2 + 1);
    return { value: rank, label: ordinal(rank) };
  }
  let i = 0;
  while (i < 7 && value > d[i + 1]) i += 1;
  const rank = 10 * (i + 1) + 10 * (value - d[i]) / (d[i + 1] - d[i]);
  return { value: rank, label: ordinal(rank) };
}
