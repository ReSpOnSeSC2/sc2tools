"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery, describeActiveFilters } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { StrengthCell, StrengthGuide, StrengthHeader, WinRateRange } from "./StrengthAdjusted";
import type { StrengthFields } from "@/lib/strengthAdjusted";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { usePersistentSort, SortableTh, type SortState } from "@/components/ui/SortableTh";
import { WinRateSortToggle } from "@/components/ui/WinRateSortToggle";
import { NoFilterMatches } from "./EmptyStates";
import { PhaseTrajectoryStrip } from "./PhaseTrajectoryStrip";
import {
  PhaseCompositionTabs,
  type Phase,
  type PhaseCompositionRow,
} from "./PhaseCompositionTabs";
import type { CustomBuild } from "@/components/builds/types";
import type { BuildPhasePayload } from "@/lib/serverApi";
import { Download } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csvExport";
import { defaultMatrixRace, matrixAxes as matrixAxesForExport, type MatrixRace } from "@/lib/strategyMatrix";
import { StrategyMatrixHeatmap } from "./StrategyMatrixHeatmap";
import { strategyDrillFilters } from "@/lib/strategyDrill";

/**
 * Build × Opponent-strategy matrix for ``StrategiesTab``.
 *
 * Pulled out so ``StrategiesTab.tsx`` stays under the 800-line cap.
 * The view, MinGames threshold, and view-mode preferences are
 * persisted to localStorage by the parent — this file owns only the
 * presentational matrix + table renderers.
 */

const LS_BVS_SORT = "analyzer.strategies.bvs.sort";

