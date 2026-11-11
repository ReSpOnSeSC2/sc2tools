"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { RefreshCw } from "lucide-react";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";
import { useGlobalTrendsApi } from "@/lib/globalTrendsApi";
import { FiltersContext, applyFilterPatch, describeActiveFilters, filtersToQuery, type AnalyzerFilters } from "@/lib/filterContext";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { ActiveFilterChips } from "@/components/analyzer/ActiveFilterChips";
import { GlobalTrendsCharts } from "./GlobalTrendsCharts";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Card";
import { SaveBar } from "@/components/ui/SaveBar";
import { ForbiddenCard } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { GlobalGameFilters } from "./GlobalGameFilters";
import { PopulationChips } from "./PopulationChips";
import {
  ALL_GAME_FILTERS, DEFAULT_TREND_VIEW, LINK_PLAYERS_LIMIT, PRIVATE_PLAYERS_LIMIT, TREND_QUERY_DEFAULTS,
  canonicalGameFilters, chartFilters, countTrendChanges, mmrRangeError, populationQuery, readTrendView,
  trendDraft, trendQueryPatch, trendQuerySignature, trendViewQuery, viewFromDraft,
  type Population, type TrendFilterOptions, type TrendView,
} from "./globalTrendsState";

const GlobalPlayerPicker = dynamic(() => import("./GlobalPlayerPicker").then((module) => module.GlobalPlayerPicker), {
  ssr: false,
  loading: () => <div role="status" aria-label="Loading player population"><Skeleton rows={3} /></div>,
});
const GlobalTrendsViews = dynamic(() => import("./GlobalTrendsViews").then(module => module.GlobalTrendsViews), { ssr: false });
const EMPTY_OPTIONS: TrendFilterOptions = { maps: [], builds: [], strategies: [] };

export default function AdminGlobalTrendsPage() {
  const { userId } = useAuth();
  return <Suspense fallback={<Skeleton rows={3} />}><GlobalTrendsContent key={userId ?? "signed-out"} /></Suspense>;
}

function useGlobalTrendView() {
  const search = useSearchParams().toString();
  const pathname = usePathname();
  const [, replaceQuery] = useAdminQueryState(TREND_QUERY_DEFAULTS);
  const [initial] = useState(() => readTrendView(new URLSearchParams(search)));
  const [applied, setApplied] = useState(initial.view);
  const [draft, setDraft] = useState(() => trendDraft(initial.view));
  const [malformed, setMalformed] = useState(initial.malformed);
  const lastSeen = useRef(search);
  const acknowledgements = useRef(new Set<string>());

  const writeQuery = useCallback((view: TrendView, current: URLSearchParams) => {
    const target = trendViewQuery(view);
    const signature = trendQuerySignature(target);
    if (signature === trendQuerySignature(current)) return;
    const pending = acknowledgements.current;
    pending.add(signature);
    if (pending.size > 16) pending.delete(pending.values().next().value!);
    replaceQuery(trendQueryPatch(target), { history: "replace", canonical: true });
  }, [replaceQuery]);

  useEffect(() => {
    const query = new URLSearchParams(search);
    const moved = search !== lastSeen.current;
    lastSeen.current = search;
    if (moved && acknowledgements.current.delete(trendQuerySignature(query))) return;
    const next = readTrendView(query);
    if (moved) {
      setApplied(next.view);
      setDraft(trendDraft(next.view));
      setMalformed(next.malformed);
    }
    if (next.unsafeIds) writeQuery(next.view, query);
  }, [search, writeQuery]);

  const commit = (next: TrendView, updateDraft = true) => {
    setApplied(next);
    if (updateDraft) setDraft(trendDraft(next));
    writeQuery(next, new URLSearchParams(search));
  };
  return { applied, draft, setDraft, commit, malformed, dismiss: () => setMalformed(false),
    shareHref: `${pathname}?${trendViewQuery(applied)}` };
}

