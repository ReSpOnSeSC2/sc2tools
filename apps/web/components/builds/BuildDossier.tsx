"use client";

import { type ReactNode, useMemo, useState } from "react";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { fmtAgo, fmtMinutes, pct1, wrColor } from "@/lib/format";
import { Last5GamesTimeline } from "@/components/analyzer/Last5GamesTimeline";
import type { ProfileGame } from "@/components/analyzer/Last5GamesTimeline";
import {
  PredictedStrategiesList,
  type Prediction,
} from "@/components/analyzer/PredictedStrategiesList";
import {
  StrategyTendencyChart,
  type StrategyEntry,
} from "@/components/analyzer/StrategyTendencyChart";
import {
  PhaseTrajectoryStrip,
  type Phase,
} from "@/components/analyzer/PhaseTrajectoryStrip";
import {
  PhaseCompositionTabs,
  type PhaseSignature,
} from "@/components/analyzer/PhaseCompositionTabs";
import { BuildTransitionSankey } from "@/components/analyzer/BuildTransitionSankey";
import { useApi } from "@/lib/clientApi";
import { BreakdownCard, TopOpponentsCard } from "./BuildBreakdownCards";
import { BuildGamesTable } from "./BuildGamesTable";
import type {
  BuildDetailRow,
  BuildPhasePayload,
  BuildRecentGame,
  BuildTransitionsPayload,
} from "./types";

const PHASE_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

/**
 * Server response shape that backs the dossier — the union of fields
 * returned by both `/v1/builds/:name` (classified builds) and
 * `/v1/custom-builds/:slug/matches` (custom builds).
 *
 * Both endpoints share the same envelope: totals + by-cuts + recent +
 * dossier extras (opponent-strategy predictions, macro aggregate). See
 * `apps/api/src/services/buildDossier.js`.
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
  /** Replay-resume test games, excluded from every aggregate above. */
  resumedRecent: BuildRecentGame[];
  resumedCount: number;
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  myRace?: string;
  oppRaceModal?: string;
  last5Games?: ProfileGame[];
  macro?: {
    gamesWithScore: number;
    avgMacroScore: number | null;
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
  /**
   * Which side of the matched games the phase classifier scores when
   * fetching ``/compositions`` and ``/transitions``. Defaults to the
   * saved build's stored perspective on the server; pass
   * ``"opponent"`` to render the phase trajectory off the
   * ``opp_*`` macro fields — the killer companion view for an
   * "opponent-perspective" build (captured from a replay where the
   * user wanted to study what THEIR opponent did).
   */
  phasePerspective?: "you" | "opponent";
}

/**
 * BuildDossier — shared component used by the `/app → Builds` modal,
 * the custom-builds card modal, and the standalone `/builds/[slug]`
 * route. Renders the full opponent-style breakdown for a build:
 * Performance, Vs strategy / Vs map, Top matchups, Build tendencies,
 * Likely strategies next, Last 5 games, and a macro aggregate.
 */
export function BuildDossier({
  apiPath,
  headerSlot,
  footerSlot,
  showMacro = true,
  phasePerspective,
}: BuildDossierProps) {
  const { data, error, isLoading } = useApi<BuildDossierData>(apiPath);

  // Compositions / transitions share the build's base URL — strip the
  // ``/matches`` suffix to derive sibling routes. For apiPaths that
  // don't follow the custom-builds convention (e.g. ``/v1/builds/:name``
  // from the analyzer modal), no sibling routes exist; phaseBase is
  // null and the section below isn't rendered.
  const phaseBase = phaseBasePath(apiPath);
  const phaseQuery = phasePerspective ? `?perspective=${phasePerspective}` : "";
  const compositions = useApi<BuildPhasePayload>(
    phaseBase ? `${phaseBase}/compositions${phaseQuery}` : null,
  );
  const transitions = useApi<BuildTransitionsPayload>(
    phaseBase ? `${phaseBase}/transitions${phaseQuery}` : null,
  );

  const [gameFilter, setGameFilter] = useState<{
    gameIds: string[];
    label: string;
  } | null>(null);

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

  const openFilteredGames = (sampleGameIds: string[], label: string) => {
    if (!sampleGameIds || sampleGameIds.length === 0) return;
    setGameFilter({ gameIds: sampleGameIds, label });
    if (typeof window !== "undefined") {
      // Defer to next frame so the chip-rendered card is in the DOM
      // before we scroll to it; mirrors the pattern Last5 uses.
      requestAnimationFrame(() => {
        const el = document.querySelector(
          "[data-testid='build-games-filter-chip']",
        );
        if (el && "scrollIntoView" in el) {
          (el as HTMLElement).scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      });
    }
  };

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
      {phaseBase ? (
        <PhaseAndTransitions
          compositions={compositions.data}
          compositionsLoading={compositions.isLoading}
          compositionsError={compositions.error}
          transitions={transitions.data}
          transitionsLoading={transitions.isLoading}
          transitionsError={transitions.error}
          onSignatureClick={openFilteredGames}
        />
      ) : null}
      {showMacro ? <MacroAggregate macro={data.macro} /> : null}
      <Last5AndRecent
        data={data}
        filterGameIds={gameFilter?.gameIds}
        filterLabel={gameFilter?.label}
        onClearFilter={() => setGameFilter(null)}
      />
      {footerSlot ? footerSlot(data) : null}
    </div>
  );
}

