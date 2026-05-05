"use client";

import { useEffect, useMemo, useState } from "react";
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

type BvsCell = {
  my_build: string;
  opp_strat: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

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

function BuildVsStrategyView({
  onOpenBvs,
}: {
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"heatmap" | "table">(() =>
    readLs(LS_BVS_VW, "heatmap" as "heatmap" | "table"),
  );
  const [minGames, setMinGames] = useState<number>(() => readLs(LS_MIN, 3));
  const sort = useSort("total", "desc");
  useEffect(() => writeLs(LS_BVS_VW, view), [view]);
  useEffect(() => writeLs(LS_MIN, minGames), [minGames]);

  const { data, isLoading } = useApi<BvsCell[]>(
    `/v1/build-vs-strategy${filtersToQuery(filters)}#${dbRev}`,
  );

  const filtered = useMemo(() => {
    let r = data || [];
    const s = search.trim().toLowerCase();
    if (s) {
      r = r.filter(
        (x) =>
          (x.my_build || "").toLowerCase().includes(s) ||
          (x.opp_strat || "").toLowerCase().includes(s),
      );
    }
    if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
    return r;
  }, [data, search, minGames]);

  const rows = useMemo(
    () =>
      sort.sortRows(filtered, (row, col) => (row as Record<string, unknown>)[col]),
    [filtered, sort],
  );

  if (isLoading) return <Skeleton rows={8} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="search build or strategy…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <div className="inline-flex overflow-hidden rounded border border-border">
          {(["heatmap", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs capitalize transition ${
                view === v
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-text-dim">
        Click any cell or row to see the games for that build × strategy combo.
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState title="Not enough samples" />
        </Card>
      ) : view === "heatmap" ? (
        <BvsHeatmap rows={filtered} onOpenBvs={onOpenBvs} />
      ) : (
        <BvsTable rows={rows} sort={sort} onOpenBvs={onOpenBvs} />
      )}
    </div>
  );
}

function BvsHeatmap({
  rows,
  onOpenBvs,
}: {
  rows: BvsCell[];
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  const builds = useMemo(
    () => Array.from(new Set(rows.map((r) => r.my_build))).sort(),
    [rows],
  );
  const strategies = useMemo(
    () => Array.from(new Set(rows.map((r) => r.opp_strat))).sort(),
    [rows],
  );
  const lookup = useMemo(() => {
    const m = new Map<string, BvsCell>();
    for (const r of rows) m.set(`${r.my_build}|${r.opp_strat}`, r);
    return m;
  }, [rows]);
  const maxGames = Math.max(...rows.map((r) => r.total || 0), 1);

  if (builds.length === 0 || strategies.length === 0) {
    return (
      <Card>
        <EmptyState title="Not enough samples" />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-bg-surface px-2 py-1 text-left text-text-dim">
                My build ↓ / vs →
              </th>
              {strategies.map((s) => (
                <th
                  key={s}
                  className="px-1 py-1 align-bottom text-text-muted"
                  style={{ minWidth: "5.5rem", maxWidth: "8rem" }}
                >
                  <div className="truncate" title={s}>
                    {s}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b}>
                <td
                  className="sticky left-0 truncate bg-bg-surface px-2 py-1 text-text"
                  style={{ maxWidth: "12rem" }}
                  title={b}
                >
                  {b}
                </td>
                {strategies.map((s) => {
                  const c = lookup.get(`${b}|${s}`);
                  if (!c) {
                    return (
                      <td key={s} className="px-0.5 py-0.5">
                        <div className="h-9 rounded bg-bg-elevated/40" />
                      </td>
                    );
                  }
                  const intensity = 0.35 + 0.65 * (c.total / maxGames);
                  return (
                    <td key={s} className="px-0.5 py-0.5">
                      <button
                        type="button"
                        onClick={() => onOpenBvs(b, s)}
                        className="flex h-9 w-full cursor-pointer items-center justify-center rounded text-[11px] font-semibold tabular-nums ring-1 ring-inset ring-black/30 transition hover:ring-2 hover:ring-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        style={{
                          background: wrColor(c.winRate, c.total),
                          opacity: intensity,
                          color: "#0c0c0c",
                        }}
                        title={`${b} vs ${s}\n${c.wins}W - ${c.losses}L · ${c.total} games · ${pct1(c.winRate)}\nClick to see the games.`}
                      >
                        {pct1(c.winRate).replace(".0", "")}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-text-dim">
          Cell color = win rate. Cell opacity = sample size. Click a cell to see the games.
        </div>
      </div>
    </Card>
  );
}

function BvsTable({
  rows,
  sort,
  onOpenBvs,
}: {
  rows: BvsCell[];
  sort: ReturnType<typeof useSort>;
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  return (
    <Card>
      <table className="w-full text-sm">
        <thead className="bg-bg-elevated">
          <tr>
            <SortableTh col="my_build" label="My build" {...sort} />
            <SortableTh col="opp_strat" label="vs Opponent strategy" {...sort} />
            <SortableTh col="wins" label="W" {...sort} align="right" />
            <SortableTh col="losses" label="L" {...sort} align="right" />
            <SortableTh col="total" label="Games" {...sort} align="right" />
            <SortableTh col="winRate" label="WR" {...sort} align="right" />
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
              <td className="px-3 py-1.5">{c.my_build}</td>
              <td className="px-3 py-1.5 text-text-muted">{c.opp_strat}</td>
              <td className="px-3 py-1.5 text-right text-success">{c.wins}</td>
              <td className="px-3 py-1.5 text-right text-danger">{c.losses}</td>
              <td className="px-3 py-1.5 text-right">{c.total}</td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                style={{ color: wrColor(c.winRate, c.total) }}
              >
                {pct1(c.winRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
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

export function StrategiesTab() {
  const { filters } = useFilters();
  const [view, setView] = useState<"opp" | "bvs">(() =>
    readLs(LS_VIEW, "opp" as "opp" | "bvs"),
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
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">
          {view === "opp"
            ? "Win rate vs opponent strategies"
            : "My build × Their strategy"}
        </h2>
        <div className="inline-flex overflow-hidden rounded border border-border">
          {(["opp", "bvs"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs ${
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
        />
      )}
    </div>
  );
}

// Re-export so other tabs can pull the bar (e.g. opponent profile).
export { WrBar };
