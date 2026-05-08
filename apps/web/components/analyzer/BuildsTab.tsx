"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { BuildEditorModal } from "./BuildEditorModal";

type BuildRow = {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  myMatchups?: Record<string, number>;
};

const LS_MIN_BUILDS = "analyzer.builds.minGames";

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

/**
 * The full Builds analytics tab (separate from the personal-builds
 * editor). Shows aggregated WR per build, drilldown to game list, and
 * lets the user open a build's detail page.
 */
export function BuildsTab() {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [minGames, setMinGames] = useState<number>(() =>
    readLs(LS_MIN_BUILDS, 1),
  );
  useEffect(() => writeLs(LS_MIN_BUILDS, minGames), [minGames]);
  const [editing, setEditing] = useState<string | null>(null);
  const sort = useSort("total", "desc");

  const { data, isLoading } = useApi<BuildRow[]>(
    `/v1/builds${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    let r = data || [];
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((b) => b.name.toLowerCase().includes(s));
    if (minGames > 1) r = r.filter((b) => (b.total || 0) >= minGames);
    return sort.sortRows(r, (row, col) => (row as any)[col]);
  }, [data, search, minGames, sort]);

  const hiddenByMinGames = useMemo(() => {
    if (minGames <= 1) return 0;
    const all = data || [];
    const s = search.trim().toLowerCase();
    const matchedSearch = s
      ? all.filter((b) => b.name.toLowerCase().includes(s))
      : all;
    return matchedSearch.filter((b) => (b.total || 0) < minGames).length;
  }, [data, search, minGames]);

  if (isLoading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-full sm:w-72"
          placeholder="search build…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <span className="text-xs text-text-dim">
          click a row to inspect or edit a build
        </span>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="No builds match"
            sub={
              hiddenByMinGames > 0
                ? `${hiddenByMinGames} build${hiddenByMinGames === 1 ? "" : "s"} hidden by Min games ≥ ${minGames}. Drop the filter to 1 to see every build.`
                : undefined
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <SortableTh col="name" label="Build" {...sort} />
                <SortableTh col="wins" label="W" {...sort} align="right" />
                <SortableTh col="losses" label="L" {...sort} align="right" />
                <SortableTh col="total" label="Games" {...sort} align="right" />
                <SortableTh col="winRate" label="WR" {...sort} align="right" />
                <th className="w-32 px-3 py-2 text-left text-[11px] uppercase text-text-dim">
                  Trend
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.name}
                  className="cursor-pointer border-t border-border hover:bg-accent/10"
                  onClick={() => setEditing(b.name)}
                >
                  <td className="px-3 py-1.5 text-text">{b.name}</td>
                  <td className="px-3 py-1.5 text-right text-success">{b.wins}</td>
                  <td className="px-3 py-1.5 text-right text-danger">{b.losses}</td>
                  <td className="px-3 py-1.5 text-right">{b.total}</td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums"
                    style={{ color: wrColor(b.winRate, b.total) }}
                  >
                    {pct1(b.winRate)}
                  </td>
                  <td className="px-3 py-1.5">
                    <WrBar wins={b.wins} losses={b.losses} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <BuildEditorModal
          buildName={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
