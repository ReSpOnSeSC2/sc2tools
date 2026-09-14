"use client";

import { useCallback, useMemo, useState } from "react";
import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { useApi } from "@/lib/clientApi";
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
  const [filters, setFilters] = useState<AnalyzerFilters>({ ...ALL_GAME_FILTERS });
  const [population, setPopulation] = useState<Population>({ ...ALL_PLAYERS });
  const [revision, setRevision] = useState(0);
  const options = useApi<TrendFilterOptions>(`/v1/admin/global-trends/filter-options${filtersToQuery({ refresh_after: revision || undefined })}#${revision}`, { revalidateOnFocus: false });
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
        <Button variant="secondary" size="sm" iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={bumpRev} disabled={options.isLoading}>Refresh data</Button>
      </header>

      {options.error ? (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-5">
          <p className="font-medium text-danger">Could not load Global Trends.</p>
          <p className="mt-1 text-sm text-text-muted">{options.error.message}</p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => { void options.mutate(); }}>Try again</Button>
        </div>
      ) : !options.data ? <div role="status" aria-label="Loading Global Trends"><Skeleton rows={5} /></div> : (
        <FiltersContext.Provider value={context}>
          <GlobalPlayerPicker population={population} onApply={setPopulation} revision={revision} />
          <GlobalGameFilters options={options.data} />
          <div className="rounded-lg border border-border bg-bg-surface px-4 py-3 text-caption leading-relaxed text-text-muted">
            Totals count each player’s recorded perspective once per game. When both players uploaded a match, both perspectives contribute. MMR changes and session momentum are calculated within each player’s own history.
          </div>
          <TrendsDataProvider mode="global" cohort={cohort}>
            <TrendsTab />
          </TrendsDataProvider>
        </FiltersContext.Provider>
      )}
    </div>
  );
}