function GlobalTrendsContent() {
  const { applied, draft, setDraft, commit, malformed, dismiss, shareHref } = useGlobalTrendView();
  const [revision, setRevision] = useState(0);
  const [forbidden, setForbidden] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const onForbidden = useCallback(() => setForbidden(true), []);
  const options = useGlobalTrendsApi<TrendFilterOptions>(`/v1/admin/global-trends/filter-options${filtersToQuery({ refresh_after: revision || undefined })}#${revision}`);
  const seasonData = useSeasons();
  const seasons = useMemo(() => rollUpSeasons(seasonData.data?.items), [seasonData.data]);
  const cohort = useMemo(() => ({ ...populationQuery(applied.population), cohort_refs: 1, refresh_after: revision || undefined }), [applied.population, revision]);
  const bumpRev = useCallback(() => setRevision((value) => Math.max(Date.now(), value + 1)), []);
  const filters = useMemo(() => chartFilters(applied.filters, seasons), [applied.filters, seasons]);
  const draftFilters = useMemo(() => chartFilters(draft.filters, seasons), [draft.filters, seasons]);
  const changes = countTrendChanges(applied, draft);
  const dateError = draft.filters.preset === "custom" && draft.filters.since && draft.filters.until && draft.filters.since > draft.filters.until;
  const selectionTooLarge = draft.population.playerIds.length > PRIVATE_PLAYERS_LIMIT;
  const invalid = !!(dateError || selectionTooLarge || mmrRangeError(draft.opponentMin, draft.opponentMax) || mmrRangeError(draft.population.mmrMin, draft.population.mmrMax));
  const applyDraft = () => { if (changes && !invalid) commit(viewFromDraft(draft)); };
  const tooManyForLink = applied.population.playerIds.length > LINK_PLAYERS_LIMIT;
  const common = { dbRev: revision, bumpRev, seasons };

  const removeGameFilter = (next: AnalyzerFilters) => {
    const patch = Object.fromEntries(Object.entries({ ...filters, ...next }).flatMap(([key]) => {
      const facet = key as keyof AnalyzerFilters;
      return filters[facet] === next[facet] ? [] : [[key, next[facet]]];
    }));
    commit({ ...applied, filters: canonicalGameFilters(next) }, false);
    setDraft(previous => ({ ...previous, filters: applyFilterPatch(previous.filters, patch),
      ...("mmr_min" in patch ? { opponentMin: next.mmr_min?.toString() ?? "" } : {}),
      ...("mmr_max" in patch ? { opponentMax: next.mmr_max?.toString() ?? "" } : {}),
    }));
  };
  const removePopulationFilter = (patch: Partial<Population>) => {
    commit({ ...applied, population: { ...applied.population, ...patch } }, false);
    setDraft(previous => ({ ...previous, population: { ...previous.population, ...patch } }));
  };
  const draftContext = { ...common, filters: draftFilters, setFilters: (next: AnalyzerFilters) => setDraft(previous => ({ ...previous, filters: next })) };
  const appliedContext = { ...common, filters, setFilters: removeGameFilter };

  if (forbidden || options.error?.status === 403) return <ForbiddenCard />;
  return (
    <div className="min-w-0 space-y-5">
      <AdminPageHeader anchor="global-trends" title="Global trends" description="Explore aggregate ladder trends across the platform." actions={<>
        <a href="#global-trend-charts" className="text-sm font-semibold text-accent underline">View trend charts</a>
        <Button variant="secondary" size="sm" onClick={() => setViewsOpen(true)}>Views</Button>
        <Button variant="secondary" size="sm" disabled={tooManyForLink} onClick={async () => {
          try { await navigator.clipboard.writeText(new URL(shareHref, window.location.origin).href); setCopyNotice("View link copied."); }
          catch { setCopyNotice("Could not copy the view link. Copy it from the address bar after applying your filters."); }
        }}>Copy view link</Button>
        <Button variant="secondary" size="sm" iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={bumpRev} disabled={options.isLoading}>Refresh data</Button>
      </>} />
      <details className="text-caption text-text-muted">
        <summary className="cursor-pointer font-semibold text-text">About these numbers</summary>
        <p className="mt-2">Player filters select contributors by current MMR, recorded race and directory selection. Game filters narrow individual records by the date, opponent MMR and other game details.</p>
        <p className="mt-2">When both players uploaded a match, both perspectives contribute. Rating changes and session momentum use each player’s history separately.</p>
      </details>
      {copyNotice ? <p role="status" className="text-caption text-text-muted">{copyNotice}</p> : null}
      {tooManyForLink ? <p role="status" className="text-caption text-warning">Too many players to share by link; save it as a view.</p> : null}
      {malformed ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 p-3 text-caption">
        <span>Some filters in this link were invalid. Default values were used for those filters.</span>
        <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
      </div> : null}
      {options.error ? <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-5">
        <p className="font-medium text-danger">Filter suggestions could not be loaded.</p>
        <p className="mt-1 text-sm text-text-muted">{options.error.message}</p>
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => { void options.mutate(); }}>Retry filter suggestions</Button>
      </div> : options.isLoading ? <p role="status" className="text-caption text-text-muted">Loading filter suggestions.</p> : null}

      <div className="space-y-5" onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement
          && ["number", "text", "date"].includes(event.target.type)) {
          event.preventDefault();
          applyDraft();
        }
      }}>
        <GlobalPlayerPicker population={applied.population} draft={draft.population} revision={revision} onForbidden={onForbidden}
          setDraft={edit => setDraft(previous => ({ ...previous, population: edit(previous.population) }))} />
        <FiltersContext.Provider value={draftContext}>
          <GlobalGameFilters options={options.data ?? EMPTY_OPTIONS} min={draft.opponentMin} max={draft.opponentMax}
            onMin={opponentMin => setDraft(previous => ({ ...previous, opponentMin }))}
            onMax={opponentMax => setDraft(previous => ({ ...previous, opponentMax }))} />
        </FiltersContext.Provider>
      </div>
      {dateError ? <p role="alert" className="text-sm text-danger">Choose an end date on or after the start date.</p> : null}
      {selectionTooLarge ? <p role="alert" className="text-sm text-danger">Choose up to {PRIVATE_PLAYERS_LIMIT} individual players, or narrow by race or MMR.</p> : null}
      <SaveBar visible disableUnloadGuard stackOnMobile saveDisabled={!changes || invalid} saveLabel="Apply" resetLabel="Reset"
        message={`${changes} ${changes === 1 ? "change" : "changes"} pending`} onSave={applyDraft}
        onReset={changes ? () => setDraft(trendDraft(applied)) : undefined} />

      <FiltersContext.Provider value={appliedContext}>
        <section id="global-trend-charts" aria-label="All-player trend charts" className="scroll-mt-20 space-y-4 pb-24">
          <h2 className="text-xl font-semibold">All-player trends</h2>
          <div className="flex flex-wrap items-center gap-2">
            <ActiveFilterChips defaults={ALL_GAME_FILTERS} showViewLink={false} showReset={false} />
            <PopulationChips population={applied.population} onRemove={removePopulationFilter} />
            {describeActiveFilters(filters, { defaults: ALL_GAME_FILTERS, seasons }).length || countTrendChanges(DEFAULT_TREND_VIEW, trendDraft(applied))
              ? <Button variant="ghost" size="sm" onClick={() => commit(DEFAULT_TREND_VIEW)}>Reset all</Button> : null}
          </div>
          <TrendsDataProvider mode="global" cohort={cohort} onForbidden={onForbidden}><GlobalTrendsCharts /></TrendsDataProvider>
        </section>
      </FiltersContext.Provider>
      {viewsOpen ? <GlobalTrendsViews current={applied} onApply={view => { commit(view); setViewsOpen(false); }} onClose={() => setViewsOpen(false)} /> : null}
    </div>
  );
}
