"use client";

import { type ReactNode, useMemo } from "react";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { fmtAgo, fmtMinutes, pct1, wrColor } from "@/lib/format";
import { Last5GamesTimeline } from "@/components/analyzer/Last5GamesTimeline";
import type { ProfileGame } from "@/components/analyzer/Last5GamesTimeline";
import {
  MedianTimingsGrid,
  type MatchupTimings,
  type TimingInfo,
} from "@/components/analyzer/MedianTimingsGrid";
import {
  PredictedStrategiesList,
  type Prediction,
} from "@/components/analyzer/PredictedStrategiesList";
import {
  StrategyTendencyChart,
  type StrategyEntry,
} from "@/components/analyzer/StrategyTendencyChart";
import { useApi } from "@/lib/clientApi";
import { BreakdownCard, TopOpponentsCard } from "./BuildBreakdownCards";
import { BuildGamesTable } from "./BuildGamesTable";
import type { BuildDetailRow, BuildRecentGame } from "./types";

/**
 * Server response shape that backs the dossier — the union of fields
 * returned by both `/v1/builds/:name` (classified builds) and
 * `/v1/custom-builds/:slug/matches` (custom builds).
 *
 * Both endpoints share the same envelope: totals + by-cuts + recent +
 * dossier extras (DNA-style timings, opponent-strategy predictions,
 * macro aggregate). See `apps/api/src/services/buildDossier.js`.
 */
export interface BuildDossierData {
  name: string;
  slug?: string;
  totals: {
    wins: number;
    losses: number;
    total: number;
    winRate: number;
    lastPlayed?: string | null;
  };
  byMatchup: BuildDetailRow[];
  byMap: BuildDetailRow[];
  byStrategy: BuildDetailRow[];
  recent: BuildRecentGame[];
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  myRace?: string;
  oppRaceModal?: string;
  matchupLabel?: string;
  matchupCounts?: Record<string, number>;
  matchupTimings?: Record<string, MatchupTimings>;
  matchupTimingsLegacy?: Record<string, MatchupTimings>;
  medianTimings?: Record<string, TimingInfo>;
  medianTimingsLegacy?: Record<string, TimingInfo>;
  medianTimingsOrder?: string[];
  last5Games?: ProfileGame[];
  macro?: {
    gamesWithScore: number;
    avgMacroScore: number | null;
    avgApm: number | null;
    avgSpq: number | null;
    avgDurationSec: number | null;
    scoreDistribution: { excellent: number; good: number; poor: number };
  };
}

export interface BuildDossierProps {
  apiPath: string;
  /** Render-prop slot above the dossier (e.g. notes, publish form). */
  headerSlot?: (data: BuildDossierData | null) => ReactNode;
  /** Render-prop slot below the dossier. */
  footerSlot?: (data: BuildDossierData | null) => ReactNode;
  /** When true, surface the macro aggregate panel. Defaults to true. */
  showMacro?: boolean;
}

/**
 * BuildDossier — shared component used by the `/app → Builds` modal,
 * the custom-builds card modal, and the standalone `/builds/[slug]`
 * route. Renders the full opponent-style breakdown for a build:
 * Performance, Vs strategy / Vs map, Top matchups, Build tendencies,
 * Likely strategies next, Median key timings (per-matchup), Last 5
 * games, and a macro aggregate.
 */
export function BuildDossier({
  apiPath,
  headerSlot,
  footerSlot,
  showMacro = true,
}: BuildDossierProps) {
  const { data, error, isLoading } = useApi<BuildDossierData>(apiPath);

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        {headerSlot ? headerSlot(null) : null}
        <Skeleton rows={6} />
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <EmptyState
          title="Couldn't load this build"
          sub={error.message}
        />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <EmptyState
          title="No data for this build yet"
          sub="Once a few games on this build land, the breakdown shows here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {headerSlot ? headerSlot(data) : null}
      <PerformanceTiles totals={data.totals} />
      <BreakdownGrid data={data} />
      <TopMatchups rows={data.byMatchup} />
      <TendenciesAndPredictions
        strategies={data.topStrategies ?? []}
        predictions={data.predictedStrategies ?? []}
      />
      <MedianKeyTimings data={data} />
      {showMacro ? <MacroAggregate macro={data.macro} /> : null}
      <Last5AndRecent data={data} />
      {footerSlot ? footerSlot(data) : null}
    </div>
  );
}

