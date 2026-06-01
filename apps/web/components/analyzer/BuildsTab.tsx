"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, WrBar } from "@/components/ui/Card";
import { usePersistentSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { WinRateSortToggle } from "@/components/ui/WinRateSortToggle";
import { BuildEditorModal } from "./BuildEditorModal";
import { BuildMmrPanel } from "./mmr/BuildMmrPanel";
import { BuildAgingCurve } from "./mmr/BuildAgingCurve";
import { MmrProgressionByBuild } from "./mmr/MmrProgressionByBuild";

type BuildRow = {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  myMatchups?: Record<string, number>;
};

const LS_MIN_BUILDS = "analyzer.builds.minGames";
const LS_BUILDS_SORT = "analyzer.builds.sort";

/**
 * The full Builds analytics tab (separate from the personal-builds
 * editor). Shows aggregated WR per build, drilldown to game list, and
 * lets the user open a build's detail page.
 */
export function BuildsTab() {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_BUILDS, 1);
  const [editing, setEditing] = useState<string | null>(null);
  const sort = usePersistentSort(LS_BUILDS_SORT, "total", "desc");

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
          className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none"
          placeholder="search build…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <WinRateSortToggle
          dir={sort.sortBy === "winRate" ? sort.sortDir : "desc"}
          active={sort.sortBy === "winRate"}
          onChange={(dir) => sort.setSortExplicit("winRate", dir)}
        />
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
          <>
            {/* Mobile (< md): stacked cards per row so the build name
                stays fully readable. The desktop table-fixed layout
                below keeps the four numeric columns from grabbing
                leftover space and pushing WR off-screen, but on a
                phone viewport even the build column itself collapses,
                so swap to a vertical card on small screens. */}
            <ul className="space-y-2 md:hidden">
              {rows.map((b) => (
                <li key={b.name}>
                  <button
                    type="button"
                    onClick={() => setEditing(b.name)}
                    className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-bg-surface px-3 py-2 text-left transition hover:bg-accent/10"
                  >
                    <div className="text-sm font-semibold text-text">
                      {b.name}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                      <span className="text-success">{b.wins}W</span>
                      <span className="text-danger">{b.losses}L</span>
                      <span className="text-text-muted">
                        {b.total} games
                      </span>
                      <span
                        className="font-semibold"
                        style={{ color: wrColor(b.winRate, b.total) }}
                      >
                        {pct1(b.winRate)}
                      </span>
                    </div>
                    <div className="w-full">
                      <WrBar wins={b.wins} losses={b.losses} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              {/* ``table-fixed`` + explicit colgroup widths so the four
                  numeric cols don't grab equal shares of leftover space
                  and push WR off the right edge — see StrategiesTabBuildVs
                  for the same treatment. */}
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "8rem" }} />
                </colgroup>
                <thead className="bg-bg-elevated">
                  <tr>
                    <SortableTh col="name" label="Build" {...sort} />
                    <SortableTh col="wins" label="W" {...sort} align="right" />
                    <SortableTh col="losses" label="L" {...sort} align="right" />
                    <SortableTh col="total" label="Games" {...sort} align="right" />
                    <SortableTh col="winRate" label="WR" {...sort} align="right" />
                    <th className="px-3 py-2 text-left text-micro uppercase text-text-dim">
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
                      <td className="truncate px-3 py-1.5 text-text" title={b.name}>
                        {b.name}
                      </td>
                      <td className="px-2 py-1.5 text-right text-success">{b.wins}</td>
                      <td className="px-2 py-1.5 text-right text-danger">{b.losses}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{b.total}</td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums"
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
            </div>
          </>
        )}
      </Card>

      <BuildMmrPanel />

      {/* ``[&>*]:min-w-0`` style applied per-child below — see each
          chart wrapper. Without it the long build labels in the chart
          legends push their column wider than the grid track and the
          row overflows the page horizontally. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <BuildAgingCurve />
        </div>
        <div className="min-w-0">
          <MmrProgressionByBuild />
        </div>
      </div>

      {editing && (
        <BuildEditorModal
          buildName={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