function phaseBasePath(apiPath: string): string | null {
  if (!apiPath) return null;
  // Custom-builds dossier endpoints end in ``/matches`` and live next
  // to ``/compositions`` and ``/transitions``. Anything else (e.g.
  // ``/v1/builds/:name``) has no phase endpoints — return null so the
  // hooks stay idle.
  if (apiPath.endsWith("/matches")) {
    return apiPath.slice(0, -"/matches".length);
  }
  return null;
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
        <p className="mt-2 text-micro text-text-dim">
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
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Avg macro" value={avgMacro} color={macroColor} />
        <Stat label="Avg length" value={avgDur} />
      </div>
      {dist ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-baseline justify-between text-micro text-text-dim">
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
          <ul className="grid grid-cols-3 gap-2 text-micro text-text-muted">
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

function Last5AndRecent({
  data,
  filterGameIds,
  filterLabel,
  onClearFilter,
}: {
  data: BuildDossierData;
  filterGameIds?: string[];
  filterLabel?: string;
  onClearFilter?: () => void;
}) {
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
      <BuildGamesTable
        games={data.recent ?? []}
        resumedGames={data.resumedRecent ?? []}
        resumedCount={data.resumedCount ?? 0}
        filterGameIds={filterGameIds}
        filterLabel={filterLabel}
        onClearFilter={onClearFilter}
      />
    </div>
  );
}

function PhaseAndTransitions({
  compositions,
  compositionsLoading,
  compositionsError,
  transitions,
  transitionsLoading,
  transitionsError,
  onSignatureClick,
}: {
  compositions: BuildPhasePayload | undefined;
  compositionsLoading: boolean;
  compositionsError: unknown;
  transitions: BuildTransitionsPayload | undefined;
  transitionsLoading: boolean;
  transitionsError: unknown;
  onSignatureClick: (sampleGameIds: string[], label: string) => void;
}) {
  const compositionsPending = compositionsLoading && !compositions;
  const transitionsPending = transitionsLoading && !transitions;

  // Hide the entire section when both endpoints have errored — the
  // analyzer-modal apiPath has no phase routes, and rendering an empty
  // shell there would be visual noise.
  if (compositionsError && transitionsError) return null;

  return (
    <div className="space-y-5" data-testid="phase-and-transitions">
      <Card title="Phase trajectory & composition">
        {compositionsPending ? (
          <Skeleton rows={3} />
        ) : compositions ? (
          <PhaseSection
            payload={compositions}
            onSignatureClick={onSignatureClick}
          />
        ) : compositionsError ? (
          <EmptyState
            title="Phase data unavailable"
            sub="Phase compositions couldn't load for this build."
          />
        ) : null}
      </Card>
      <Card title="Build transitions">
        {transitionsPending ? (
          <Skeleton rows={3} />
        ) : transitions ? (
          <BuildTransitionSankey transitions={transitions} />
        ) : transitionsError ? (
          <EmptyState
            title="Transitions unavailable"
            sub="Build transitions couldn't load for this build."
          />
        ) : null}
      </Card>
    </div>
  );
}

function PhaseSection({
  payload,
  onSignatureClick,
}: {
  payload: BuildPhasePayload;
  onSignatureClick: (sampleGameIds: string[], label: string) => void;
}) {
  return (
    <div className="space-y-4">
      <PhaseTrajectoryStrip
        sampleSize={payload.sampleSize}
        crossings={payload.medianCrossings}
        finalPhaseDistribution={payload.finalPhaseDistribution}
        durationP95Sec={payload.durationP95Sec}
      />
      {/* preferredPhase=mid lands the user on the build's typical mid-
          game without clicking; falls back to first reached if Mid is
          empty. */}
      <PhaseCompositionTabs
        sampleSize={payload.sampleSize}
        perPhase={payload.perPhase}
        preferredPhase="mid"
        onSignatureClick={(sampleGameIds) =>
          handleSignatureClick(payload, sampleGameIds, onSignatureClick)
        }
      />
    </div>
  );
}

function handleSignatureClick(
  payload: BuildPhasePayload,
  sampleGameIds: string[],
  onSignatureClick: (sampleGameIds: string[], label: string) => void,
) {
  // Locate the signature so the chip can name it ("Mid · Phoenix
  // Stalker Immortal"). Scanning every phase is fine — there are at
  // most ~40 signatures across the whole payload.
  const idSet = new Set(sampleGameIds);
  for (const phase of Object.keys(payload.perPhase) as Phase[]) {
    const row = payload.perPhase[phase];
    if (!row) continue;
    const hit = row.signatures.find((s: PhaseSignature) =>
      s.sampleGameIds.some((gid) => idSet.has(gid)),
    );
    if (hit) {
      const units =
        hit.units.length > 0
          ? hit.units.map((u) => u.token).join(" ")
          : hit.key || "Other";
      onSignatureClick(sampleGameIds, `${PHASE_LABELS[phase]} · ${units}`);
      return;
    }
  }
  onSignatureClick(sampleGameIds, "signature");
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