function PerformanceTiles({
  totals,
}: {
  totals: BuildDossierData["totals"];
}) {
  const total = totals.total ?? 0;
  const wins = totals.wins ?? 0;
  const losses = totals.losses ?? 0;
  const wr = totals.winRate ?? 0;
  const last = totals.lastPlayed ?? null;
  return (
    <Card title="Performance">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Games" value={total} />
        <Stat label="Wins" value={wins} color="rgb(var(--success))" />
        <Stat label="Losses" value={losses} color="rgb(var(--danger))" />
        <Stat
          label="Win rate"
          value={total > 0 ? pct1(wr) : "—"}
          color={total > 0 ? wrColor(wr, total) : undefined}
        />
      </div>
      {last ? (
        <p className="mt-2 text-[11px] text-text-dim">
          Last played {fmtAgo(last)}
        </p>
      ) : null}
    </Card>
  );
}

function BreakdownGrid({ data }: { data: BuildDossierData }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <BreakdownCard
        title="Vs opponent strategy"
        rows={data.byStrategy ?? []}
        emptySub="No strategies tagged on games using this build yet."
      />
      <BreakdownCard
        title="Vs map"
        rows={data.byMap ?? []}
        emptySub="Once a few games on this build land, map breakdowns appear here."
      />
    </div>
  );
}

function TopMatchups({ rows }: { rows: BuildDetailRow[] }) {
  return (
    <TopOpponentsCard
      rows={rows ?? []}
      accentClass="text-text"
    />
  );
}

