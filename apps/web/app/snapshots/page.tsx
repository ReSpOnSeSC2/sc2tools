"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { BandChart } from "@/components/snapshots/BandChart";
import { CohortPicker, type CohortPickerValue } from "@/components/snapshots/CohortPicker";
import { SnapshotLegend } from "@/components/snapshots/SnapshotLegend";
import { isTooSmall, useBuilds, useCohort } from "@/lib/snapshots/fetchCohort";
import type {
  CohortResponse,
  CohortTooSmall,
  MetricKey,
} from "@/components/snapshots/shared/snapshotTypes";
import { tierLabel } from "@/components/snapshots/shared/snapshotTypes";

// /snapshots — cohort browser landing page. Pure cohort view (no
// user game overlay), used for exploration: "what does a typical
// PvZ game look like at 4400 MMR?"

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "army_value", label: "Army value" },
  { key: "army_supply", label: "Supply" },
  { key: "workers", label: "Workers" },
  { key: "bases", label: "Bases" },
];

export default function SnapshotsPage() {
  const [filters, setFilters] = useState<CohortPickerValue>({
    scope: "community",
  });
  const { data: builds } = useBuilds(filters.matchup);
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
  const { data, isLoading, error } = useCohort(cohortQuery);
  const resolvedTier =
    data && !isTooSmall(data) ? (data as CohortResponse).cohortTier : undefined;
  const resolvedSize =
    data && !isTooSmall(data) ? (data as CohortResponse).sampleSize : undefined;
  const availableBuilds = (builds?.builds || [])
    .filter((b) => !filters.matchup || b.matchup === filters.matchup)
    .map((b) => b.name);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-h2 font-semibold text-text">Snapshot cohorts</h1>
        <p className="mt-1 text-body text-text-muted">
          Compare any (build × matchup × MMR) cohort against winners and losers.
          Pick a matchup to begin.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-4">
          <CohortPicker
            value={filters}
            onChange={setFilters}
            cohortTier={resolvedTier}
            sampleSize={resolvedSize}
            availableBuilds={availableBuilds}
          />
          <SnapshotLegend />
        </aside>
        <section className="space-y-4">
          <Body
            filters={filters}
            data={data}
            isLoading={isLoading}
            error={error}
          />
        </section>
      </div>
    </div>
  );
}

function Body({
  filters,
  data,
  isLoading,
  error,
}: {
  filters: CohortPickerValue;
  data: CohortResponse | CohortTooSmall | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (!filters.matchup) {
    return (
      <Card>
        <EmptyState
          title="Pick a matchup to load cohort bands"
          sub="Each band shows the P25–P75 envelope for winners and losers in the chosen cohort."
        />
      </Card>
    );
  }
  if (isLoading) {
    return <Skeleton rows={4} />;
  }
  if (error) {
    return (
      <Card>
        <EmptyState
          title="Couldn't load the cohort"
          sub={(error as { message?: string })?.message || "Try a broader filter."}
        />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <EmptyState title="No data yet." />
      </Card>
    );
  }
  if (isTooSmall(data)) {
    return (
      <Card variant="feature">
        <div className="space-y-2 p-4">
          <h2 className="text-h3 font-semibold text-text">Need more games in this cohort</h2>
          <p className="text-body text-text-muted">
            Your filter has {data.sampleSize} game{data.sampleSize === 1 ? "" : "s"};
            cohort bands require at least {data.requiredMin}. Broaden the matchup,
            drop the opening filter, or switch scope to community.
          </p>
          <p className="text-caption text-text-dim">
            Tip: upload more replays via the desktop agent for finer-grained "mine" cohorts.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <>
      <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-caption text-accent">
        Resolved cohort: {tierLabel(data.cohortTier)} · {data.sampleSize} games
        {data.cached ? " · cached" : " · fresh"}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {METRICS.map((m) => (
          <BandChart
            key={m.key}
            title={m.label}
            metric={m.key}
            cohort={data.ticks}
            compact
            hideOpp
          />
        ))}
      </div>
    </>
  );
}
