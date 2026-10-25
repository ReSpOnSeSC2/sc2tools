"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import {
  useFilters,
  filtersToQuery,
} from "@/lib/filterContext";
import {
  useLocalStoragePositiveInt,
  useLocalStorageState,
} from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton, WrBar } from "@/components/ui/Card";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { usePersistentSort } from "@/components/ui/SortableTh";
import { StrengthCell, StrengthGuide, WinRateRange } from "./StrengthAdjusted";
import type { StrengthFields } from "@/lib/strengthAdjusted";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { WinRateSortToggle } from "@/components/ui/WinRateSortToggle";
import { NoFilterMatches } from "./EmptyStates";
import { StrategyMmrPanel } from "./mmr/StrategyMmrPanel";
import { BuildMatchupHeatmap } from "./mmr/BuildMatchupHeatmap";
import { StatCard } from "@/components/ui/Stat";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StrategyGamesSheet } from "./StrategyGamesSheet";
import type { StrategyDrillFilter } from "@/lib/strategyDrill";

type StratRow = StrengthFields & {
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

import { BuildVsStrategyView } from "./StrategiesTabBuildVs";

const RACE_OPTIONS = [
  { value: "", label: "Any race" },
  { value: "P", label: "Protoss" },
  { value: "T", label: "Terran" },
  { value: "Z", label: "Zerg" },
  { value: "R", label: "Random" },
] as const;

export { strategyGamesPath } from "@/lib/strategyDrill";
export type { StrategyDrillFilter } from "@/lib/strategyDrill";

const LS_VIEW = "analyzer.strategies.view";
const LS_MIN = "analyzer.strategies.minGames";
const LS_BVS_VW = "analyzer.strategies.bvs.view";
const LS_OPP_SORT = "analyzer.strategies.opp.sort";

export type StratView = "opp" | "bvs";
type BvsView = "heatmap" | "table";

function isStratView(raw: unknown): raw is StratView {
  return raw === "opp" || raw === "bvs";
}
function isBvsView(raw: unknown): raw is BvsView {
  return raw === "heatmap" || raw === "table";
}

type Kpi = { label: string; value: string | null; sub?: string | null };

function KpiStrip({ items }: { items: Kpi[] }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{items.map(item => <StatCard key={item.label} label={item.label} value={item.value || "—"} hint={item.sub} size="sm" className="min-w-0 break-words" />)}</div>;
}

function bestWorst<T extends { winRate: number; total: number }>(
  rows: T[],
  minGames: number,
): { best: T | null; worst: T | null } {
  const eligible = (rows || []).filter((r) => (r.total || 0) >= minGames);
  if (eligible.length === 0) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => b.winRate - a.winRate);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

function ByOppStrategyView({
  onOpenStrategy,
}: {
  onOpenStrategy: (strategy: string) => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN, 3);
  const sort = usePersistentSort(LS_OPP_SORT, "winRate", "desc");

  const strategiesApi = useApi<StratRow[]>(
    `/v1/opp-strategies${filtersToQuery(filters)}#${dbRev}`,
  );
  const { data } = strategiesApi;

  const { rows, hiddenByMinGames } = useMemo(() => {
    let r = data || [];
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((x) => (x.name || "").toLowerCase().includes(s));
    const searched = r.length;
    if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
    return {
      rows: sort.sortRows(r, (row, col) => (row as Record<string, unknown>)[col]),
      hiddenByMinGames: searched - r.length,
    };
  }, [data, search, minGames, sort]);

  const kpis = useMemo<Kpi[]>(() => {
    const all = data || [];
    const totalGames = all.reduce((a, x) => a + (x.total || 0), 0);
    const totalWins = all.reduce((a, x) => a + (x.wins || 0), 0);
    const wr = totalGames ? totalWins / totalGames : 0;
    const mostPlayed = [...all].sort((a, b) => b.total - a.total)[0] || null;
    const { best, worst } = bestWorst(all, minGames);
    return [
      {
        label: "Strategies tracked",
        value: String(all.length),
        sub: `${totalGames} games · ${pct1(wr)} overall`,
      },
      {
        label: "Most played",
        value: mostPlayed ? mostPlayed.name : null,
        sub: mostPlayed
          ? `${mostPlayed.total} games · ${pct1(mostPlayed.winRate)}`
          : null,
      },
      {
        label: `Best vs (≥${minGames})`,
        value: best ? best.name : null,
        sub: best ? `${pct1(best.winRate)} · ${best.total} games` : "Not enough data",
      },
      {
        label: `Worst vs (≥${minGames})`,
        value: worst ? worst.name : null,
        sub: worst
          ? `${pct1(worst.winRate)} · ${worst.total} games`
          : "Not enough data",
      },
    ];
  }, [data, minGames]);

  if (!hasQueryData(strategiesApi)) {
    return <QueryState q={strategiesApi} skeleton={<Skeleton rows={6} />} filtered />;
  }

  return (
    <div className="space-y-4">
      <KpiStrip items={kpis} />
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none"
          placeholder="Search strategies"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <button type="button" className="min-h-11 rounded-lg border border-border px-3 text-caption" aria-pressed={sort.sortBy === "winsAboveExpected"} onClick={() => sort.setSortExplicit("winsAboveExpected", sort.sortBy === "winsAboveExpected" && sort.sortDir === "desc" ? "asc" : "desc")}>Vs expected {sort.sortBy === "winsAboveExpected" ? sort.sortDir === "desc" ? "↓" : "↑" : ""}</button>
        <WinRateSortToggle
          dir={sort.sortBy === "winRate" ? sort.sortDir : "desc"}
          active={sort.sortBy === "winRate"}
          onChange={(dir) => sort.setSortExplicit("winRate", dir)}
        />
      </div>
      <div className="text-micro text-text-dim">
        Click any card to see the games where you faced that strategy.
      </div>
      <StrengthGuide />

      {rows.length === 0 ? (
        <Card>
          <NoFilterMatches
            title="No strategies match these filters"
            minGames={minGames}
            hiddenByMinGames={hiddenByMinGames}
            onLowerMinGames={() => setMinGames(1)}
            extraAction={
              search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onOpenStrategy(s.name)}
              // ``min-w-0`` is required so the inner ``truncate``
              // strategy name doesn't push the button wider than its
              // grid column, which would otherwise overflow the page
              // when a streamer has long strategy labels.
              className="group min-w-0 rounded-lg border border-border bg-bg-surface p-4 text-left transition hover:border-accent/40 hover:bg-bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <div
                className="truncate text-sm font-medium text-text"
                title={s.name}
              >
                {s.name}
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <span
                  className="text-2xl font-semibold tabular-nums"
                  style={{ color: wrColor(s.winRate, s.total) }}
                >
                  {pct1(s.winRate)}
                </span>
                <span className="text-xs tabular-nums text-text-dim">
                  {s.wins}W - {s.losses}L
                </span>
              </div>
              <WrBar wins={s.wins} losses={s.losses} />
              <WinRateRange row={s} total={s.total} />
              <div className="mt-2"><StrengthCell row={s} /></div>
              <div className="mt-2 flex items-center justify-between text-micro tabular-nums text-text-dim">
                <span>{s.total} games</span>
                <span className="text-text-dim transition group-hover:text-text group-focus-visible:text-text">
                  View games
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------- */
/* Tab shell                                                            */
/* -------------------------------------------------------------------- */

/**
 * Filter bar specific to the Strategies tab — exposes the four
 * dimensions the user typically asks about when looking at strategy
 * data: my race, my build, opponent race, opponent strategy.
 *
 * The values write through to the global filter context so the
 * `Build vs strategy`, `By opponent strategy`, and drill-down views
 * all read from the same source of truth. They also propagate to
 * other tabs once set — that's intentional: a user who narrows to
 * "PvP — DT vs Stargate" wants their Trends, Maps, and Activity tabs
 * to reflect the same scope. The Active filters chip row under the
 * global filter bar shows each one (build and strategy marked "set in
 * Strategies") and is where they are cleared; the races are the same
 * values the bar's Matchup picker edits.
 */
export function StrategyFiltersBar() {
  const { filters, setFilters, dbRev } = useFilters();
  // Pull the universe of builds + opponent strategies the user has
  // games for, so the dropdowns only show options that will actually
  // produce results. Build options retain their existing independent
  // universe, while opponent-strategy options are scoped to the selected
  // opponent race. Strategy names are not a reliable source of race
  // metadata (especially for custom labels), so this must be filtered by
  // the API's canonical opponent.race field.
  const baseQuery = useMemo(() => {
    const { build, opp_strategy, race, opp_race, ...rest } = filters;
    return filtersToQuery(rest);
  }, [filters]);
  const strategyOptionsQuery = useMemo(() => {
    const { build, opp_strategy, race, ...rest } = filters;
    return filtersToQuery(rest);
  }, [filters]);
  const buildsResp = useApi<Array<{ name: string; total: number }>>(
    `/v1/builds${baseQuery}#${dbRev}`,
  );
  const stratsResp = useApi<Array<{ name: string; total: number }>>(
    `/v1/opp-strategies${strategyOptionsQuery}#${dbRev}`,
  );

  const buildOptions = useMemo(
    () => sortedDistinct(buildsResp.data),
    [buildsResp.data],
  );
  const stratOptions = useMemo(
    () => sortedDistinct(stratsResp.data),
    [stratsResp.data],
  );

  const update = (patch: Partial<typeof filters>) => {
    /** @type {any} */
    const next = { ...filters, ...patch };
    for (const k of ["race", "opp_race", "build", "opp_strategy"] as const) {
      if (next[k] === "" || next[k] == null) delete next[k];
    }
    setFilters(next);
  };

  return (
    <div className="rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          label="My race"
          value={filters.race ?? ""}
          onChange={(v) => update({ race: v || undefined })}
          options={RACE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
        />
        <FilterSelect
          label="My build"
          value={filters.build ?? ""}
          onChange={(v) => update({ build: v || undefined })}
          options={[
            { value: "", label: "Any build" },
            ...buildOptions.map((o) => ({
              value: o.name,
              label: `${truncateLabel(o.name, 36)} (${o.total})`,
            })),
          ]}
          disabled={buildsResp.isLoading}
        />
        <FilterSelect
          label="Opp race"
          value={filters.opp_race ?? ""}
          onChange={(v) =>
            update({
              opp_race: v || undefined,
              // A strategy selected for the previous race would leave an
              // impossible hidden intersection after the option list
              // refetches. Clear both fields in one context update.
              opp_strategy: undefined,
            })
          }
          options={RACE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
        />
        <FilterSelect
          label="Opp strategy"
          value={filters.opp_strategy ?? ""}
          onChange={(v) => update({ opp_strategy: v || undefined })}
          options={[
            { value: "", label: "Any strategy" },
            ...stratOptions.map((o) => ({
              value: o.name,
              label: `${truncateLabel(o.name, 36)} (${o.total})`,
            })),
          ]}
          disabled={stratsResp.isLoading}
        />
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="min-h-[44px] w-full rounded-lg border-2 border-line bg-bg-surface px-2.5 text-sm text-text transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value || "_any"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function sortedDistinct(
  rows: Array<{ name: string; total: number }> | undefined,
): Array<{ name: string; total: number }> {
  if (!rows) return [];
  return [...rows]
    .filter((r) => r && typeof r.name === "string" && r.name.length > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0));
}

function truncateLabel(s: string, n = 28): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function StrategiesTab({ drill: controlledDrill, onDrillChange, view: controlledView, onViewChange }: { drill?: StrategyDrillFilter | null; onDrillChange?: (drill: StrategyDrillFilter | null) => void; view?: StratView; onViewChange?: (view: StratView) => void } = {}) {
  // Default to "bvs" — Build vs strategy carries more actionable
  // information (your build paired with what they did) than the flat
  // by-opponent-strategy summary. Existing saved preferences win.
  const [localView, setLocalView] = useLocalStorageState<StratView>(
    LS_VIEW,
    "bvs",
    isStratView,
  );
  const view = controlledView ?? localView;
  const setView = (next: StratView) => { setLocalView(next); onViewChange?.(next); };
  const [bvsView, setBvsView] = useLocalStorageState<BvsView>(
    LS_BVS_VW,
    "table",
    isBvsView,
  );
  const [bvsMinGames, setBvsMinGames] = useLocalStoragePositiveInt(LS_MIN, 3);
  const [localDrill, setLocalDrill] = useState<StrategyDrillFilter | null>(null);
  const drill = controlledDrill === undefined ? localDrill : controlledDrill;
  const setDrill = (next: StrategyDrillFilter | null) => { if (controlledDrill === undefined) setLocalDrill(next); onDrillChange?.(next); };

  return (
    <div className="space-y-4">
      <StrategyFiltersBar />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold text-text">
          {view === "opp"
            ? "Win rate vs opponent strategies"
            : "My build × Their strategy"}
        </h2>
        <SegmentedControl label="Strategy view" value={view} options={[{ value: "bvs", label: "Build vs strategy" }, { value: "opp", label: "By opponent strategy" }]} onChange={setView} />
      </div>
      {view === "opp" ? (
        <ByOppStrategyView
          onOpenStrategy={(name) => setDrill({ opp_strategy: name })}
        />
      ) : (
        <BuildVsStrategyView
          onOpenBvs={(my_build, opp_strat, opp_race) =>
            setDrill({ build: my_build, opp_strategy: opp_strat, opp_race })
          }
          initialView={bvsView}
          initialMinGames={bvsMinGames}
          onViewChange={setBvsView}
          onMinGamesChange={setBvsMinGames}
          renderMinGamesPicker={(value, onChange) => (
            <MinGamesPicker value={value} onChange={onChange} />
          )}
        />
      )}
      <StrategyMmrPanel />
      <BuildMatchupHeatmap />
      {drill && <StrategyGamesSheet drill={drill} onBack={() => setDrill(null)} />}
    </div>
  );
}

// Re-export so other tabs can pull the bar (e.g. opponent profile).
export { WrBar };
