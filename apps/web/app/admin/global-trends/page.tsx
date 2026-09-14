"use client";

import { useCallback, useMemo, useState } from "react";
import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useGlobalTrendsApi } from "@/lib/globalTrendsApi";
import { FiltersContext, filtersToQuery, type AnalyzerFilters } from "@/lib/filterContext";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { TrendsTab } from "@/components/analyzer/TrendsTab";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Card";
import { ForbiddenCard } from "../components/AdminFragments";
import { GlobalPlayerPicker } from "./GlobalPlayerPicker";
import { GlobalGameFilters } from "./GlobalGameFilters";
import { ALL_GAME_FILTERS, ALL_PLAYERS, populationQuery, type Population, type TrendFilterOptions } from "./globalTrendsState";

export default function AdminGlobalTrendsPage() {
  // Give this access probe its own request identity so an unbounded chrome
  // request cannot leave this page waiting forever through SWR deduplication.
  const access = useApi<{ isAdmin?: boolean }>("/v1/me#global-trends-access", {
    revalidateOnFocus: false, shouldRetryOnError: false,
  }, { timeoutMs: 15_000 });
  if (access.error?.status === 403 || (access.data && access.data.isAdmin !== true)) return <ForbiddenCard />;
  if (access.error) return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Global Trends</h1>
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-5">
        <p className="font-medium text-danger">Could not verify admin access.</p>
        <p className="mt-1 text-sm text-text-muted">{access.error.message}</p>
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => { void access.mutate(); }}>Try again</Button>
      </div>
    </div>
  );
  if (!access.data) return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Global Trends</h1>
      <div role="status" aria-label="Checking admin access"><p className="mb-3 text-sm text-text-muted">Checking admin access…</p><Skeleton rows={3} /></div>
    </div>
  );
  return <GlobalTrendsContent />;
}

const EMPTY_OPTIONS: TrendFilterOptions = { maps: [], builds: [], strategies: [] };

function GlobalTrendsContent() {
  const [filters, setFilters] = useState<AnalyzerFilters>({ ...ALL_GAME_FILTERS });
  const [population, setPopulation] = useState<Population>({ ...ALL_PLAYERS });
  const [revision, setRevision] = useState(0);
  const options = useGlobalTrendsApi<TrendFilterOptions>(`/v1/admin/global-trends/filter-options${filtersToQuery({ refresh_after: revision || undefined })}#${revision}`);
  const seasonData = useSeasons();
  const seasons = useMemo(() => rollUpSeasons(seasonData.data?.items), [seasonData.data]);
  const cohort = useMemo(() => ({ ...populationQuery(population), refresh_after: revision || undefined }), [population, revision]);
  const bumpRev = useCallback(() => setRevision((r) => Math.max(Date.now(), r + 1)), []);
  const context = useMemo(() => ({ filters, setFilters, dbRev: revision, bumpRev, seasons }), [filters, revision, bumpRev, seasons]);

  if (options.error?.status === 403) return <ForbiddenCard />;

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent"><ChartNoAxesCombined className="h-4 w-4" aria-hidden />Platform analytics</div>
          <h1 className="text-3xl font-bold tracking-tight">Global Trends</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-muted">Explore combined results from every uploaded player history. Start with everyone, then narrow the players and games behind every chart.</p>
        </div>
        <div className="flex items-center gap-4">
          <a href="#global-trend-charts" className="text-sm font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">View trend charts</a>
          <Button variant="secondary" size="sm" iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={bumpRev} disabled={options.isLoading}>Refresh data</Button>
        </div>
      </header>

      {options.error ? (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-5">
          <p className="font-medium text-danger">Filter suggestions could not be loaded.</p>
          <p className="mt-1 text-sm text-text-muted">{options.error.message}</p>
          <p className="mt-1 text-sm text-text-muted">You can still enter a map, build, or strategy and use every chart below.</p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => { void options.mutate(); }}>Retry filter suggestions</Button>
        </div>
      ) : options.isLoading ? <p role="status" className="text-caption text-text-muted">Loading filter suggestions. Player data and charts load independently below.</p> : null}
        <FiltersContext.Provider value={context}>
          <GlobalPlayerPicker population={population} onApply={setPopulation} revision={revision} />
          <GlobalGameFilters options={options.data ?? EMPTY_OPTIONS} />
          <div className="rounded-lg border border-border bg-bg-surface px-4 py-3 text-caption leading-relaxed text-text-muted">
            Totals count each player’s recorded perspective once per game. When both players uploaded a match, both perspectives contribute. MMR changes and session momentum are calculated within each player’s own history.
          </div>
          <section id="global-trend-charts" aria-label="All-player trend charts" className="scroll-mt-20 space-y-4">
            <h2 className="text-xl font-semibold">All-player trends</h2>
            <TrendsDataProvider mode="global" cohort={cohort}>
              <TrendsTab />
            </TrendsDataProvider>
          </section>
        </FiltersContext.Provider>
    </div>
  );
}
