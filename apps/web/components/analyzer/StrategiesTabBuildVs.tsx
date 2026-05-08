"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";

/**
 * Build × Opponent-strategy matrix for ``StrategiesTab``.
 *
 * Pulled out so ``StrategiesTab.tsx`` stays under the 800-line cap.
 * The view, MinGames threshold, and view-mode preferences are
 * persisted to localStorage by the parent — this file owns only the
 * presentational matrix + table renderers.
 */

export type BvsCell = {
  my_build: string;
  opp_strat: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

export interface BuildVsStrategyViewProps {
  onOpenBvs: (build: string, strategy: string) => void;
  /** Initial view mode; persisted by the caller. */
  initialView: "heatmap" | "table";
  /** Initial min-games threshold; persisted by the caller. */
  initialMinGames: number;
  /** Notified whenever the view mode flips so the caller can persist. */
  onViewChange: (view: "heatmap" | "table") => void;
  /** Notified whenever the threshold changes so the caller can persist. */
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
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"heatmap" | "table">(initialView);
  const [minGames, setMinGames] = useState<number>(initialMinGames);
  const sort = useSort("total", "desc");
  useEffect(() => onViewChange(view), [view, onViewChange]);
  useEffect(() => onMinGamesChange(minGames), [minGames, onMinGamesChange]);

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
        {renderMinGamesPicker(minGames, setMinGames)}
        <div className="inline-flex overflow-hidden rounded border border-border">
          {(["table", "heatmap"] as const).map((v) => (
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
