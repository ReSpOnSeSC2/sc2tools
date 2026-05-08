"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { AllGamesTable } from "./AllGamesTable";
import type { ProfileGame } from "./Last5GamesTimeline";

type StratRow = {
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

type GamesListResp = {
  ok: boolean;
  total: number;
  games: Array<{
    id?: string;
    date?: string;
    map?: string;
    opponent?: string;
    opp_race?: string;
    opp_strategy?: string | null;
    result?: string;
    build?: string;
    game_length?: number;
    macro_score?: number | null;
  }>;
};

type DrillFilter = { opp_strategy: string; build?: string };

const LS_VIEW = "analyzer.strategies.view";
const LS_MIN = "analyzer.strategies.minGames";
const LS_BVS_VW = "analyzer.strategies.bvs.view";
const MIN_STEPS = [1, 3, 5, 10, 20];

function readLs<T>(key: string, fb: T): T {
  if (typeof window === "undefined") return fb;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fb : (JSON.parse(v) as T);
  } catch {
    return fb;
  }
}

function writeLs(key: string, v: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* non-fatal */
  }
}

function MinGamesPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-text-dim">
        Min games
      </span>
      <div className="inline-flex overflow-hidden rounded border border-border">
        {MIN_STEPS.map((n) => (
          <button
            key={n}
            onClick={() => onChange(n)}
            className={`px-2 py-1 text-xs tabular-nums transition ${
              value === n
                ? "bg-accent/20 text-accent"
                : "text-text-muted hover:bg-bg-elevated"
            }`}
            title={`Hide rows with fewer than ${n} games`}
            type="button"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

type Kpi = { label: string; value: string | null; sub?: string | null };

function KpiStrip({ items }: { items: Kpi[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((k, i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-bg-surface p-3"
        >
          <div className="truncate text-[10px] uppercase tracking-wider text-text-dim">
            {k.label}
          </div>
          <div
            className="mt-1 truncate text-sm font-medium text-text"
            title={k.value || "—"}
          >
            {k.value || "—"}
          </div>
          {k.sub ? (
            <div className="mt-0.5 text-[11px] tabular-nums text-text-dim">
              {k.sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
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
  const [minGames, setMinGames] = useState<number>(() => readLs(LS_MIN, 3));
  const sort = useSort("winRate", "desc");
  useEffect(() => writeLs(LS_MIN, minGames), [minGames]);

  const { data, isLoading } = useApi<StratRow[]>(
    `/v1/opp-strategies${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    let r = data || [];
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((x) => (x.name || "").toLowerCase().includes(s));
    if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
    return sort.sortRows(r, (row, col) => (row as Record<string, unknown>)[col]);
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

  if (isLoading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-4">
      <KpiStrip items={kpis} />
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="search strategy name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
      </div>
      <div className="text-[11px] text-text-dim">
        Click any card to see the games where you faced that strategy.
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No strategies match"
            sub={
              (data || []).length > 0
                ? `No strategies match your filter (search / min games ${minGames}).`
                : undefined
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
              className="group rounded-lg border border-border bg-bg-surface p-4 text-left transition hover:border-accent/40 hover:bg-bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
              <div className="mt-2 flex items-center justify-between text-[11px] tabular-nums text-text-dim">
                <span>{s.total} games</span>
                <span className="opacity-0 transition group-hover:opacity-100">
                  view games →
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
/* Drill-down: games list view                                          */
/* -------------------------------------------------------------------- */

function StrategyGamesView({
  drill,
  onBack,
}: {
  drill: DrillFilter;
  onBack: () => void;
}) {
  const { filters, dbRev } = useFilters();
  const queryStr = useMemo(() => {
    const merged: Record<string, unknown> = {
      ...filters,
      opp_strategy: drill.opp_strategy,
      sort: "date_desc",
      limit: 5000,
    };
    if (drill.build) merged.build = drill.build;
    return filtersToQuery(merged);
  }, [filters, drill]);

  const { data, isLoading, error } = useApi<GamesListResp>(
    `/v1/games-list${queryStr}#${dbRev}`,
  );

  const games = useMemo<ProfileGame[]>(() => {
    const raw = data?.games || [];
    // Defensive client-side filter so a server that ignored an unknown
    // query param can't leak unrelated games into the drill-down.
    const filteredRaw = raw.filter((g) => {
      if ((g.opp_strategy || "Unknown") !== drill.opp_strategy) return false;
      if (drill.build && g.build !== drill.build) return false;
      return true;
    });
    // Forward opp_race / macro_score through. AllGamesTable widens
    // ProfileGame to GameRowData expecting these — without them, the
    // Race column falls back to "?" for every row even when the
    // strategy name explicitly says "Terran - …" or "Zerg - …".
    return filteredRaw.map((g) => ({
      id: g.id || null,
      date: g.date || null,
      result: g.result || null,
      map: g.map || null,
      opp_strategy: g.opp_strategy || null,
      opp_race: g.opp_race || null,
      my_build: g.build || null,
      game_length: g.game_length ?? null,
      macro_score: g.macro_score ?? null,
    }));
  }, [data, drill]);

  const titleText = useMemo(() => {
    if (drill.build) return `${drill.build}  vs  ${drill.opp_strategy}`;
    return `vs ${drill.opp_strategy}`;
  }, [drill]);

  const summary = useMemo(() => {
    const total = games.length;
    let wins = 0;
    let losses = 0;
    for (const g of games) {
      const r = String(g.result || "").toLowerCase();
      if (r === "win" || r === "victory") wins++;
      else if (r === "loss" || r === "defeat") losses++;
    }
    const wr = total ? wins / total : 0;
    return { total, wins, losses, wr };
  }, [games]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-xs uppercase tracking-wider text-text-muted hover:text-text"
        >
          ← back to strategies
        </button>
        <h2 className="truncate text-base font-semibold text-text">
          {titleText}
        </h2>
        {!isLoading && summary.total > 0 ? (
          <div className="ml-auto text-xs tabular-nums text-text-dim">
            <span className="text-text-muted">{summary.total}</span> games ·{" "}
            <span className="text-success">{summary.wins}W</span> -{" "}
            <span className="text-danger">{summary.losses}L</span> ·{" "}
            <span style={{ color: wrColor(summary.wr, summary.total) }}>
              {pct1(summary.wr)}
            </span>
          </div>
        ) : null}
      </div>
      {isLoading ? (
        <Skeleton rows={6} />
      ) : error ? (
        <Card>
          <EmptyState title="Couldn't load games" sub={error.message} />
        </Card>
      ) : games.length === 0 ? (
        <Card>
          <EmptyState sub="No games match this filter combination." />
        </Card>
      ) : (
        <Card title={`All games (${games.length}) · newest first`}>
          <div className="-mx-2 max-h-[640px] overflow-x-auto">
            <AllGamesTable games={games} />
          </div>
        </Card>
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
 * to reflect the same scope.
 */
function StrategyFiltersBar() {
  const { filters, setFilters, dbRev } = useFilters();
  // Pull the universe of builds + opponent strategies the user has
  // games for, so the dropdowns only show options that will actually
  // produce results. We pull these without the build/strategy/race
  // filters applied so toggling one doesn't empty the other.
  const baseQuery = useMemo(() => {
    const { build, opp_strategy, race, opp_race, ...rest } = filters;
    return filtersToQuery(rest);
  }, [filters]);
  const buildsResp = useApi<Array<{ name: string; total: number }>>(
    `/v1/builds${baseQuery}#${dbRev}`,
  );
  const stratsResp = useApi<Array<{ name: string; total: number }>>(
    `/v1/opp-strategies${baseQuery}#${dbRev}`,
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

  const clearAll = () => {
    const { build, opp_strategy, race, opp_race, ...rest } = filters;
    setFilters(rest);
  };

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.race) {
    activeChips.push({
      key: "race",
      label: `My race · ${labelFromCode(filters.race)}`,
      clear: () => update({ race: undefined }),
    });
  }
  if (filters.build) {
    activeChips.push({
      key: "build",
      label: `My build · ${truncateLabel(filters.build)}`,
      clear: () => update({ build: undefined }),
    });
  }
  if (filters.opp_race) {
    activeChips.push({
      key: "opp_race",
      label: `Opp race · ${labelFromCode(filters.opp_race)}`,
      clear: () => update({ opp_race: undefined }),
    });
  }
  if (filters.opp_strategy) {
    activeChips.push({
      key: "opp_strategy",
      label: `Opp strategy · ${truncateLabel(filters.opp_strategy)}`,
      clear: () => update({ opp_strategy: undefined }),
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-surface p-3">
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
          onChange={(v) => update({ opp_race: v || undefined })}
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
      {activeChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            Active
          </span>
          {activeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.clear}
              title="Clear this filter"
              className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-3 text-xs text-accent transition hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span>{c.label}</span>
              <X className="h-3 w-3" aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto min-h-[32px] rounded px-2 text-[11px] uppercase tracking-wider text-text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear all
          </button>
        </div>
      ) : null}
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
      <span className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="min-h-[44px] w-full rounded-md border border-border bg-bg-elevated px-2.5 text-sm text-text transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
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

function labelFromCode(code: string): string {
  switch (String(code).toUpperCase()[0]) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return code;
  }
}

function truncateLabel(s: string, n = 28): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function StrategiesTab() {
  const { filters } = useFilters();
  // Default to "bvs" — Build vs strategy carries more actionable
  // information (your build paired with what they did) than the flat
  // by-opponent-strategy summary. Existing saved preferences win.
  const [view, setView] = useState<"opp" | "bvs">(() =>
    readLs(LS_VIEW, "bvs" as "opp" | "bvs"),
  );
  const [drill, setDrill] = useState<DrillFilter | null>(null);
  useEffect(() => writeLs(LS_VIEW, view), [view]);

  // Close the drill-down if global filters change so the user isn't
  // staring at stale rows.
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    setDrill(null);
  }, [filtersKey]);

  if (drill) {
    return <StrategyGamesView drill={drill} onBack={() => setDrill(null)} />;
  }

  return (
    <div className="space-y-4">
      <StrategyFiltersBar />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold text-text">
          {view === "opp"
            ? "Win rate vs opponent strategies"
            : "My build × Their strategy"}
        </h2>
        <div className="inline-flex self-start overflow-hidden rounded border border-border sm:self-auto">
          {(["bvs", "opp"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`min-h-[36px] px-3 py-1 text-xs ${
                view === v
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated"
              }`}
            >
              {v === "opp" ? "By opponent strategy" : "Build vs strategy"}
            </button>
          ))}
        </div>
      </div>
      {view === "opp" ? (
        <ByOppStrategyView
          onOpenStrategy={(name) => setDrill({ opp_strategy: name })}
        />
      ) : (
        <BuildVsStrategyView
          onOpenBvs={(my_build, opp_strat) =>
            setDrill({ build: my_build, opp_strategy: opp_strat })
          }
          initialView={readLs(LS_BVS_VW, "table" as "heatmap" | "table")}
          initialMinGames={readLs(LS_MIN, 3)}
          onViewChange={(v) => writeLs(LS_BVS_VW, v)}
          onMinGamesChange={(n) => writeLs(LS_MIN, n)}
          renderMinGamesPicker={(value, onChange) => (
            <MinGamesPicker value={value} onChange={onChange} />
          )}
        />
      )}
    </div>
  );
}

// Re-export so other tabs can pull the bar (e.g. opponent profile).
export { WrBar };
