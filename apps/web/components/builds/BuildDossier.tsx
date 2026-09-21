"use client";

import { type ReactNode, useMemo, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { fmtAgo, fmtDate, fmtMinutes, pct1, wrColor } from "@/lib/format";
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
} from "@/components/analyzer/PhaseCompositionTabs";
import { unitLabel } from "@/components/analyzer/UnitCompositionTable";
import { BuildTransitionSankey } from "@/components/analyzer/BuildTransitionSankey";
import type { GameSummary } from "@/components/analyzer/game/types";
import { useApi } from "@/lib/clientApi";
import { BreakdownCard, TopOpponentsCard } from "./BuildBreakdownCards";
import { BuildGamesTable } from "./BuildGamesTable";
import { BuildCompositionExplorer } from "./BuildCompositionExplorer";
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

  const phasePaths = phaseApiPaths(apiPath, phasePerspective);
  const compositions = useApi<BuildPhasePayload>(
    phasePaths.compositions,
  );
  const transitions = useApi<BuildTransitionsPayload>(
    phasePaths.transitions,
  );

  const [gameFilter, setGameFilter] = useState<{
    scope: string;
    gameIds: string[];
    label: string;
  } | null>(null);
  const scope = `${apiPath}|${phasePerspective ?? "default"}`;
  const activeGameFilter = gameFilter?.scope === scope ? gameFilter : null;

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
    setGameFilter({ scope, gameIds: sampleGameIds, label });
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
          (el as HTMLElement).focus({ preventScroll: true });
        }
      });
    }
  };

  return (
    <div className="space-y-5">
      {headerSlot ? headerSlot(data) : null}
      <PerformanceTiles totals={data.totals} />
      {phasePaths.compositions ? (
        <PhaseAndTransitions
          key={phasePaths.compositions}
          apiPath={phasePaths.compositions}
          compositions={compositions.data}
          compositionsLoading={compositions.isLoading}
          compositionsError={compositions.error}
          transitions={transitions.data}
          transitionsLoading={transitions.isLoading}
          transitionsError={transitions.error}
          showTransitions={Boolean(phasePaths.transitions)}
          onRetryCompositions={() => { void compositions.mutate(); }}
          onRetryTransitions={() => { void transitions.mutate(); }}
          onSignatureClick={openFilteredGames}
        />
      ) : null}
      <BreakdownGrid data={data} />
      <TopMatchups rows={data.byMatchup} />
      <TendenciesAndPredictions
        strategies={data.topStrategies ?? []}
        predictions={data.predictedStrategies ?? []}
      />
      {showMacro ? <MacroAggregate macro={data.macro} /> : null}
      <Last5AndRecent
        data={data}
        filterGameIds={activeGameFilter?.gameIds}
        filterLabel={activeGameFilter?.label}
        onClearFilter={() => setGameFilter(null)}
      />
      {footerSlot ? footerSlot(data) : null}
    </div>
  );
}

function phaseApiPaths(
  apiPath: string,
  perspective?: "you" | "opponent",
): { compositions: string | null; transitions: string | null } {
  const paths: {
    compositions: string | null;
    transitions: string | null;
  } = { compositions: null, transitions: null };
  if (!apiPath) return paths;
  const url = new URL(apiPath, "https://sc2tools.invalid");
  if (perspective) url.searchParams.set("perspective", perspective);
  // Preserve the exact game scope and the hash used for SWR invalidation.
  const suffix = `${url.search}${url.hash}`;
  if (/^\/v1\/custom-builds\/[^/]+\/matches\/?$/.test(url.pathname)) {
    const base = url.pathname.replace(/\/matches\/?$/, "");
    paths.compositions = `${base}/compositions${suffix}`;
    // The transitions endpoint currently accepts only perspective. Avoid
    // presenting its unfiltered cohort next to a filtered composition.
    const scoped = [...url.searchParams.keys()].some((key) => key !== "perspective");
    if (!scoped) paths.transitions = `${base}/transitions${suffix}`;
  } else if (/^\/v1\/builds\/[^/]+\/?$/.test(url.pathname)) {
    paths.compositions = `${url.pathname.replace(/\/$/, "")}/phases${suffix}`;
  }
  return paths;
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
              Games with scores: {m!.gamesWithScore}
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
      {filterGameIds?.length ? (
        <CompositionSampleGames
          key={`${filterLabel}:${filterGameIds.join(",")}`}
          gameIds={filterGameIds}
          label={filterLabel}
          recent={data.recent ?? []}
          onClear={onClearFilter}
        />
      ) : <BuildGamesTable
        games={data.recent ?? []}
        resumedGames={data.resumedRecent ?? []}
        resumedCount={data.resumedCount ?? 0}
      />}
    </div>
  );
}

