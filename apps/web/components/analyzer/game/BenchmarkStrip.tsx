import type { Percentile } from "@/lib/benchmarks";

/**
 * One league benchmark strip: the band is the league's middle half, the
 * dot is this game's percentile. League = the opponent's league, a proxy
 * for the game's bracket. Shared by the game page and the public share page.
 */
export function BenchmarkStrip({ label, percentile, league, matchup, n }: {
  label: string; percentile: Percentile; league: string; matchup: string; n: number;
}) {
  return <div className="relative mt-2 h-2 rounded-full bg-bg-elevated" role="img"
    aria-label={`${label}: band = opponent's league, ${league} ${matchup}; dot = this game's ${percentile.label} percentile; n=${n}.`}>
    <span className="absolute inset-y-0 left-[25%] w-1/2 rounded-full bg-border-strong" />
    <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-surface bg-accent" style={{ left: `${percentile.value}%` }} />
  </div>;
}
