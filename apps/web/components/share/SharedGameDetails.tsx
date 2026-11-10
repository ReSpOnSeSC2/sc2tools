"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Gauge, Swords } from "lucide-react";
import { BenchmarkStrip } from "@/components/analyzer/game/BenchmarkStrip";
import { BuildOrderColumns } from "@/components/analyzer/game/BuildOrderColumns";
import { InteractiveTimeline } from "@/components/analyzer/game/InteractiveTimeline";
import { MechanicsPanel } from "@/components/analyzer/game/MechanicsPanel";
import { GetYourOwnCTA } from "@/components/public-profile/GetYourOwnCTA";
import { PublicMacroLeakCard } from "@/components/public-profile/PublicMacroLeakCard";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { BENCHMARK_METRICS, percentileOf, type BenchmarkMetric } from "@/lib/benchmarks";
import { macroScoreTone } from "@/lib/format";
import { shareApiPath } from "@/lib/gameShares";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { sharedGameSummary, sharedReportInput, type SharedGameAnalysis } from "@/lib/sharedGame";
import { usePublicApi } from "@/lib/usePublicApi";
import { SharedGameReplay } from "./SharedGameReplay";

const BattleReportSection = dynamic(() => import("@/components/battleReport/BattleReportSection").then((value) => value.BattleReportSection), {
  loading: () => <div role="status" aria-label="Loading battle report" className="h-52 animate-pulse rounded-lg bg-bg-elevated motion-reduce:animate-none" />,
});

const METRIC_LABELS: Record<BenchmarkMetric, string> = { macroScore: "Macro score", apm: "APM", spq: "Spending quotient", durationSec: "Length" };

export function SharedGameDetails({ token, data, seekRequest, onSeek, initialTimeSec }: {
  token: string; data: SharedGameAnalysis; seekRequest: { t: number; seq: number } | null;
  /** Seek the map replay; ``reveal`` also scrolls it into view. */
  onSeek: (t: number, reveal?: boolean) => void; initialTimeSec: number | null;
}) {
  const { game, macroBreakdown, buildOrder, benchmark } = data;
  const [scrubTime, setScrubTime] = useState<number | null>(initialTimeSec);
  const key = `share-${token}`;
  const summary = useMemo(() => sharedGameSummary(game, key), [game, key]);
  // The same request the replay makes (SWR shares it): only complete inline
  // playback can give the report map stills.
  const inlineReq = usePublicApi<Record<string, unknown>>(data.playback.mode === "inline" ? `${shareApiPath(token)}/map-playback` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false });
  const inline = useMemo(() => (inlineReq.data ? sanitizeMapPlayback(inlineReq.data) : null), [inlineReq.data]);
  const reportInput = useMemo(() => sharedReportInput(data, key, inline), [data, key, inline]);
  const timeHref = useCallback((t: number) => `/g/${encodeURIComponent(token)}?t=${Math.floor(t)}#replay`, [token]);
  const seek = (t: number) => { setScrubTime(t); onSeek(t, true); };
  const scrub = (t: number) => { setScrubTime(t); onSeek(t); };
  const timelineAvailable = Boolean(macroBreakdown?.stats_events?.length || macroBreakdown?.opp_stats_events?.length);
  const strips = benchmark?.league && benchmark.matchup ? BENCHMARK_METRICS.flatMap((metric) => {
    const table = benchmark.metrics[metric];
    const percentile = percentileOf(table, game[metric]);
    return percentile && table ? [{ metric, percentile, n: table.n }] : [];
  }) : [];
  return <div className="space-y-6">
    <BattleReportSection input={reportInput} onSeek={seek} segmented={data.playback.mode === "segmented"}
      pending={data.playback.mode === "inline" && inlineReq.isLoading} timeHref={timeHref} />

    <section id="replay" aria-labelledby="shared-replay-title" className="scroll-mt-24 space-y-3">
      <h2 id="shared-replay-title" className="font-display text-h3 font-bold text-text">Map replay</h2>
      <SharedGameReplay token={token} data={data} seekRequest={seekRequest} initialTimeSec={initialTimeSec} onTimeChange={setScrubTime} />
    </section>

    {strips.length && benchmark?.league && benchmark.matchup ? <Card title="Against the league">
      <p className="mb-3 text-caption text-text-muted">Band = the opponent&apos;s league ({benchmark.league} {benchmark.matchup}), the league&apos;s middle half; the dot is this game.</p>
      <ul aria-label="League benchmarks" className="space-y-3">
        {strips.map(({ metric, percentile, n }) => <li key={metric}>
          <p className="text-body-sm font-medium text-text">{METRIC_LABELS[metric]} · {percentile.label} percentile</p>
          <BenchmarkStrip label={METRIC_LABELS[metric]} percentile={percentile} league={benchmark.league!} matchup={benchmark.matchup!} n={n} />
        </li>)}
      </ul>
    </Card> : null}

    <section id="timeline" aria-labelledby="shared-timeline-title" className="space-y-3">
      <h2 id="shared-timeline-title" className="font-display text-h3 font-bold text-text">How the game unfolded</h2>
      {timelineAvailable ? <InteractiveTimeline
        statsEvents={macroBreakdown?.stats_events}
        oppStatsEvents={macroBreakdown?.opp_stats_events}
        gameLengthSec={game.durationSec ?? macroBreakdown?.game_length_sec ?? null}
        scrubTime={scrubTime}
        onScrub={scrub}
        myName={game.playerLabel}
        oppName={game.opponentLabel}
        perspectiveLabel={game.playerLabel}
      /> : <Card><EmptyStatePanel icon={<Swords className="h-6 w-6" aria-hidden />} title="Timeline samples weren't recorded for this replay"
        description="The rest of the analysis is below." /></Card>}
    </section>

    <section id="macro" aria-labelledby="shared-macro-title" className="space-y-3">
      <h2 id="shared-macro-title" className="flex items-center gap-2 font-display text-h3 font-bold text-text"><Gauge className="h-5 w-5" aria-hidden /> Economy and mechanics</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <MechanicsPanel breakdown={macroBreakdown} game={summary} macroScoreToneClassName={macroScoreTone(game.macroScore ?? macroBreakdown?.macro_score)}
          onSeek={seek} emptyDescription="Detailed macro mechanics were not recorded for this replay." />
        <PublicMacroLeakCard data={macroBreakdown} onSeek={seek} />
      </div>
    </section>

    <section id="builds" aria-labelledby="shared-builds-title" className="space-y-3">
      <h2 id="shared-builds-title" className="font-display text-h3 font-bold text-text">Both build orders</h2>
      <BuildOrderColumns myEvents={buildOrder?.events} oppEvents={buildOrder?.opp_events}
        myLabel={buildOrder?.my_build ?? game.myBuild} oppLabel={buildOrder?.opp_strategy ?? game.oppStrategy}
        myHeadingLabel={game.playerLabel} opponentHeadingLabel="Opponent" myStatus={buildOrder?.my_status} oppStatus={buildOrder?.opp_status} />
    </section>

    <GetYourOwnCTA />
  </div>;
}