export type BvsCell = StrengthFields & {
  myMatchups?: Partial<Record<"P" | "T" | "Z", number>>;
  my_build: string;
  opp_strat: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

const BVS_COLUMNS: readonly (CsvColumn<BvsCell> & { strength?: boolean })[] = [
  { key: "my_build", label: "My build" }, { key: "opp_strat", label: "vs Opponent strategy" },
  { key: "wins", label: "W" }, { key: "losses", label: "L" }, { key: "total", label: "Games" }, { key: "winRate", label: "WR" },
  { key: "winsAboveExpected", label: "Vs expected", strength: true, format: (value, row) => (row.ratedGames ?? 0) > 0 && typeof value === "number" ? value : null },
];

export interface BuildVsStrategyViewProps {
  onOpenBvs: (build: string, strategy: string, race?: string) => void;
  /** Current view mode — fully controlled by the caller. */
  initialView: "heatmap" | "table";
  /** Current min-games threshold — fully controlled by the caller. */
  initialMinGames: number;
  /** Setter invoked when the user flips the view mode. */
  onViewChange: (view: "heatmap" | "table") => void;
  /** Setter invoked when the user adjusts the threshold. */
  onMinGamesChange: (n: number) => void;
  /** MinGames picker rendered above the matrix — supplied by the
   *  parent so the same control is shared with the by-strategy view. */
  renderMinGamesPicker: (
    value: number,
    onChange: (n: number) => void,
  ) => React.ReactNode;
}

export function BuildVsStrategyView({
  onOpenBvs,
  initialView,
  initialMinGames,
  onViewChange,
  onMinGamesChange,
  renderMinGamesPicker,
}: BuildVsStrategyViewProps) {
  const { filters, dbRev, seasons } = useFilters();
  const [search, setSearch] = useState("");
  const [chosenRace, setChosenRace] = useState<{ scope: string; race: MatrixRace } | null>(null);
  const [axisOrder, setAxisOrder] = useLocalStorageState<"games" | "az">("analyzer.bvs.sort", "games", (raw): raw is "games" | "az" => raw === "games" || raw === "az");
  const view = initialView, minGames = initialMinGames;
  const sort = usePersistentSort(LS_BVS_SORT, "total", "desc");
  const scopeKey = filtersToQuery(filters);
  const overall = useApi<BvsCell[]>(`/v1/build-vs-strategy${scopeKey}#${dbRev}`, { keepPreviousData: false });
  const localRace = chosenRace?.scope === scopeKey ? chosenRace.race : defaultMatrixRace(overall.data);
  const race = filters.opp_race || (localRace === "all" ? undefined : localRace);
  // One selected-cohort request, never a request per race. Preserve every global
  // filter, including strategy, when narrowing the local matrix.
  const selected = useApi<BvsCell[]>(!filters.opp_race && race ? `/v1/build-vs-strategy${filtersToQuery({ ...filters, opp_race: race })}#${dbRev}` : null, { keepPreviousData: false });
  const cellsApi = !filters.opp_race && race ? selected : overall;
  const { filtered, hiddenByMinGames } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const searched = (cellsApi.data || []).filter(row => row.total > 0 && (!term || row.my_build.toLowerCase().includes(term) || row.opp_strat.toLowerCase().includes(term)));
    const filtered = searched.filter(row => row.total >= minGames);
    return { filtered, hiddenByMinGames: searched.length - filtered.length };
  }, [cellsApi.data, search, minGames]);
  const rows = useMemo(() => sort.sortRows(filtered, (row, col) => (row as Record<string, unknown>)[col]), [filtered, sort]);
  const open = (build: string, strategy: string) => onOpenBvs(build, strategy, race);
  const exportRows = () => {
    const exportedAt = new Date();
    const scope = `Build vs strategy · ${describeActiveFilters(filters, { seasons }).map(item => `${item.label}: ${item.value}`).join(" · ") || "Default filters"} · matrix matchup ${race ? `vs ${race}` : "All"} · search ${search.trim() || "(none)"} · min games ${minGames} · ${view === "heatmap" ? `axes ${axisOrder}` : `sort ${sort.sortBy} ${sort.sortDir}`}${cellsApi.error ? " · last loaded results (refresh failed)" : ""}`;
    const axes = matrixAxesForExport(filtered, axisOrder);
    const exportedRows = view === "heatmap" ? [...filtered].sort((a, b) => {
      return axes.builds.indexOf(a.my_build) - axes.builds.indexOf(b.my_build) || axes.strategies.indexOf(a.opp_strat) - axes.strategies.indexOf(b.opp_strat);
    }) : rows;
    downloadCsv(csvFilename("build-vs-strategy", exportedAt), toCsv({ columns: [...BVS_COLUMNS, { key: "matchup", label: "Matchup", format: () => race ? `vs ${race}` : "All" }], rows: exportedRows, scope, exportedAt }));
  };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <Input type="search" aria-label="Search builds or strategies" placeholder="Search builds or strategies" value={search} onChange={event => setSearch(event.target.value)} />
      {renderMinGamesPicker(minGames, onMinGamesChange)}
      <SegmentedControl label="Build versus strategy view" value={view} options={[{ value: "table", label: "Table" }, { value: "heatmap", label: "Heatmap" }]} onChange={onViewChange} />
      {!filters.opp_race && <SegmentedControl label="Matrix matchup" value={localRace} options={[{ value: "P", label: "vP", ariaLabel: "versus Protoss" }, { value: "T", label: "vT", ariaLabel: "versus Terran" }, { value: "Z", label: "vZ", ariaLabel: "versus Zerg" }, { value: "all", label: "All" }]} onChange={race => setChosenRace({ scope: scopeKey, race })} />}
      {view === "heatmap" ? <SegmentedControl label="Matrix axis order" value={axisOrder} options={[{ value: "games", label: "Most games" }, { value: "az", label: "A–Z" }]} onChange={setAxisOrder} /> : <><button type="button" className="min-h-11 rounded-lg border border-border px-3 text-caption" aria-pressed={sort.sortBy === "winsAboveExpected"} onClick={() => sort.setSortExplicit("winsAboveExpected", sort.sortBy === "winsAboveExpected" && sort.sortDir === "desc" ? "asc" : "desc")}>Vs expected</button><WinRateSortToggle dir={sort.sortBy === "winRate" ? sort.sortDir : "desc"} active={sort.sortBy === "winRate"} onChange={dir => sort.setSortExplicit("winRate", dir)} /></>}
      <Button variant="ghost" size="sm" aria-label="Export these rows as CSV" disabled={!filtered.length || !hasQueryData(cellsApi)} onClick={exportRows}><Download className="mr-1 h-4 w-4" />{filtered.length ? "Export CSV" : "Nothing to export"}</Button>
    </div>
    <p className="text-micro text-text-dim">{race ? `Showing vs ${race}. ` : "All matchups. "}Select a cell or row to view its games.</p>
    {cellsApi.error && cellsApi.data && <p role="alert" className="text-caption text-text-muted">Couldn’t refresh these results. Showing the last loaded rows for this matchup. <button type="button" className="min-h-11 text-accent underline" onClick={() => void cellsApi.mutate()}>Retry</button></p>}
    {!hasQueryData(cellsApi) ? <QueryState q={cellsApi} skeleton={<Skeleton rows={8} />} filtered /> : !filtered.length ? <Card><NoFilterMatches title="No build and strategy pairs match these filters" minGames={minGames} hiddenByMinGames={hiddenByMinGames} onLowerMinGames={() => onMinGamesChange(1)} extraAction={search.trim() ? <Button variant="secondary" onClick={() => setSearch("")}>Clear search</Button> : null} /></Card> : view === "heatmap" ? <StrategyMatrixHeatmap rows={filtered} order={axisOrder} minGames={minGames} onOpenBvs={open} /> : <BvsTable rows={rows} sort={sort} onOpenBvs={open} />}
  </div>;
}

