"use client";

import { use, useMemo, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { CohortPicker, type CohortPickerValue } from "@/components/snapshots/CohortPicker";
import { BandChart } from "@/components/snapshots/BandChart";
import { PositionTimeline } from "@/components/snapshots/PositionTimeline";
import { CompositionDeltaTable } from "@/components/snapshots/CompositionDeltaTable";
import { CompositionStackChart } from "@/components/snapshots/CompositionStackChart";
import { InflectionCallout } from "@/components/snapshots/InflectionCallout";
import { TimingMissList } from "@/components/snapshots/TimingMissList";
import { CoachingTagChips } from "@/components/snapshots/CoachingTagChips";
import { NeighborGameList } from "@/components/snapshots/NeighborGameList";
import { ShareCardButton } from "@/components/snapshots/ShareCardButton";
import { SnapshotLegend } from "@/components/snapshots/SnapshotLegend";
import { ProductionBandStrip } from "@/components/snapshots/ProductionBandStrip";
import { TechPathTimeline } from "@/components/snapshots/TechPathTimeline";
import { TechPathAlternatives } from "@/components/snapshots/TechPathAlternatives";
import { CompositionMatchupMatrix } from "@/components/snapshots/CompositionMatchupMatrix";
import { CompositionMatchupRow } from "@/components/snapshots/CompositionMatchupRow";
import { CounterSuggestionList } from "@/components/snapshots/CounterSuggestion";
import { useSyncedCursor } from "@/components/snapshots/shared/useSyncedCursor";
import { useCohort, isTooSmall } from "@/lib/snapshots/fetchCohort";
import { useGameSnapshot, isGameTooSmall } from "@/lib/snapshots/fetchGameSnapshot";
import {
  fmtTick,
  tierLabel,
  type CohortResponse,
  type GameSnapshotResponse,
  type MetricKey,
} from "@/components/snapshots/shared/snapshotTypes";

// /games/[gameId]/snapshot — single-game vs cohort drilldown.
// Layout: 3 columns on desktop, 1 stacked column on mobile. The
// PositionTimeline serves as both the hero overview AND the
// scrubber that drives the synced cursor across every band chart.

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "army_value", label: "Army value" },
  { key: "army_supply", label: "Supply" },
  { key: "workers", label: "Workers" },
  { key: "bases", label: "Bases" },
];

