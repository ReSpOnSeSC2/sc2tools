"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

type StratRow = {
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type BvsCell = {
  build: string;
  strategy: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

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
            type="button"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function ByOppStrategyView() {
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
    return sort.sortRows(r, (row, col) => (row as any)[col]);
  }, [data, search, minGames, sort]);

  if (isLoading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="search strategy…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No strategies match" />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <SortableTh col="name" label="Strategy" {...sort} />
                <SortableTh col="wins" label="W" {...sort} align="right" />
                <SortableTh col="losses" label="L" {...sort} align="right" />
                <SortableTh col="total" label="Games" {...sort} align="right" />
                <SortableTh col="winRate" label="WR" {...sort} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name} className="border-t border-border">
                  <td className="px-3 py-1.5 text-text">{s.name}</td>
                  <td className="px-3 py-1.5 text-right text-success">
                    {s.wins}
                  </td>
                  <td className="px-3 py-1.5 text-right text-danger">
                    {s.losses}
                  </td>
                  <td className="px-3 py-1.5 text-right text-text-muted">
                    {s.total}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: wrColor(s.winRate, s.total) }}
                  >
                    {pct1(s.winRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function BuildVsStrategyView() {
  const { filters, dbRev } = useFilters();
  const [view, setView] = useState<"heatmap" | "table">(() =>
    readLs(LS_BVS_VW, "heatmap" as "heatmap" | "table"),
  );
  const [minGames, setMinGames] = useState<number>(() => readLs(LS_MIN, 3));
  useEffect(() => writeLs(LS_BVS_VW, view), [view]);

  const { data, isLoading } = useApi<BvsCell[]>(
    `/v1/build-vs-strategy${filtersToQuery(filters)}#${dbRev}`,
  );
  const cells = (data || []).filter((c) => (c.total || 0) >= minGames);

  const builds = useMemo(
    () => Array.from(new Set(cells.map((c) => c.build))).sort(),
    [cells],
  );
  const strategies = useMemo(
    () => Array.from(new Set(cells.map((c) => c.strategy))).sort(),
    [cells],
  );
  const grid = useMemo(() => {
    const g: Record<string, Record<string, BvsCell>> = {};
    for (const c of cells) {
      g[c.build] = g[c.build] || {};
      g[c.build][c.strategy] = c;
    }
    return g;
  }, [cells]);

  if (isLoading) return <Skeleton rows={8} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded border border-border">
          {(["heatmap", "table"] as const).map((v) => (
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
              {v === "heatmap" ? "Heatmap" : "Table"}
            </button>
          ))}
        </div>
        <MinGamesPicker value={minGames} onChange={setMinGames} />
      </div>

      {cells.length === 0 ? (
        <Card>
          <EmptyState title="Not enough samples" />
        </Card>
      ) : view === "heatmap" ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-text-dim">Build \ Strategy</th>
                  {strategies.map((s) => (
                    <th
                      key={s}
                      className="px-1 py-1 text-text-dim"
                      style={{ writingMode: "vertical-rl" as any }}
                    >
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {builds.map((b) => (
                  <tr key={b}>
                    <th className="whitespace-nowrap px-2 py-1 text-left text-text-muted">
                      {b}
                    </th>
                    {strategies.map((s) => {
                      const c = grid[b]?.[s];
                      const bg = c
                        ? `${wrColor(c.winRate, c.total)}33`
                        : "transparent";
                      return (
                        <td
                          key={s}
                          className="px-1 py-1 text-center tabular-nums"
                          style={{ background: bg }}
                          title={
                            c
                              ? `${c.wins}-${c.losses} (${pct1(c.winRate)})`
                              : "—"
                          }
                        >
                          {c ? pct1(c.winRate) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <th className="px-3 py-2 text-left">Build</th>
                <th className="px-3 py-2 text-left">Strategy</th>
                <th className="px-3 py-2 text-right">W</th>
                <th className="px-3 py-2 text-right">L</th>
                <th className="px-3 py-2 text-right">Games</th>
                <th className="px-3 py-2 text-right">WR</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((c, i) => (
                <tr key={`${c.build}-${c.strategy}-${i}`} className="border-t border-border">
                  <td className="px-3 py-1.5">{c.build}</td>
                  <td className="px-3 py-1.5 text-text-muted">{c.strategy}</td>
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
      )}
    </div>
  );
}

export function StrategiesTab() {
  const [view, setView] = useState<"opp" | "bvs">(() =>
    readLs(LS_VIEW, "opp" as "opp" | "bvs"),
  );
  useEffect(() => writeLs(LS_VIEW, view), [view]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Strategies</h2>
        <div className="ml-auto inline-flex overflow-hidden rounded border border-border">
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
      {view === "opp" ? <ByOppStrategyView /> : <BuildVsStrategyView />}
    </div>
  );
}

// Re-export so other tabs can pull the bar (e.g. opponent profile).
export { WrBar };