/**
 * Response shape of GET ``/v1/strategies/:name/phases`` — the payload
 * the right column ("what they typically do") reads from. Declared
 * locally so this file stays self-contained.
 */
type StrategyPhasesResponse = {
  name: string;
  total: number;
  perspective: "you" | "opponent";
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

const COMPARISON_MIN_GAMES = 3;

/**
 * Strip the leading race-matchup prefix from a build label. The agent's
 * auto-classifier produces names like "PvZ - 3 Stargate Phoenix" — the
 * "PvZ - " segment encodes (your race)(v)(opp race) and shouldn't
 * participate in name comparisons against saved custom-build names,
 * which users typically author without that prefix. The character class
 * covers P/T/Z/R (case-insensitive); the separator may be a hyphen,
 * en-dash, em-dash or colon with arbitrary surrounding whitespace, or just
 * whitespace alone — users sometimes save builds as "PvZ Stargate"
 * without the dash.
 */
function stripMatchupPrefix(s: string): string {
  return s.replace(/^[PTZR]v[PTZR]\s*(?:[-–—:]\s*)?/i, "");
}

/**
 * Normalize a build name for slug-bridge comparison: strip the matchup
 * prefix, trim, lowercase, and collapse internal whitespace. The agent
 * label is generated mechanically while user-saved names are typed by
 * hand — equality should tolerate case + whitespace drift.
 */
function normalizeBuildName(s: string): string {
  return stripMatchupPrefix(s).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * BuildVsStrategyComparison — side-by-side phase trajectory + per-
 * phase composition for the drill-down view of "my build × their
 * strategy". Left column is the user's perspective on their saved
 * build; right column is the opponent's perspective on the
 * detected strategy. Each column reuses the same trajectory strip /
 * composition tabs the BuildDossier surface — agnostic by design,
 * only the perspective and aggregation key differ.
 *
 * Empty states are independent per column: a brand-new build with
 * no games still renders the right column if the opponent strategy
 * has enough samples. When the build doesn't map to a saved custom
 * build (e.g. the agent's auto-classifier label), the left column
 * surfaces the unmatched-build EmptyState rather than guessing a
 * slug.
 */
export function BuildVsStrategyComparison({
  build,
  strategy,
  oppRace,
}: {
  build: string;
  strategy: string;
  oppRace?: string;
}) {
  // Resolve build name → custom-build slug via the user's library.
  // The drill state only carries the display name (matches ``myBuild``
  // on the game record); custom-build endpoints key on slug, so we
  // bridge here. The agent's auto-classifier emits race-matchup-
  // prefixed labels ("PvZ - 3 Stargate Phoenix") whereas the user
  // typically saves the build without that prefix ("3 Stargate
  // Phoenix"), so we normalize both sides before comparing — otherwise
  // every drill from a build × strategy cell falls back to the empty
  // state even when the user has data on that build.
  const customBuilds = useApi<{ items: CustomBuild[] } | CustomBuild[]>(
    `/v1/custom-builds?${new URLSearchParams({ normalizedName: normalizeBuildName(build), view: "summary" })}`,
  );
  const slug = useMemo(() => {
    const list = Array.isArray(customBuilds.data)
      ? customBuilds.data
      : customBuilds.data?.items ?? [];
    const target = normalizeBuildName(build);
    const hit = list.find((b) => {
      const candidate = normalizeBuildName(b.name || b.slug || "");
      return candidate === target;
    });
    return hit?.slug || null;
  }, [customBuilds.data, build]);
  // While the custom-builds list is in flight, ``slug`` is null but the
  // user may well have a matching build — gate the empty state on the
  // fetch settling so we don't flash "No saved build for this label"
  // (or worse, leave it on a stale render) before the bridge resolves.
  const slugLoading = !customBuilds.data && !customBuilds.error;

  return (
    <Card title="Build vs strategy — phase comparison">
      <p className="mb-3 text-micro text-text-dim">
        Both sides describe the SAME games — the ones where you played
        this build and the opponent played this strategy. Left is your
        trajectory, right is theirs. Compare the crossings to see who
        gets to late game first — and with what.
      </p>
      <div
        className="grid grid-cols-1 gap-3 xl:grid-cols-2 xl:gap-4"
        data-testid="build-vs-strategy-comparison"
      >
        <ComparisonColumn
          title="What you typically do"
          subtitle={build}
          testId="bvs-column-you"
        >
          <YouColumn
            build={build}
            strategy={strategy}
            slug={slug}
            isResolvingSlug={slugLoading}
            oppRace={oppRace}
          />
        </ComparisonColumn>
        <ComparisonColumn
          title="What they typically do"
          subtitle={strategy}
          testId="bvs-column-opponent"
        >
          <OpponentColumn strategy={strategy} build={build} oppRace={oppRace} />
        </ComparisonColumn>
      </div>
    </Card>
  );
}

function ComparisonColumn({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    // ``min-w-0`` is what lets the grid track shrink below its intrinsic
    // content size. Without it the long ``subtitle`` (build / strategy
    // name with ``truncate``) forces this section wider than its grid
    // column at xl, and the whole panel overflows the page. Inner
    // padding is intentionally tighter than the parent Card's ``p-4``
    // so two columns of composition cards still fit comfortably at
    // common 1280–1440px desktop widths after the Card padding +
    // sidebar gutter eat their share.
    <section
      className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-surface p-3"
      data-testid={testId}
    >
      <header className="min-w-0">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
        <p className="truncate text-micro text-text-muted" title={subtitle}>
          {subtitle}
        </p>
      </header>
      {children}
    </section>
  );
}

function YouColumn({
  build,
  strategy,
  slug,
  isResolvingSlug,
  oppRace,
}: {
  build: string;
  strategy: string;
  slug: string | null;
  isResolvingSlug: boolean;
  oppRace?: string;
}) {
  // Left side has two data sources, picked in priority order:
  //
  // 1. Saved custom build (``/v1/custom-builds/:slug/compositions``)
  //    — when the user has explicitly saved a matching build, its
  //    rule-driven match set is the most authoritative answer.
  // 2. Agent-classified build label (``/v1/builds/:name/phases``) —
  //    the fallback for labels the agent auto-detected but the user
  //    never saved. Filters games by ``myBuild === build`` so the
  //    left column still renders against the 17W-7L set of games
  //    that powered the drill in the first place.
  //
  // Both endpoints return the same envelope shape so
  // ``ComparisonBody`` can render either without branching.
  //
  // The ``strategy`` axis is forwarded so the matched set is
  // additionally scoped to the cell the user clicked — without it,
  // the left column reports the build's marginal across every
  // opponent strategy (often orders of magnitude larger than the
  // cell), which is what made the side-by-side counts incomparable.
  //
  // The global filter bar (timeframe / race / map / mmr / region) is
  // also threaded through so the panel describes the SAME game set as
  // the "All games" list below — without it the column scanned the
  // latest 1000 games regardless of the active timeframe.
  const { filters } = useFilters();
  // Build the complete query in one pass. In particular, don't append
  // parameters to ``filtersToQuery(filters)``: when ``build`` is already
  // selected in StrategyFiltersBar that can create duplicate keys, which
  // Express parses as arrays and ``parseFilters`` correctly refuses as an
  // ambiguous string filter.
  const phaseQuery = filtersToQuery({
    ...strategyDrillFilters(filters, { build, opp_strategy: strategy, opp_race: oppRace }),
    perspective: "you",
    strategy: strategy || undefined,
  });
  const customPath = slug
    ? `/v1/custom-builds/${encodeURIComponent(slug)}/compositions${phaseQuery}`
    : null;
  const customResult = useApi<BuildPhasePayload>(customPath, { keepPreviousData: false });

  // Only fire the fallback once the slug bridge has settled and
  // resolved to "no saved build" — firing both in parallel would
  // double up Mongo scans for users who DO have a saved build.
  const labelPath =
    !slug && !isResolvingSlug && build
      ? `/v1/builds/${encodeURIComponent(build)}/phases${phaseQuery}`
      : null;
  const labelResult = useApi<BuildLabelPhasesResponse>(labelPath, { keepPreviousData: false });

  if (isResolvingSlug) return <Skeleton rows={3} />;

  if (slug) {
    if (customResult.isLoading && !customResult.data) {
      return <Skeleton rows={3} />;
    }
    if (customResult.error) {
      return (
        <EmptyState
          title="Couldn't load this build"
          sub="Phase compositions failed to load for the left column."
        />
      );
    }
    if (!customResult.data) return null;
    return <ComparisonBody payload={customResult.data} />;
  }

  // Auto-classified label fallback
  if (labelResult.isLoading && !labelResult.data) {
    return <Skeleton rows={3} />;
  }
  // 404 is the API's tell for "no games match" — surface the empty
  // state below rather than the generic load-failure copy.
  if (labelResult.error && labelResult.error.status !== 404) {
    return (
      <EmptyState
        title="Couldn't load this build"
        sub="Phase compositions failed to load for the left column."
      />
    );
  }
  if (!labelResult.data || labelResult.data.total < COMPARISON_MIN_GAMES) {
    const total = labelResult.data?.total ?? 0;
    return (
      <EmptyState
        title="Not enough samples"
        sub={
          total > 0
            ? `${total} game${total === 1 ? "" : "s"} so far · the comparison starts at ${COMPARISON_MIN_GAMES}.`
            : "Play a few games with this build to see what you typically do — or save it to your library to lock the signature."
        }
      />
    );
  }
  return <ComparisonBody payload={labelResult.data} />;
}

/**
 * Response shape of GET ``/v1/builds/:name/phases`` — the user-side
 * fallback the left column reads when no saved custom build matches
 * the agent's auto-classified label. Mirrors
 * ``StrategyPhasesResponse`` but keyed on ``myBuild`` rather than
 * ``opponent.strategy``.
 */
type BuildLabelPhasesResponse = {
  name: string;
  total: number;
  perspective: "you" | "opponent";
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

function OpponentColumn({
  strategy,
  build,
  oppRace,
}: {
  strategy: string;
  build: string;
  oppRace?: string;
}) {
  // ``build`` scopes the strategy aggregation to one cell of the
  // build × strategy matrix — same game set as the cell the user
  // clicked, so both columns render comparable sample sizes. The
  // global filter bar is threaded through so the matched set respects
  // the same timeframe / race / map / mmr / region scoping as the
  // "All games" list below.
  const { filters } = useFilters();
  const phaseQuery = filtersToQuery({
    ...strategyDrillFilters(filters, { build, opp_strategy: strategy, opp_race: oppRace }),
    perspective: "opponent",
    // The clicked matrix cell is authoritative. Object assignment replaces
    // an active global build filter instead of serialising a second copy.
    build: build || filters.build,
  });
  const path = strategy
    ? `/v1/strategies/${encodeURIComponent(strategy)}/phases${phaseQuery}`
    : null;
  const { data, isLoading, error } = useApi<StrategyPhasesResponse>(path, { keepPreviousData: false });

  if (!strategy) {
    return (
      <EmptyState
        title="Pick a strategy"
        sub="The right column needs an opponent strategy to compare against."
      />
    );
  }
  if (isLoading && !data) return <Skeleton rows={3} />;
  // 404 here means the strategy has no qualifying games — surface
  // the empty state and keep the left column rendering.
  if (error && error.status !== 404) {
    return (
      <EmptyState
        title="Couldn't load this strategy"
        sub="Phase compositions failed to load for the right column."
      />
    );
  }
  if (!data || data.total < COMPARISON_MIN_GAMES) {
    return (
      <EmptyState
        title="Not enough samples"
        sub={
          data && data.total > 0
            ? `${data.total} game${data.total === 1 ? "" : "s"} so far · the comparison starts at ${COMPARISON_MIN_GAMES}.`
            : "Play a few games against this strategy to see what they typically do."
        }
      />
    );
  }
  return <ComparisonBody payload={data} />;
}

function ComparisonBody({
  payload,
}: {
  payload: {
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
    flags?: string[];
  };
}) {
  // ``opp_signals_sparse`` is the API's tell that >50% of matched
  // games had no opp_stats_events — the trajectory would be noisy
  // and incomplete, so we surface the same EmptyState as the
  // all-zero sampleSize fallback would.
  if (payload.flags && payload.flags.includes("opp_signals_sparse")) {
    return (
      <EmptyState
        title="Opponent signal too sparse"
        sub="Most matched replays are missing the opponent's tracker events — drawing the trajectory here would be misleading."
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
        outcomeOnly
      />
      <PhaseCompositionTabs
        sampleSize={payload.sampleSize}
        perPhase={payload.perPhase}
        preferredPhase="mid"
        showTechRow={false}
      />
    </div>
  );
}

function BvsTable({
  rows,
  sort,
  onOpenBvs,
}: {
  rows: BvsCell[];
  sort: SortState;
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  return (
    <Card>
      <div className="mb-3"><StrengthGuide /></div>
      {/* Mobile (< md): stacked cards per row. The desktop table-fixed
          layout below keeps WR from being pushed off-screen on mid-width
          viewports, but on a phone the build / strategy columns still
          collapse to single letters; swap to a vertical card on small
          screens so both names render in full. */}
      <ul className="space-y-2 md:hidden">
        {rows.map((c, i) => (
          <li key={`${c.my_build}-${c.opp_strat}-${i}`}>
            <button
              type="button"
              onClick={() => onOpenBvs(c.my_build, c.opp_strat)}
              className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-bg-surface px-3 py-2 text-left transition hover:bg-bg-elevated/40"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-micro uppercase tracking-wider text-text-dim">
                  My build
                </span>
                <span className="text-sm font-semibold text-text">
                  {c.my_build}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-micro uppercase tracking-wider text-text-dim">
                  vs Opponent strategy
                </span>
                <span className="text-sm text-text-muted">
                  {c.opp_strat}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                <span className="text-success">{c.wins}W</span>
                <span className="text-danger">{c.losses}L</span>
                <span className="text-text-muted">{c.total} games</span>
                <span
                  className="font-semibold"
                  style={{ color: wrColor(c.winRate, c.total) }}
                >
                  {pct1(c.winRate)}
                </span>
              </div>
              <WinRateRange row={c} total={c.total} />
              <StrengthCell row={c} />
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        {/* ``table-fixed`` plus an explicit ``colgroup`` is what stops
            the four numeric columns from claiming an equal share of
            leftover space (each ~25 % of the row, with W / L right-
            aligned inside a 300 px-wide cell). With fixed widths,
            numerics pack into their content size and the two text
            columns absorb the rest. */}
        <table className="w-full min-w-[42rem] table-fixed text-sm">
          <colgroup>
            <col />
            <col />
            <col style={{ width: "3.5rem" }} />
            <col style={{ width: "3.5rem" }} />
            <col style={{ width: "4.5rem" }} />
            <col style={{ width: "4.5rem" }} />
            <col style={{ width: "8rem" }} />
          </colgroup>
          <thead className="bg-bg-elevated">
            <tr>
              {BVS_COLUMNS.map((column, index) => column.strength ? <StrengthHeader key={String(column.key)} sort={sort} /> : <SortableTh key={String(column.key)} col={String(column.key)} label={column.label} {...sort} align={index < 2 ? "left" : "right"} />)}
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={`${c.my_build}-${c.opp_strat}-${i}`}
                onClick={() => onOpenBvs(c.my_build, c.opp_strat)}
                className="cursor-pointer border-t border-border hover:bg-bg-elevated/40"
                title="Click to see the games"
              >
                <td className="truncate px-3 py-1.5" title={c.my_build}>
                  <button type="button" className="min-h-11 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={event => { event.stopPropagation(); onOpenBvs(c.my_build, c.opp_strat); }}>{c.my_build}</button>
                </td>
                <td
                  className="truncate px-3 py-1.5 text-text-muted"
                  title={c.opp_strat}
                >
                  {c.opp_strat}
                </td>
                <td className="px-2 py-1.5 text-right text-success">{c.wins}</td>
                <td className="px-2 py-1.5 text-right text-danger">{c.losses}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.total}</td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  style={{ color: wrColor(c.winRate, c.total) }}
                >
                  {pct1(c.winRate)}
                  <WinRateRange row={c} total={c.total} />
                </td>
                <td className="px-2 py-1.5 text-right"><StrengthCell row={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