export default function GameSnapshotPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = use(params);
  const [filters, setFilters] = useState<CohortPickerValue>({
    scope: "community",
  });
  const cursor = useSyncedCursor();

  const snapshotQuery = useMemo(
    () => ({
      gameId,
      scope: filters.scope,
      mmrBucket: filters.mmrBucket,
      mapId: filters.mapId,
    }),
    [gameId, filters.scope, filters.mmrBucket, filters.mapId],
  );

  const cohortQuery = useMemo(() => {
    if (!filters.matchup) return null;
    return {
      build: filters.build,
      matchup: filters.matchup,
      oppOpening: filters.oppOpening,
      mmrBucket: filters.mmrBucket,
      mapId: filters.mapId,
      scope: filters.scope,
    };
  }, [filters]);

  const snapshot = useGameSnapshot(snapshotQuery);
  const cohort = useCohort(cohortQuery);

  const game = snapshot.data && !isGameTooSmall(snapshot.data)
    ? (snapshot.data as GameSnapshotResponse)
    : null;
  const cohortData = cohort.data && !isTooSmall(cohort.data)
    ? (cohort.data as CohortResponse)
    : null;

  const focusedTick = cursor.tick;
  const focusedVerdict = focusedTick !== null && game
    ? game.ticks.find((t) => t.t === focusedTick)?.verdict
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-h2 font-semibold text-text">Game-state snapshot</h1>
          <p className="mt-1 text-body text-text-muted">
            Game{" "}
            <code className="font-mono text-caption text-text-dim">{gameId}</code>{" "}
            vs cohort{game ? ` · ${tierLabel(game.cohortTier)}` : ""}
          </p>
        </div>
        {game ? (
          <ShareCardButton
            gameId={gameId}
            verdictLabel={
              focusedVerdict
                ? `Verdict at ${fmtTick(focusedTick!)}: ${focusedVerdict.replace("_", " ")}`
                : "Snapshot analysis"
            }
            inflectionAt={
              game.insights.inflectionTick !== null
                ? fmtTick(game.insights.inflectionTick)
                : null
            }
            cohortLabel={`${tierLabel(game.cohortTier)} · ${game.sampleSize} games`}
          />
        ) : null}
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="space-y-4">
          <CohortPicker
            value={filters}
            onChange={setFilters}
            cohortTier={game?.cohortTier}
            sampleSize={game?.sampleSize}
          />
          <SnapshotLegend />
        </aside>

        <section className="space-y-4 min-w-0">
          {snapshot.isLoading ? (
            <Skeleton rows={6} />
          ) : snapshot.error ? (
            <Card>
              <EmptyState
                title="Couldn't load this game"
                sub={snapshot.error?.message}
              />
            </Card>
          ) : snapshot.data && isGameTooSmall(snapshot.data) ? (
            <Card variant="feature">
              <div className="p-4">
                <h2 className="text-h3 font-semibold text-text">
                  Need more games to compare against
                </h2>
                <p className="mt-2 text-body text-text-muted">
                  The cohort for this game has {snapshot.data.sampleSize}{" "}
                  games; we need at least {snapshot.data.requiredMin} to draw
                  the percentile bands. Switch the scope to community for a wider pool.
                </p>
              </div>
            </Card>
          ) : game ? (
            <>
              <PositionTimeline
                ticks={game.ticks}
                focusedTick={focusedTick}
                onFocus={cursor.setTick}
                pinned={cursor.pinned}
                onPinToggle={cursor.togglePin}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {METRICS.map((m) => (
                  <BandChart
                    key={m.key}
                    title={m.label}
                    metric={m.key}
                    cohort={(cohortData?.ticks) ?? mergeCohortFromGame(game)}
                    gameTicks={game.ticks}
                    cursorTick={focusedTick}
                    onHover={cursor.setTick}
                    compact
                  />
                ))}
                <ProductionBandStrip
                  cohort={cohortData?.ticks ?? mergeCohortFromGame(game)}
                  gameTicks={game.ticks}
                  cursorTick={focusedTick}
                  onHover={cursor.setTick}
                />
              </div>
              <TechPathTimeline
                ticks={game.ticks}
                focusedTick={focusedTick}
                onFocus={cursor.setTick}
              />
              <CompositionStackChart
                cohort={cohortData?.ticks ?? mergeCohortFromGame(game)}
                gameTicks={game.ticks}
                side="my"
              />
              <FocusMatchup
                game={game}
                focusedTick={focusedTick}
              />
              <CompositionDeltaTable
                ticks={game.ticks}
                focusedTick={focusedTick}
                side="my"
              />
            </>
          ) : null}
        </section>

        <aside className="space-y-4">
          {game ? (
            <>
              <InflectionCallout
                insights={game.insights}
                onJump={(t) => {
                  cursor.setTick(t);
                  if (!cursor.pinned) cursor.togglePin();
                }}
              />
              <TechPathAlternatives techPath={focusedTechPath(game, focusedTick)} />
              <TimingMissList misses={game.insights.timingMisses} />
              <CoachingTagChips
                rows={game.insights.coachingTags}
                focusedTick={focusedTick}
              />
              <NeighborGameList gameId={gameId} anchorTick={focusedTick} />
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// Fallback: if the dedicated cohort fetch isn't returning band data
// (no matchup picked), use the bands the game endpoint embedded for
// its own resolved cohort.
function mergeCohortFromGame(game: GameSnapshotResponse) {
  return game.ticks.map((t) => ({
    t: t.t,
    my: synthesizeBand(t.my.value),
    opp: synthesizeBand(t.opp.value),
  }));
}

function synthesizeBand(values: Partial<Record<MetricKey, number | null>>) {
  // The game endpoint doesn't echo cohort bands explicitly; this
  // returns an empty band so BandChart can still render the user line.
  return {} as Record<string, never>;
}

function focusedTechPath(game: GameSnapshotResponse, focusedTick: number | null) {
  if (focusedTick === null) {
    for (let i = game.ticks.length - 1; i >= 0; i -= 1) {
      if (game.ticks[i].techPath) return game.ticks[i].techPath ?? null;
    }
    return null;
  }
  const tick = game.ticks.find((t) => t.t === focusedTick);
  return tick?.techPath ?? null;
}

function FocusMatchup({
  game,
  focusedTick,
}: {
  game: GameSnapshotResponse;
  focusedTick: number | null;
}) {
  const ANCHOR_TICKS = [180, 300, 420, 600, 780, 960];
  const anchor = nearestAnchor(focusedTick, ANCHOR_TICKS);
  const tick = game.ticks.find((t) => t.t === anchor);
  const block = tick?.compositionMatchup ?? null;
  return (
    <>
      <div className="hidden sm:block">
        <CompositionMatchupMatrix block={block} />
      </div>
      <div className="sm:hidden">
        <CompositionMatchupRow block={block} />
      </div>
      <CounterSuggestionList
        suggestions={block?.counterSuggestions ?? []}
        currentWinRate={block?.winRate}
      />
    </>
  );
}

function nearestAnchor(focused: number | null, anchors: number[]): number {
  if (focused === null) return anchors[1] || anchors[0] || 360;
  let best = anchors[0];
  let bestDiff = Infinity;
  for (const a of anchors) {
    const d = Math.abs(a - focused);
    if (d < bestDiff) {
      bestDiff = d;
      best = a;
    }
  }
  return best;
}