function CompositionSampleGames({
  gameIds,
  label,
  recent,
  onClear,
}: {
  gameIds: string[];
  label?: string;
  recent: BuildRecentGame[];
  onClear?: () => void;
}) {
  const [page, setPage] = useState(0);
  const ids = [...new Set(gameIds)].slice(0, 25);
  const pageSize = 10;
  const visibleIds = ids.slice(page * pageSize, (page + 1) * pageSize);
  const recentById = new Map(recent.map((game) => [game.gameId, game]));
  return (
    <Card title="Composition sample games">
      <div tabIndex={-1} role="region" aria-label="Selected composition sample games" className="mb-3 flex flex-wrap items-start justify-between gap-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="build-games-filter-chip">
        <div>
          <p className="text-caption font-medium text-text">{label}</p>
          <p className="mt-1 text-micro text-text-muted">
            {ids.length} saved sample{ids.length === 1 ? "" : "s"} · up to 25 replay examples per selection. Analysis totals can include more games.
          </p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="min-h-11 rounded-md border border-border px-3 py-2 text-caption text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Show all recent games
        </button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {visibleIds.map((id) => (
          <CompositionSampleGame key={id} gameId={id} cached={recentById.get(id)} />
        ))}
      </ul>
      {ids.length > pageSize ? (
        <div className="mt-3 flex flex-col gap-2 text-caption sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <span className="text-text-muted">{page * pageSize + 1}–{page * pageSize + visibleIds.length} of {ids.length} samples</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="min-h-11 rounded border border-border px-3 py-2 text-text disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Previous samples</button>
            <button type="button" disabled={(page + 1) * pageSize >= ids.length} onClick={() => setPage((value) => value + 1)} className="min-h-11 rounded border border-border px-3 py-2 text-text disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Next samples</button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function CompositionSampleGame({ gameId, cached }: { gameId: string; cached?: BuildRecentGame }) {
  // The dossier only includes recent games; sample IDs can refer to older
  // replays. Resolve those explicitly rather than silently dropping them.
  // Pagination bounds this to ten slim metadata requests at a time.
  const { data, error, isLoading, mutate } = useApi<GameSummary>(
    cached ? null : `/v1/games/${encodeURIComponent(gameId)}`,
    { revalidateOnFocus: false },
    { timeoutMs: 15_000 },
  );
  const row = cached ?? (data ? {
    gameId: data.gameId,
    date: data.date ?? "",
    map: data.map ?? undefined,
    opponent: data.opponent?.displayName ?? undefined,
    duration: data.durationSec ?? undefined,
    result: data.result ?? "",
  } : null);
  const result = row?.result?.toLowerCase();
  const resultLabel = result === "win" || result === "victory" ? "Win"
    : result === "loss" || result === "defeat" ? "Loss"
    : result === "tie" || result === "draw" ? "Draw" : "—";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-3" data-game-id={gameId}>
      <div className="min-w-0 flex-1">
        {row ? <>
          <p className="break-words text-caption font-medium text-text">{row.opponent || "Unknown opponent"} · {row.map || "Unknown map"}</p>
          <p className="mt-1 text-micro text-text-muted">{row.date ? fmtDate(row.date) : "Date unavailable"} · {row.duration != null ? fmtMinutes(row.duration) : "Length unavailable"} · {resultLabel}</p>
        </> : error ? <div role="status" className="text-caption text-text-muted">
          Sample details couldn't load.{" "}
          <button type="button" onClick={() => { void mutate(); }} className="inline-flex min-h-11 items-center text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Try again</button>
        </div> : <p className="text-caption text-text-muted" role="status">{isLoading ? "Loading sample game…" : "Sample game details unavailable"}</p>}
      </div>
      <Link href={`/app/game/${encodeURIComponent(gameId)}`} className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-border px-3 py-2 text-caption text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Open game
      </Link>
    </li>
  );
}

function PhaseAndTransitions({
  apiPath,
  compositions,
  compositionsLoading,
  compositionsError,
  transitions,
  transitionsLoading,
  transitionsError,
  showTransitions,
  onRetryCompositions,
  onRetryTransitions,
  onSignatureClick,
}: {
  apiPath: string;
  compositions: BuildPhasePayload | undefined;
  compositionsLoading: boolean;
  compositionsError: unknown;
  transitions: BuildTransitionsPayload | undefined;
  transitionsLoading: boolean;
  transitionsError: unknown;
  showTransitions: boolean;
  onRetryCompositions: () => void;
  onRetryTransitions: () => void;
  onSignatureClick: (sampleGameIds: string[], label: string) => void;
}) {
  const compositionsPending = compositionsLoading && !compositions;
  const transitionsPending = transitionsLoading && !transitions;

  return (
    <div className="space-y-5" data-testid="phase-and-transitions">
      <Card
        title="Army composition"
        right={compositions ? (
          <span className="text-micro text-text-muted">
            {compositions.perspective === "opponent" ? "Opponent army" : "Your army"}
          </span>
        ) : undefined}
      >
        {compositionsError ? (
          <PhaseLoadError
            title="Army composition unavailable"
            stale={Boolean(compositions)}
            onRetry={onRetryCompositions}
          />
        ) : null}
        {compositionsPending ? (
          <Skeleton rows={3} />
        ) : compositions ? (
          <PhaseSection
            apiPath={apiPath}
            payload={compositions}
            onSignatureClick={onSignatureClick}
          />
        ) : null}
      </Card>
      {showTransitions ? <Card title="Build transitions">
        {transitionsError ? (
          <PhaseLoadError
            title="Transitions unavailable"
            stale={Boolean(transitions)}
            onRetry={onRetryTransitions}
          />
        ) : null}
        {transitionsPending ? (
          <Skeleton rows={3} />
        ) : transitions ? (
          <BuildTransitionSankey transitions={transitions} />
        ) : null}
      </Card> : null}
    </div>
  );
}

function PhaseLoadError({
  title,
  stale,
  onRetry,
}: {
  title: string;
  stale: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated p-3">
      <div>
        <p className="text-caption font-medium text-text">{title}</p>
        <p className="mt-1 text-micro text-text-muted">
          {stale
            ? "Couldn't refresh this analysis. Showing the previous results."
            : "This analysis couldn't load. Try again in a moment."}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-3 py-2 text-caption text-text hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Retry ${title.toLowerCase().replace(" unavailable", "")}`}
      >
        Try again
      </button>
    </div>
  );
}

function PhaseSection({
  apiPath,
  payload,
  onSignatureClick,
}: {
  apiPath: string;
  payload: BuildPhasePayload;
  onSignatureClick: (sampleGameIds: string[], label: string) => void;
}) {
  if (payload.checkpoints?.length) {
    return <BuildCompositionExplorer key={apiPath} payload={payload} apiPath={apiPath} onOpenGames={onSignatureClick} />;
  }
  if (payload.flags?.includes("opp_signals_sparse")) {
    return (
      <EmptyState
        title="Opponent composition unavailable"
        sub="Most games in this selection are missing the opponent tracker data needed to identify phases. There isn't enough recorded data to calculate this army composition."
      />
    );
  }
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
        onSignatureClick={(sampleGameIds, context) => {
          if (!context) return;
          const { phase, signature } = context;
          const units = signature.units.length > 0
            ? signature.units.map((unit) => unitLabel(unit.token)).join(" · ")
            : signature.key || "Other";
          onSignatureClick(sampleGameIds, `${PHASE_LABELS[phase]} · ${units}`);
        }}
        onUnitClick={(sampleGameIds, { phase, token }) => {
          onSignatureClick(sampleGameIds, `${PHASE_LABELS[phase]} · Games with ${unitLabel(token)}`);
        }}
      />
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
