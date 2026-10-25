"use client";

import { Card } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { RequestError } from "@/components/ui/RequestError";
import { BENCHMARK_METRICS, percentileOf, type BenchmarkMetric, type GameContext, type LeagueBenchmark } from "@/lib/benchmarks";
import type { ClientApiError } from "@/lib/clientApi";
import { useBenchmarks } from "@/lib/useBenchmarks";
import { BenchmarkChip } from "./BenchmarkChip";
import type { GameSummary } from "./types";

const LABELS: Record<BenchmarkMetric, string> = { macroScore: "Macro score", apm: "APM", spq: "Spending quotient", durationSec: "Length" };
function format(metric: BenchmarkMetric, value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  if (metric === "durationSec") { const n = Math.max(0, Math.round(value)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; }
  return Math.round(value * 10) / 10;
}

function MetricRow({ metric, game, context, league }: { metric: BenchmarkMetric; game: GameSummary; context: GameContext; league?: LeagueBenchmark | null }) {
  const baseline = context.personal.metrics[metric], value = game[metric];
  const pct = percentileOf(league?.metrics[metric], value);
  return <li className="border-t border-border py-3 first:border-t-0 first:pt-0">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><strong className="text-body-sm font-medium">{LABELS[metric]} <span className="tabular-nums">{format(metric, value)}</span></strong>
      {pct && league ? <BenchmarkChip table={league.metrics[metric]} value={value} league={league.league} matchup={league.matchup} updatedAt={league.updatedAt} /> : null}
    </div>
    <p className="mt-1 text-caption text-text-muted">{baseline.n > 0 && baseline.median !== null
      ? <>Your {context.matchup} median {format(metric, baseline.median)} · middle half {format(metric, baseline.p25)}–{format(metric, baseline.p75)} · n={baseline.n}</>
      : <>No earlier ranked {context.matchup || "matching"} games with this measurement · n=0</>}</p>
    {pct && league ? <div className="relative mt-2 h-2 rounded-full bg-bg-elevated" role="img"
      aria-label={`${LABELS[metric]}: band = opponent's league, ${league.league} ${league.matchup}; dot = this game's ${pct.label} percentile; n=${league.metrics[metric]!.n}.`}>
      <span className="absolute inset-y-0 left-[25%] w-1/2 rounded-full bg-border-strong" />
      <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-surface bg-accent" style={{ left: `${pct.value}%` }} />
    </div> : null}
    {metric === "durationSec" ? <p className="mt-1 text-caption text-text-muted">Length gives context; longer or shorter is not a rating.</p> : null}
  </li>;
}

export function GameContextCard({ game, context, error, loading, onRetry }: { game: GameSummary; context?: GameContext; error?: ClientApiError; loading?: boolean; onRetry: () => void }) {
  // The fresh context also owns suppression: an explicit null must not be
  // resurrected by an old24h SWR table (nor hidden by an old cached404).
  const hasLeague = !!context && Object.prototype.hasOwnProperty.call(context, "league");
  const leagueReq = useBenchmarks(context && !hasLeague ? game.opponent?.leagueId : null, context?.matchup);
  const league = hasLeague ? context.league?.table ?? null : leagueReq.error?.status === 404 ? null : leagueReq.data?.table;
  return <Card title={<span>Your usual and your league <LazyHelpLink slug="benchmarks">Help</LazyHelpLink></span>}>
    {error && error.status !== 404 && !context ? <RequestError title="Couldn't load comparisons" error={error} onRetry={onRetry} />
      : !context ? <p className="text-body-sm text-text-muted" role={loading ? "status" : undefined}>{loading ? "Loading earlier-game comparisons…" : "Comparisons are not available for this game yet."}</p>
      : <><p className="mb-3 text-caption text-text-muted">Up to {context.personal.limit} earlier ranked 1v1 {context.matchup || "matching"} games. On each strip, the band is the league&apos;s middle half; the dot is this game.</p>
        <ul aria-label="Game benchmarks">{BENCHMARK_METRICS.map((metric) => <MetricRow key={metric} metric={metric} game={game} context={context} league={league} />)}</ul>
        {!league ? <p className="mt-2 text-caption text-text-muted">League comparison needs at least 50 games with this measurement in the cached band. Your own history stays available.</p> : null}
        <p className="mt-2 text-caption text-text-muted">League uses your opponent&apos;s league as a bracket proxy. Each measurement needs at least 50 samples.</p>
      </>}
  </Card>;
}
