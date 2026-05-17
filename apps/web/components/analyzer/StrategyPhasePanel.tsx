"use client";

import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import {
  PhaseTrajectoryStrip,
} from "./PhaseTrajectoryStrip";
import {
  PhaseCompositionTabs,
  type Phase,
  type PhaseCompositionRow,
} from "./PhaseCompositionTabs";

/**
 * Response shape of GET /v1/strategies/:name/phases — phase-aware
 * aggregator keyed by opponent strategy. Shared semantics with the
 * BuildPhasePayload from the BuildDossier surface: a single ``total``
 * is added because the strategy bucket has no slug to count against.
 */
export type StrategyPhasesPayload = {
  name: string;
  total: number;
  /** Echoed by the API. The default StrategyPhasePanel renders the
   *  "you" perspective (the user's side of replays against this
   *  strategy); the BuildVsStrategyComparison renders the right
   *  column with ``?perspective=opponent``. Optional for back-
   *  compat with older snapshots that omitted the field. */
  perspective?: "you" | "opponent";
  sampleSize: Record<Phase, number>;
  perPhase: Record<Phase, PhaseCompositionRow>;
  finalPhaseDistribution: Record<Phase, number>;
  medianCrossings: {
    earlyMidAt: number | null;
    midAt: number | null;
    midLateAt: number | null;
    lateAt: number | null;
  };
  durationP95Sec: number;
  flags: string[];
};

const MIN_GAMES_FOR_PHASE_VIEW = 5;
const CARD_TITLE = "What this matchup looks like phase-by-phase";

/**
 * Drill-down phase panel for the StrategiesTab. Fetches
 * ``/v1/strategies/:name/phases``, then renders the
 * PhaseTrajectoryStrip + PhaseCompositionTabs already used by the
 * BuildDossier — no sankey on this tab because StrategiesTab is
 * about "what they're doing", not your routing.
 *
 * ``showTechRow=false`` on the composition tabs because tech-reached-
 * by-phase overlaps semantically with the per-strategy MMR / tech
 * widgets in StrategyMmrPanel; keeping the tab focused on unit-comp
 * signatures avoids the duplicate column.
 */
export function StrategyPhasePanel({ strategy }: { strategy: string }) {
  const { dbRev } = useFilters();
  const path = strategy
    ? `/v1/strategies/${encodeURIComponent(strategy)}/phases#${dbRev}`
    : null;
  const { data, isLoading, error } = useApi<StrategyPhasesPayload>(path);

  if (isLoading && !data) {
    return (
      <Card title={CARD_TITLE}>
        <Skeleton rows={3} />
      </Card>
    );
  }
  // A 404 here means the strategy has no qualifying games in the
  // recent window — fall back to the EmptyState, same as the
  // < 5 games guard below. Other errors hide the card entirely so
  // a transient server hiccup doesn't squat on the drill-down.
  if (error && error.status !== 404) return null;
  const total = data?.total ?? 0;
  if (!data || total < MIN_GAMES_FOR_PHASE_VIEW) {
    return (
      <Card title={CARD_TITLE}>
        <EmptyState
          title="Not enough games on this strategy yet"
          sub={
            total > 0
              ? `${total} game${total === 1 ? "" : "s"} so far · the phase view starts at ${MIN_GAMES_FOR_PHASE_VIEW}.`
              : `Play a few games against this strategy to see what these matchups typically look like phase-by-phase.`
          }
        />
      </Card>
    );
  }

  return (
    <Card title={CARD_TITLE}>
      <div className="space-y-4">
        <PhaseTrajectoryStrip
          sampleSize={data.sampleSize}
          crossings={data.medianCrossings}
          finalPhaseDistribution={data.finalPhaseDistribution}
          durationP95Sec={data.durationP95Sec}
        />
        {/* preferredPhase=mid lands the user on the typical mid-game
            composition without clicking; PhaseCompositionTabs falls
            back to the first reached phase when mid is empty. */}
        <PhaseCompositionTabs
          sampleSize={data.sampleSize}
          perPhase={data.perPhase}
          preferredPhase="mid"
          showTechRow={false}
        />
      </div>
    </Card>
  );
}