function TendenciesAndPredictions({
  strategies,
  predictions,
}: {
  strategies: StrategyEntry[];
  predictions: Prediction[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Build tendencies (top 5 opp. strategies)">
        <StrategyTendencyChart strategies={strategies} />
      </Card>
      <Card title="Likely strategies next">
        <PredictedStrategiesList predictions={predictions} />
      </Card>
    </div>
  );
}

function MedianKeyTimings({ data }: { data: BuildDossierData }) {
  const timings = data.medianTimingsLegacy ?? data.medianTimings ?? {};
  const order =
    data.medianTimingsOrder && data.medianTimingsOrder.length
      ? data.medianTimingsOrder
      : Object.keys(timings);
  const matchupTimings = data.matchupTimingsLegacy ?? data.matchupTimings ?? {};
  const matchupCounts = data.matchupCounts ?? {};
  const matchupLabel = data.matchupLabel ?? "";
  const opponentName = data.name || "Build";
  const hasTimings = order.length > 0;

  return (
    <Card
      title={`Median key timings${matchupLabel ? ` — ${matchupLabel}` : ""}`}
    >
      {hasTimings ? (
        <>
          <MedianTimingsGrid
            timings={timings as Record<string, TimingInfo>}
            order={order}
            matchupLabel={matchupLabel}
            matchupCounts={matchupCounts}
            matchupTimings={
              matchupTimings as Record<string, MatchupTimings>
            }
            opponentName={opponentName}
          />
          <p className="mt-2 text-[10px] text-text-dim">
            Aggregated from games tagged with this build. Cards labelled "your
            tech" come from your build log; "opponent's tech" cards come from
            theirs. Click a card with samples to see contributing games.
          </p>
        </>
      ) : (
        <EmptyState
          title="Not enough samples"
          sub="Once a few games on this build are parsed, median timings will appear here."
        />
      )}
    </Card>
  );
}

function MacroAggregate({ macro }: { macro?: BuildDossierData["macro"] }) {
  const m = macro;
  const empty = !m || m.gamesWithScore === 0;
  const totalCounted = empty
    ? 0
    : m!.scoreDistribution.excellent +
      m!.scoreDistribution.good +
      m!.scoreDistribution.poor;
  const dist = useMemo(() => {
    if (empty || totalCounted === 0) return null;
    return [
      {
        label: "Excellent (75+)",
        count: m!.scoreDistribution.excellent,
        color: "rgb(var(--success))",
      },
      {
        label: "OK (50–74)",
        count: m!.scoreDistribution.good,
        color: "rgb(var(--warning))",
      },
      {
        label: "Poor (<50)",
        count: m!.scoreDistribution.poor,
        color: "rgb(var(--danger))",
      },
    ];
  }, [empty, m, totalCounted]);

  if (empty) {
    return (
      <Card title="Macro breakdown">
        <EmptyState
          sub="No macro scores have been computed for games on this build yet. The agent computes them per replay; if scores never appear, ask it to recompute."
        />
      </Card>
    );
  }
  const avgMacro = m!.avgMacroScore != null ? m!.avgMacroScore.toFixed(1) : "—";
  const avgApm = m!.avgApm != null ? Math.round(m!.avgApm).toString() : "—";
  const avgSpq = m!.avgSpq != null ? m!.avgSpq.toFixed(1) : "—";
  const avgDur =
    m!.avgDurationSec != null ? fmtMinutes(m!.avgDurationSec) : "—";
  const macroColor =
    m!.avgMacroScore == null
      ? undefined
      : m!.avgMacroScore >= 75
        ? "rgb(var(--success))"
        : m!.avgMacroScore >= 50
          ? "rgb(var(--warning))"
          : "rgb(var(--danger))";

  return (
    <Card title="Macro breakdown (averages on this build)">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Avg macro" value={avgMacro} color={macroColor} />
        <Stat label="Avg APM" value={avgApm} />
        <Stat label="Avg SQ" value={avgSpq} />
        <Stat label="Avg length" value={avgDur} />
      </div>
      {dist ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-baseline justify-between text-[11px] text-text-dim">
            <span>Macro score distribution</span>
            <span className="tabular-nums">
              n = {m!.gamesWithScore}
            </span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded bg-bg-elevated">
            {dist.map((seg) =>
              seg.count > 0 ? (
                <div
                  key={seg.label}
                  className="h-full"
                  style={{
                    width: `${(100 * seg.count) / totalCounted}%`,
                    background: seg.color,
                  }}
                  title={`${seg.label}: ${seg.count}`}
                />
              ) : null,
            )}
          </div>
          <ul className="grid grid-cols-3 gap-2 text-[11px] text-text-muted">
            {dist.map((seg) => (
              <li key={seg.label} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-sm"
                  style={{ background: seg.color }}
                  aria-hidden
                />
                <span className="truncate">
                  {seg.label} · {seg.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Last5AndRecent({ data }: { data: BuildDossierData }) {
  const last5 = data.last5Games ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Last 5 games">
          <Last5GamesTimeline games={last5} />
        </Card>
        <Card title="Win-rate trend (per-game record)">
          <WinRateTrend rows={data.byMatchup ?? []} />
        </Card>
      </div>
      <BuildGamesTable games={data.recent ?? []} />
    </div>
  );
}

function WinRateTrend({ rows }: { rows: BuildDetailRow[] }) {
  if (!rows || rows.length === 0) {
    return <EmptyState sub="No matchup data yet" />;
  }
  return (
    <ul className="space-y-2 text-sm">
      {rows.slice(0, 6).map((m) => {
        const wr = m.winRate ?? (m.total ? m.wins / m.total : 0);
        return (
          <li key={m.name}>
            <div className="flex justify-between">
              <span className="text-text">{m.name || "Unknown"}</span>
              <span
                className="tabular-nums"
                style={{ color: wrColor(wr, m.total) }}
              >
                {m.wins}–{m.losses} · {pct1(wr)}
              </span>
            </div>
            <WrBar wins={m.wins} losses={m.losses} />
          </li>
        );
      })}
    </ul>
  );
}
